/** @file Consultas autorizadas y mantenimiento de emisores y borradores con control de revisión. */
'use strict';
const { validateBillingDate }             = require('./billing-date.service');
const { ApplicationError }                = require('../../../shared/application-error');
const { billingAccess, issuerAssignment } = require('../policies/billing-access.policy');
const { present, editable }               = require('../presenters/billing.presenter');
/** @param {Object} options Puertos mínimos y reglas de aplicación. @returns {Object} Casos de uso sin infraestructura. */
function billingRecords({
  store,
  context,
  clock,
  identifier,
  rules,
  credentials,
  productLines,
  pacSettings,
  references,
  ledger,
}) {
  /** @param {string} resource Tipo de recurso. @param {Object} actor Actor vigente. @returns {Object} Metadatos iniciales de propiedad. */
  function metadata(resource, actor) {
    const now = clock();
    return {
      code         : identifier(resource),
      workspace    : actor.workspace,
      userCreate   : actor.user.userCode,
      userAssigned : actor.user.userCode,
      creationDate : now,
      updateDate   : now,
      revision     : 1,
      ...(actor.delegation ? { delegation: { ...actor.delegation } } : {}),
    };
  }
  /** @param {Object} tx Puerto transaccional. @param {Object} actor Actor vigente. @param {string} resource Tipo. @param {string} targetCode Recurso. @param {string} action Cambio. @param {string} reason Motivo opcional. @returns {Promise<void>} Evidencia atómica con la mutación. */
  async function audit(tx, actor, resource, targetCode, action, reason = '') {
    await tx.insert('audit', {
      ...metadata('audit', actor),
      resource,
      targetCode,
      action,
      reason,
    });
  }
  /** @param {string} resource Recurso. @param {string} code Identidad. @param {string} action Permiso. @param {Object} actor Contexto. @param {Object} source Puerto de lectura. @returns {Promise<Object>} Registro del ámbito autorizado. */
  async function get(resource, code, action = 'view', actor = context(), source = store) {
    const item = await source.get(resource, {
      ...billingAccess(actor, resource, action),
      code,
    });
    if (!item) throw new ApplicationError(404, 'BILLING_NOT_FOUND');
    return item;
  }
  /** @param {Object} reference Documento u operación leídos y autorizados por el caso de uso; nunca datos del cuerpo. @param {Object} actor Actor vigente. @param {Object} source Puerto de lectura. @returns {Promise<Object>} Emisor vinculado sin conceder administración ni requerir permisos adicionales sobre el recurso histórico. */
  async function historicalIssuer(reference, actor = context(), source = store) {
    if (!reference?.issuerCode || reference.workspace !== actor.workspace)
      throw new ApplicationError(404, 'BILLING_NOT_FOUND');
    billingAccess(actor, 'issuer', 'view');
    const issuer = await source.get('issuer', { code: reference.issuerCode });
    if (
      !issuer ||
      (actor.delegation && ![actor.workspace, 'allWorkspaces'].includes(issuer.workspace))
    )
      throw new ApplicationError(404, 'BILLING_NOT_FOUND');
    return issuer;
  }
  /** @param {Object} input Datos del documento. @param {Object|null} previous Documento previo. @param {Object} actor Contexto. @param {Object} source Puerto. @returns {Promise<Object>} Emisor disponible o vinculado a un borrador o nota de crédito autorizados. */
  async function documentIssuer(input, previous, actor, source = store) {
    let issuer;
    if (previous?.issuerCode === input.issuerCode)
      issuer = await historicalIssuer(
        await get('document', previous.code, 'update', actor, source),
        actor,
        source,
      );
    else if (input.type === 'E' && input.relatedDocumentCode)
      issuer = await historicalIssuer(
        await get('document', input.relatedDocumentCode, 'view', actor, source),
        actor,
        source,
      );
    else {
      issuer = await get('issuer', input.issuerCode, 'view', actor, source);
      if (![actor.workspace, 'allWorkspaces'].includes(issuer.workspace))
        throw new ApplicationError(404, 'BILLING_NOT_FOUND');
    }
    if (issuer.code !== input.issuerCode)
      throw new ApplicationError(409, 'BILLING_INVALID_CREDIT_TARGET');
    return issuer;
  }
  /** @param {Object} actor Identidad. @param {string} action Acción de emisor. @param {string} workspace Destino. @returns {Promise<void>} Valida alcance y membresía canónica sin confiar en campos de identidad del cuerpo. */
  async function assignment(actor, action, workspace) {
    issuerAssignment(actor, action, workspace);
    if (
      workspace !== 'allWorkspaces' &&
      !(await references.principal(workspace, actor.user.userCode))
    )
      throw new ApplicationError(403, 'BILLING_WORKSPACE_UNAVAILABLE');
  }
  /** @param {Object} current Registro actual. @param {number} revision Revisión esperada. @returns {void} Rechaza sobrescrituras concurrentes. */
  function match(current, revision) {
    if (current.revision !== revision) throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
  }
  /** @param {string} resource Tipo. @param {Object} data Solicitud. @param {Object} actor Actor. @returns {Promise<Object>} Valores calculados antes de abrir transacción. */
  async function prepare(resource, data, actor, previous = null, historical = null) {
    const input = editable(resource, data);
    if (resource !== 'document') return rules[resource](input);
    await productLines(input, historical || previous);
    const issuer = await documentIssuer(input, previous, actor),
      related    = input.relatedDocumentCode
        ? await get('document', input.relatedDocumentCode, 'view', actor)
        : null;
    const config = await pacSettings.resolve(
      previous?.issuerSnapshot.environment || related?.issuerSnapshot.environment || '',
    );
    return rules.document(
      input,
      {
        ...issuer,
        environment : config.environment,
      },
      related,
    );
  }
  return {
    /** @param {Object} data Borrador, revisión y motivo. @returns {Promise<Object>} Descarta sin borrar la evidencia ni cancelar comprobantes timbrados. */
    async discard(data) {
      const actor = context();
      if (!data.reason.trim()) throw new ApplicationError(400, 'BILLING_DISCARD_REASON_REQUIRED');
      const result = await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Estado y auditoría bajo la misma revisión. */
        async (tx) => {
          const previous = await get('document', data.code, 'delete', actor, tx);
          match(previous, data.revision);
          if (previous.status !== 'draft' || previous.uuid || previous.ledgerApplied)
            throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_DRAFT');
          const operation = await tx.get('operation', {
            workspace  : actor.workspace,
            targetCode : previous.code,
            status     : { $in: ['queued', 'running', 'uncertain'] },
          });
          if (operation) throw new ApplicationError(409, 'BILLING_OPERATION_PENDING');
          const updated = {
            ...previous,
            status     : 'discarded',
            revision   : previous.revision + 1,
            updateDate : clock(),
          };
          await tx.replace('document', previous, updated);
          await ledger.release(tx, previous);
          if (previous.receiptCode) {
            const receipt = await tx.get('receipt', {
              workspace : actor.workspace,
              code      : previous.receiptCode,
            });
            if (receipt?.repDocumentCode === previous.code) {
              await tx.replace('receipt', receipt, {
                ...receipt,
                repDocumentCode : previous.relatedDocumentCode || '',
                revision        : receipt.revision + 1,
                updateDate      : clock(),
              });
            }
          }
          await audit(tx, actor, 'document', previous.code, 'discarded', data.reason);
          return updated;
        },
      );
      return present('document', result);
    },
    /** @param {Object} data Borrador, revisión y nueva fecha de expedición. @returns {Promise<Object>} Actualiza sólo la fecha, incluso en un REP preparado. */
    async redate(data) {
      validateBillingDate(data.date);
      const actor = context(),
        previous  = await get('document', data.code, 'update', actor);
      match(previous, data.revision);
      if (previous.status !== 'draft')
        throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_DRAFT');
      const updated = {
        ...previous,
        date       : data.date,
        revision   : previous.revision + 1,
        updateDate : clock(),
      };
      await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Revisión y bitácora atómicas. */
        async (tx) => {
          await tx.replace('document', previous, updated);
          await audit(tx, actor, 'document', previous.code, 'date-updated');
        },
      );
      return present('document', updated);
    },
    get,
    historicalIssuer,
    match,
    metadata,
    audit,
    /** @param {string} resource Tipo. @param {Object} data Identidad exacta. @returns {Promise<Object>} Proyección pública. */
    async getOne(resource, data) {
      return present(resource, await get(resource, data.code));
    },
    /** @param {string} resource Tipo. @param {Object} data Filtros cerrados y página. @returns {Promise<Object>} Página estable dentro del ámbito. */
    async getList(resource, data) {
      const actor = context(),
        filter    = billingAccess(actor, resource, 'view');
      if (resource === 'issuer' && actor.workspace && actor.workspace !== 'allWorkspaces')
        filter.workspace = { $in: [actor.workspace, 'allWorkspaces'] };
      for (const key of [
        'issuerCode',
        'customerCode',
        'supplierCode',
        'categoryCode',
        'costCenterCode',
        'projectCode',
        'status',
        'type',
      ])
        if (data[key]) filter[key] = data[key];
      if (data.from !== undefined || data.to !== undefined)
        filter.creationDate = {
          ...(data.from !== undefined ? { $gte: data.from } : {}),
          ...(data.to !== undefined ? { $lte: data.to } : {}),
        };
      if (data.saleCode) filter[resource === 'document' ? 'saleCodes' : 'saleCode'] = data.saleCode;
      if (data.currency) filter.currency = data.currency;
      if (data.active !== undefined) filter.active = data.active;
      if (data.expenseCode) filter['allocations.expenseCode'] = data.expenseCode;
      if (data.dueDateFrom || data.dueDateTo)
        filter.dueDate = {
          ...(data.dueDateFrom ? { $gte: data.dueDateFrom } : { $gt: '' }),
          ...(data.dueDateTo ? { $lte: data.dueDateTo } : {}),
        };
      if (data.outstandingOnly && resource === 'expense') filter.status = 'confirmed';
      if (data.outstandingOnly && ['sale', 'document', 'expense'].includes(resource))
        filter.balance = { $regex: '[1-9]' };
      if (data.commercialOnly && resource === 'document') filter.commercialSource = { $ne: true };
      for (const key of ['invoiceRequested', 'fiscalStatus', 'paymentStatus'])
        if (data[key] !== undefined) filter[key] = data[key];
      if (data.dateFrom || data.dateTo)
        filter.date = {
          ...(data.dateFrom ? { $gte: data.dateFrom } : {}),
          ...(data.dateTo ? { $lte: data.dateTo } : {}),
        };
      if (data.search) {
        const escaped = data.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$and = [
          {
            $or : [
              'code',
              'name',
              'uuid',
              'folio',
              'taxId',
              'reference',
              'customerSnapshot.name',
              'supplierSnapshot.name',
              'description',
              'customerSnapshot.fiscal.legalName',
              'customerSnapshot.fiscal.taxId',
            ].map(
              /** @param {string} field Campo público indexable. @returns {Object} Condición literal, sin expresión aportada por el usuario. */
              (field) => ({
                [field] : {
                  $regex   : escaped,
                  $options : 'i',
                },
              }),
            ),
          },
        ];
      }
      return store.transaction(
        /** @param {Object} tx Transacción snapshot. @returns {Promise<Object>} Filas, total e importes del mismo corte autorizado. */
        async (tx) => {
          const page = await tx.list(resource, filter, data);
          return {
            ...page,
            ...(['expense', 'expense-payment'].includes(resource)
              ? { totals: await tx.expenseTotals(resource, filter) }
              : {}),
            items : page.items.map(
              /** @param {Object} value Registro. @returns {Object} Proyección pública. */
              (value) => present(resource, value),
            ),
          };
        },
      );
    },
    /** @param {string} resource Recurso editable. @param {Object} data Entrada. @param {Object[]|null} sources Ventas acreditadas por el caso de uso comercial. @returns {Promise<Object>} Alta y auditoría atómicas. */
    async create(resource, data, sources = null) {
      const actor = context();
      billingAccess(actor, resource, 'create');
      if (resource === 'issuer') await assignment(actor, 'create', data.workspace);
      const prepared = await prepare(
          resource,
          data,
          actor,
          null,
          sources
            ? {
                currency : data.currency,
                lines    : sources.flatMap(
                  /** @param {Object} sale Venta acreditada. @returns {Object[]} Partidas históricas. */ (
                    sale,
                  ) => sale.lines,
                ),
              }
            : null,
        ),
        item         = {
          ...prepared,
          ...metadata(resource, actor),
          ...(resource === 'issuer'
            ? {
                csdConfigured : false,
                workspace     : prepared.workspace,
              }
            : {}),
        };
      await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Alta durable. */
        async (tx) => {
          if (resource === 'document') {
            await tx.guardIssuer(await documentIssuer(data, null, actor, tx));
            if (!sources && data.globalInfo)
              for (const code of data.globalInfo.operationCodes) {
                if (
                  await tx.get('sale', {
                    workspace : actor.workspace,
                    code,
                  })
                )
                  throw new ApplicationError(409, 'BILLING_USE_SALES_GLOBAL');
              }
          }
          await tx.insert(resource, item);
          await audit(tx, actor, resource, item.code, 'created');
        },
      );
      return present(resource, item);
    },
    /** @param {string} resource Recurso editable. @param {Object} data Entrada con revisión. @returns {Promise<Object>} Modificación autorizada y auditada. */
    async update(resource, data) {
      const actor = context(),
        previous  = await get(resource, data.code, 'update', actor);
      match(previous, data.revision);
      if (resource === 'document' && previous.saleCodes?.length)
        throw new ApplicationError(409, 'BILLING_SALE_DOCUMENT_IMMUTABLE');
      if (resource === 'document' && previous.status !== 'draft')
        throw new ApplicationError(409, 'BILLING_DOCUMENT_IMMUTABLE');
      if (resource === 'issuer' && data.taxId !== previous.taxId)
        throw new ApplicationError(409, 'BILLING_ISSUER_IDENTITY_IMMUTABLE');
      if (resource === 'issuer') await assignment(actor, 'update', data.workspace);
      const prepared = await prepare(resource, data, actor, previous),
        next         = {
          ...previous,
          ...prepared,
          revision   : previous.revision + 1,
          updateDate : clock(),
        };
      if (resource === 'document')
        for (const key of ['globalInfo', 'relatedDocumentCode', 'relatedUuid', 'relationship'])
          if (prepared[key] === undefined) delete next[key];
      await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Cambio condicional. */
        async (tx) => {
          if (resource === 'document')
            await tx.guardIssuer(await documentIssuer(data, previous, actor, tx));
          if (
            resource === 'issuer' &&
            previous.workspace !== next.workspace &&
            previous.csdConfigured
          )
            next.csdEnvelope = credentials.rebindCsd(previous, next);
          await tx.replace(resource, previous, next);
          await audit(
            tx,
            actor,
            resource,
            next.code,
            resource === 'issuer' && previous.workspace !== next.workspace
              ? 'workspace-changed'
              : 'updated',
            resource === 'issuer' && previous.workspace !== next.workspace
              ? JSON.stringify({
                  previousWorkspace : previous.workspace,
                  workspace         : next.workspace,
                })
              : '',
          );
        },
      );
      return present(resource, next);
    },
    /** @param {Object} data Emisor, revisión y sobre sellado antes del transporte. @returns {Promise<Object>} Emisor con metadatos públicos del certificado. */
    async setCsd(data) {
      const actor = context(),
        previous  = await get('issuer', data.code, 'update', actor);
      match(previous, data.revision);
      const sealed = credentials.prepareCsd(data.envelope, previous, clock()),
        next       = {
          ...previous,
          ...sealed,
          csdConfigured : true,
          revision      : previous.revision + 1,
          updateDate    : clock(),
        };
      await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Actualización sin exponer secretos. */
        async (tx) => {
          await tx.replace('issuer', previous, next);
          await audit(tx, actor, 'issuer', next.code, 'csd-updated');
        },
      );
      return present('issuer', next);
    },
    /** @param {Object} data Borrador y revisión. @returns {Promise<Object>} Instantánea renovada exclusivamente mediante acción explícita. */
    async refreshCustomer(data) {
      const previous = await get('document', data.code, 'update');
      match(previous, data.revision);
      if (previous.saleCodes?.length) {
        if (previous.status !== 'draft')
          throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_DRAFT');
        const actor    = context();
        const prepared = await prepare('document', editable('document', previous), actor, previous);
        const updated  = {
          ...previous,
          customerSnapshot : prepared.customerSnapshot,
          revision         : previous.revision + 1,
          updateDate       : clock(),
        };
        await store.transaction(
          /** @param {Object} tx Transacción. @returns {Promise<void>} Actualiza sólo identidad fiscal sin alterar condiciones comerciales. */ async (
            tx,
          ) => {
            await tx.replace('document', previous, updated);
            await audit(tx, actor, 'document', previous.code, 'customer-refreshed');
          },
        );
        return present('document', updated);
      }
      return this.update('document', {
        ...editable('document', previous),
        code     : data.code,
        revision : data.revision,
      });
    },
  };
}
module.exports = { billingRecords };
