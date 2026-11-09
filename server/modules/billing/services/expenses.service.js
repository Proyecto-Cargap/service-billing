/** @file Gastos y catálogos globales: referencias históricas, estados e idempotencia transaccional. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { billingAccess }       = require('../policies/billing-access.policy');
const { present, editable }   = require('../presenters/billing.presenter');
const { amount, calculate }   = require('./amounts.service');
const { validateBillingDate } = require('./billing-date.service');
/** @param {Object} dependencies Puertos de persistencia, referencias y contexto. @returns {Object} Operaciones de gastos sin efectos fiscales. */
function expensesService({ store, records, references, context, clock, hash }) {
  /** @param {Object} previous Registro previo. @param {Object} changes Cambios acreditados. @returns {Object} Revisión siguiente. */
  function next(previous, changes) {
    return {
      ...previous,
      ...changes,
      revision   : previous.revision + 1,
      updateDate : clock(),
    };
  }
  /** @param {string} resource Recurso. @param {string} action Acción. @param {Object} data Solicitud. @param {Function} work Persistencia repetible. @returns {Promise<Object>} Resultado durable autorizado actualmente. */
  async function once(resource, action, data, work) {
    const actor = context();
    billingAccess(
      actor,
      resource,
      action === 'create'
        ? 'create'
        : action === 'cancel' || action === 'discard' || action === 'reverse'
          ? 'delete'
          : 'update',
    );
    if (!data.idempotencyKey?.trim())
      throw new ApplicationError(400, 'BILLING_IDEMPOTENCY_KEY_REQUIRED');
    const key         = hash([
      actor.workspace,
      actor.user.userCode,
      actor.delegation || null,
      resource,
      action,
      data.idempotencyKey,
    ]);
    const fingerprint = hash(data);
    try {
      return await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Resultado y recibo atómicos. */
        async (tx) => {
          const previous = await tx.receiptRead(key);
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
            await records.get(resource, previous.response.code, 'view', actor, tx);
            return previous.response;
          }
          const response = present(resource, await work(tx, actor));
          await tx.receiptInsert({
            _id       : key,
            fingerprint,
            resource,
            response,
            createdAt : clock(),
          });
          return response;
        },
      );
    } catch (error) {
      const receipt = await store.receiptRead(key);
      if (!receipt) throw error;
      if (receipt.fingerprint !== fingerprint)
        throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
      await records.get(resource, receipt.response.code, 'view', actor);
      return receipt.response;
    }
  }
  /** @param {Object} data Clasificación propuesta. @param {Object|null} previous Histórico. @returns {Promise<Object>} Instantáneas acreditadas sin modificar maestros. */
  async function classification(data, previous = null) {
    const result = {};
    for (const [field, resource, snapshot] of [
      ['categoryCode', 'expense-category', 'categorySnapshot'],
      ['costCenterCode', 'cost-center', 'costCenterSnapshot'],
    ]) {
      if (previous && previous[field] === data[field]) {
        result[snapshot] = previous[snapshot];
        continue;
      }
      const value = await records.get(resource, data[field]);
      if (!value.active) throw new ApplicationError(409, 'BILLING_CLASSIFICATION_INACTIVE');
      result[snapshot] = {
        code     : value.code,
        name     : value.name,
        revision : value.revision,
      };
    }
    if (data.projectCode && data.projectCode !== previous?.projectCode) {
      const project = await references.project(data.projectCode);
      if (project.state === 'archived')
        throw new ApplicationError(409, 'BILLING_PROJECT_UNAVAILABLE');
      result.projectSnapshot = {
        code     : data.projectCode,
        name     : project.name,
        revision : project.revision,
      };
    } else if (data.projectCode && previous?.projectSnapshot)
      result.projectSnapshot = previous.projectSnapshot;
    return result;
  }
  /** @param {Object} input Captura editable. @param {Object|null} previous Histórico. @returns {Promise<Object>} Gasto calculado con referencias visibles. */
  async function prepare(input, previous = null) {
    const data = editable('expense', input);
    validateBillingDate(data.date);
    if (data.dueDate) validateBillingDate(data.dueDate + 'T00:00:00');
    const issuer = await records.get('issuer', data.issuerCode);
    if (!issuer.active || ![context().workspace, 'allWorkspaces'].includes(issuer.workspace))
      throw new ApplicationError(409, 'BILLING_ISSUER_INACTIVE');
    const supplier = await references.supplier(data.supplierCode);
    if (supplier.state !== 'supplier') throw new ApplicationError(409, 'BILLING_SUPPLIER_REQUIRED');
    const currency = (
      await references.catalog({
        kind : 'currency',
        code : data.currency,
      })
    ).items[0];
    if (
      !currency ||
      data.currency === 'XXX' ||
      (data.currency === 'MXN' && !amount(data.exchangeRate).eq(1))
    )
      throw new ApplicationError(400, 'BILLING_INVALID_CURRENCY');
    amount(data.exchangeRate, true);
    const lines  = data.lines.map(
      /** @param {Object} line Concepto manual. @returns {Object} Objeto fiscal interno calculado sin exigir claves SAT. */
      (line) => ({
        ...line,
        taxObject : line.taxObject || (line.taxes.length ? '02' : '01'),
      }),
    );
    const totals = calculate(lines, currency.decimals);
    amount(totals.total, true);
    return {
      ...data,
      ...totals,
      ...(await classification(data, previous)),
      currencyDecimals : currency.decimals,
      issuerSnapshot   : {
        name      : issuer.name,
        legalName : issuer.legalName,
        taxId     : issuer.taxId,
      },
      supplierSnapshot : {
        code     : supplier.supplierCode,
        name     :
          supplier.tradeName ||
          supplier.fiscal?.legalName ||
          supplier.personProfile?.displayName ||
          supplier.supplierCode,
        taxId    : supplier.fiscal?.taxId || '',
        revision : supplier.revision,
      },
    };
  }
  /** @param {Object} tx Transacción. @param {Object} data Gasto preparado. @returns {Promise<void>} Cerca empresa y catálogos al confirmar referencias. */
  async function guard(tx, data) {
    const issuer = await records.get('issuer', data.issuerCode);
    if (!issuer.active || ![context().workspace, 'allWorkspaces'].includes(issuer.workspace))
      throw new ApplicationError(409, 'BILLING_ISSUER_INACTIVE');
    await tx.guardIssuer(issuer);
    for (const [resource, field] of [
      ['expense-category', 'categoryCode'],
      ['cost-center', 'costCenterCode'],
    ]) {
      const value = await records.get(resource, data[field], 'view', context(), tx);
      if (!value.active) throw new ApplicationError(409, 'BILLING_CLASSIFICATION_INACTIVE');
      await tx.guardExpenseReference(resource, value);
    }
  }
  return {
    next,
    once,
    classification,
    /** @param {Object} data Captura. @param {Object} source Valores originales acreditados internamente por XML. @returns {Promise<Object>} Borrador sin saldo exigible. */
    async create(data, source) {
      billingAccess(context(), 'expense', 'create');
      return once(
        'expense',
        'create',
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Alta auditada. */
        async (tx, actor) => {
          const prepared = await prepare(data);
          await guard(tx, prepared);
          const value = {
            ...prepared,
            ...(source
              ? Object.fromEntries(
                  Object.entries(source).filter(
                    /** @param {Array} entry Campo fiscal original. @returns {boolean} El UUID se adopta junto con su archivo. */ ([
                      key,
                    ]) => key !== 'uuid',
                  ),
                )
              : {}),
            ...records.metadata('expense', actor),
            status        : 'draft',
            paymentStatus : 'pending',
            paid          : '0',
            balance       : '0',
            uuid          : '',
            files         : [],
          };
          await tx.insert('expense', value);
          await records.audit(tx, actor, 'expense', value.code, 'created');
          return value;
        },
      );
    },
    /** @param {Object} data Cambios con revisión. @returns {Promise<Object>} Edición autorizada sin alterar importes confirmados. */
    async update(data) {
      return once(
        'expense',
        'update',
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Nueva revisión auditada. */
        async (tx, actor) => {
          const previous = await records.get('expense', data.code, 'update', actor, tx);
          records.match(previous, data.revision);
          const input = editable('expense', {
            ...previous,
            ...data,
          });
          if (!['draft', 'confirmed'].includes(previous.status))
            throw new ApplicationError(409, 'BILLING_EXPENSE_NOT_EDITABLE');
          const fixed = [
            'issuerCode',
            'supplierCode',
            'currency',
            'exchangeRate',
            'date',
            'lines',
            'description',
          ];
          if (previous.status === 'confirmed' || previous.uuid) {
            for (const key of fixed)
              if (
                data[key] !== undefined &&
                hash(data[key]) !== hash(editable('expense', previous)[key])
              )
                throw new ApplicationError(409, 'BILLING_EXPENSE_AMOUNTS_LOCKED');
          }
          const changes =
            previous.status === 'draft' && !previous.uuid
              ? await prepare(input, previous)
              : {
                  dueDate        : input.dueDate || '',
                  notes          : input.notes || '',
                  categoryCode   : input.categoryCode,
                  costCenterCode : input.costCenterCode,
                  projectCode    : input.projectCode || '',
                  ...(await classification(input, previous)),
                };
          if (changes.dueDate) validateBillingDate(changes.dueDate + 'T00:00:00');
          if (previous.status === 'draft' && !previous.uuid)
            await tx.guardIssuer(await records.get('issuer', changes.issuerCode));
          const current = previous;
          for (const [resource, field] of [
            ['expense-category', 'categoryCode'],
            ['cost-center', 'costCenterCode'],
          ]) {
            if (changes[field] !== current[field])
              await tx.guardExpenseReference(
                resource,
                await records.get(resource, changes[field], 'view', actor, tx),
              );
          }
          const value = next(current, changes);
          if (!value.projectCode) delete value.projectSnapshot;
          await tx.replace('expense', current, value);
          await records.audit(tx, actor, 'expense', value.code, 'updated');
          return value;
        },
      );
    },
    /** @param {string} action Confirmación, cancelación o descarte. @param {Object} data Identidad y motivo. @returns {Promise<Object>} Estado y saldo consistentes. */
    async transition(action, data) {
      return once(
        'expense',
        action,
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Transición auditada sin borrar registros. */
        async (tx, actor) => {
          const value = await records.get(
            'expense',
            data.code,
            action === 'confirm' ? 'update' : 'delete',
            actor,
            tx,
          );
          records.match(value, data.revision);
          if (value.status !== (action === 'cancel' ? 'confirmed' : 'draft'))
            throw new ApplicationError(409, 'BILLING_EXPENSE_INVALID_STATE');
          if (action !== 'confirm' && !data.reason?.trim())
            throw new ApplicationError(400, 'BILLING_REASON_REQUIRED');
          if (action === 'confirm') await guard(tx, value);
          if (action === 'cancel' && amount(value.paid).gt(0))
            throw new ApplicationError(409, 'BILLING_REVERSE_DEPENDENCIES_FIRST');
          const updated = next(value, {
            status  : {
              confirm : 'confirmed',
              cancel  : 'cancelled',
              discard : 'discarded',
            }[action],
            balance : action === 'confirm' ? value.total : '0',
            ...(action !== 'confirm'
              ? {
                  cancellationReason : data.reason,
                  uuidActive         : false,
                }
              : {}),
          });
          await tx.replace('expense', value, updated);
          await records.audit(tx, actor, 'expense', value.code, action, data.reason || '');
          return updated;
        },
      );
    },
    /** @param {string} resource Catálogo global. @param {Object} data Valores y revisión opcional. @returns {Promise<Object>} Alta o modificación conservando referencias históricas. */
    async catalogSave(resource, data) {
      const action = data.code ? 'update' : 'create';
      if (!data.name.trim()) throw new ApplicationError(400, 'BILLING_NAME_REQUIRED');
      return once(
        resource,
        action,
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Administrador global. @returns {Promise<Object>} Catálogo público. */
        async (tx, actor) => {
          const changes  = {
            name        : data.name.trim(),
            description : data.description || '',
            active      : data.active,
          };
          const previous = data.code
            ? await records.get(resource, data.code, 'update', actor, tx)
            : null;
          if (previous) records.match(previous, data.revision);
          const value = previous
            ? next(previous, changes)
            : {
                ...records.metadata(resource, actor),
                ...changes,
                workspace : 'allWorkspaces',
              };
          if (previous) await tx.replace(resource, previous, value);
          else await tx.insert(resource, value);
          await records.audit(tx, actor, resource, value.code, action);
          return value;
        },
      );
    },
  };
}
module.exports = { expensesService };
