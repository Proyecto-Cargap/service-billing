/** @file Encola intenciones fiscales con idempotencia, autorización y reservas transaccionales antes del efecto PAC. */
'use strict';
const { ApplicationError }             = require('../../../shared/application-error');
const { billingAccess, billingPermit } = require('../policies/billing-access.policy');
const { present }                      = require('../presenters/billing.presenter');
const { amount }                       = require('./amounts.service');
/** @param {Object} options Puertos de aplicación e identidad. @returns {Object} Comandos durables sin llamadas PAC dentro de transacciones. */
function billingCommands({
  store,
  records,
  rules,
  references,
  context,
  clock,
  hash,
  pacSettings,
  ledger,
}) {
  const permissions = {
    issue     : 'issuance',
    cancel    : 'cancellation',
    reconcile : 'operation',
    deliver   : 'delivery',
    authorize : 'cancellation',
  };
  /** @param {string} kind Intención. @param {Object} data Entrada. @returns {Promise<Object>} Operación existente o encolada una sola vez. */
  async function enqueue(kind, data) {
    const actor = context();
    if (
      actor.delegation &&
      !actor.scopes?.includes(
        {
          issue     : 'billing:issue',
          cancel    : 'billing:cancel',
          authorize : 'billing:cancel',
          reconcile : 'billing:reconcile',
          deliver   : 'billing:send',
        }[kind],
      )
    )
      throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
    billingAccess(actor, permissions[kind], kind === 'reconcile' ? 'update' : 'create');
    if (!data.idempotencyKey.trim())
      throw new ApplicationError(400, 'BILLING_IDEMPOTENCY_KEY_REQUIRED');
    const resource = kind === 'authorize' ? 'issuer' : 'document',
      target       = await records.get(resource, data.code, 'view', actor),
      digest       = hash({
        kind,
        data,
      });
    billingPermit(
      actor,
      permissions[kind],
      kind === 'reconcile' ? 'update' : 'create',
      target,
      resource === 'issuer',
    );
    const existing = await store.get('operation', {
      workspace      : actor.workspace,
      idempotencyKey : data.idempotencyKey,
    });
    if (existing) {
      if (existing.digest !== digest || existing.userCreate !== actor.user.userCode)
        throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
      return present('operation', existing);
    }
    const issuer = resource === 'issuer' ? target : await records.historicalIssuer(target, actor);
    if (!issuer.csdConfigured || !issuer.active || issuer.certificate.validUntil <= clock())
      throw new ApplicationError(409, 'BILLING_ISSUER_NOT_READY');
    if (kind === 'issue') {
      if (target.status !== 'draft') throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_DRAFT');
      if (!target.globalInfo && target.type !== 'P') {
        const snapshot = rules.snapshot(await references.customer(target.customerCode));
        if (hash(snapshot.fiscal) !== hash(target.customerSnapshot.fiscal))
          throw new ApplicationError(409, 'BILLING_CUSTOMER_SNAPSHOT_CHANGED');
      }
      if (target.type === 'P')
        await references.profile({
          taxId     : target.customerSnapshot.fiscal.taxId,
          taxRegime : target.customerSnapshot.fiscal.taxRegime,
          cfdiUse   : 'CP01',
        });
      for (const key of ['taxId', 'legalName', 'taxRegime', 'postalCode'])
        if (issuer[key] !== target.issuerSnapshot[key])
          throw new ApplicationError(409, 'BILLING_ISSUER_SNAPSHOT_CHANGED');
    }
    const config    =
      kind === 'deliver'
        ? null
        : await pacSettings.resolve(target.issuerSnapshot?.environment || '');
    const operation = {
      ...records.metadata('operation', actor),
      kind,
      targetCode     : data.code,
      issuerCode     : issuer.code,
      ...(config ? { pacRevision: config.code } : {}),
      status         : 'queued',
      error          : '',
      idempotencyKey : data.idempotencyKey,
      digest,
      input          : structuredClone(data),
      availableAt    : clock(),
    };
    await store.transaction(
      /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Reserva de intención, folio y saldo en una sola confirmación. */
      async (tx) => {
        const current = await records.get(resource, data.code, 'view', actor, tx);
        if (data.revision !== undefined) records.match(current, data.revision);
        if (kind === 'issue') {
          await ledger.assertReserved(tx, current);
          if (current.status !== 'draft')
            throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_DRAFT');
          if (current.type === 'E') {
            const related = await records.get(
                'document',
                current.relatedDocumentCode,
                'view',
                actor,
                tx,
              ),
              reserved    = amount(related.creditReserved || '0');
            if (
              related.status !== 'issued' ||
              reserved.gt(0) ||
              amount(current.total).gt(amount(related.balance).minus(reserved))
            )
              throw new ApplicationError(409, 'BILLING_CREDIT_EXCEEDS_BALANCE');
            for (const tax of current.taxes) {
              const available = (related.remainingTaxes || related.taxes).find(
                /** @param {Object} value Grupo fiscal restante. @returns {boolean} Misma naturaleza del impuesto. */
                (value) =>
                  value.kind === tax.kind &&
                  value.code === tax.code &&
                  value.factor === tax.factor &&
                  (value.factor === 'Exento' || amount(value.rate).eq(tax.rate)),
              );
              if (
                !available ||
                amount(available.base).lt(tax.base) ||
                amount(available.amount).lt(tax.amount)
              )
                throw new ApplicationError(409, 'BILLING_CREDIT_TAX_MISMATCH');
            }
            await tx.replace('document', related, {
              ...related,
              creditReserved : reserved.plus(current.total).toFixed(related.currencyDecimals),
              revision       : related.revision + 1,
              updateDate     : clock(),
            });
          }
          if (current.type === 'E') {
            const related = await tx.get('document', {
              workspace : actor.workspace,
              code      : current.relatedDocumentCode,
            });
            await ledger.credit(tx, related);
          }
          if (current.type === 'P') {
            const receipt = await tx.get('receipt', {
              workspace : actor.workspace,
              code      : current.receiptCode,
            });
            if (
              !receipt ||
              receipt.status !== 'confirmed' ||
              receipt.repDocumentCode !== current.code
            )
              throw new ApplicationError(409, 'BILLING_RECEIPT_CHANGED');
          }
          if (current.globalInfo)
            for (const businessCode of current.globalInfo.operationCodes)
              await tx.insert('global-operation', {
                ...records.metadata('global-operation', actor),
                businessCode,
                issuerCode   : current.issuerCode,
                environment  : target.issuerSnapshot.environment,
                documentCode : current.code,
                active       : true,
              });
          await tx.replace('document', current, {
            ...current,
            series          : issuer.series[current.type],
            folio           : await tx.folio(
              {
                ...issuer,
                environment : current.issuerSnapshot.environment,
              },
              current.type,
            ),
            status          : 'queued',
            activeOperation : operation.code,
            revision        : current.revision + 1,
            updateDate      : clock(),
          });
        } else if (kind === 'cancel') {
          if (!['issued', 'cancel-requested'].includes(current.status))
            throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_ISSUED');
          if (current.activeOperation)
            throw new ApplicationError(409, 'BILLING_OPERATION_IN_PROGRESS');
          await ledger.cancellable(tx, current);
          if (
            current.type === 'I' &&
            ((!current.saleCodes?.length && amount(current.paid).gt(0)) ||
              amount(current.credited).gt(0) ||
              amount(current.creditReserved || '0').gt(0))
          )
            throw new ApplicationError(409, 'BILLING_REVERSE_DEPENDENCIES_FIRST');
          if (data.reason === '01') {
            const replacement = await records.get(
              'document',
              data.replacementCode,
              'view',
              actor,
              tx,
            );
            if (
              replacement.status !== 'issued' ||
              replacement.code === current.code ||
              replacement.type !== current.type ||
              replacement.issuerCode !== current.issuerCode ||
              replacement.customerCode !== current.customerCode ||
              replacement.relatedUuid !== current.uuid ||
              replacement.relationship !== '04'
            )
              throw new ApplicationError(409, 'BILLING_INVALID_REPLACEMENT');
            operation.replacementUuid = replacement.uuid;
          } else if (data.replacementCode)
            throw new ApplicationError(400, 'BILLING_REPLACEMENT_NOT_APPLICABLE');
          if (data.reason === '04' && !current.globalInfo)
            throw new ApplicationError(400, 'BILLING_GLOBAL_CANCELLATION_REQUIRED');
          await tx.replace('document', current, {
            ...current,
            activeOperation   : operation.code,
            cancelRequestedBy : actor.user.userCode,
            cancelDelegation  : actor.delegation ? { ...actor.delegation } : null,
            revision          : current.revision + 1,
            updateDate        : clock(),
          });
        } else if (kind === 'reconcile') {
          if (!['issued', 'uncertain', 'cancel-requested', 'cancelled'].includes(current.status))
            throw new ApplicationError(409, 'BILLING_DOCUMENT_NOT_RECOVERABLE');
          if (current.activeOperation) {
            const running = await tx.get('operation', {
              workspace : actor.workspace,
              code      : current.activeOperation,
            });
            if (running && ['queued', 'running'].includes(running.status))
              throw new ApplicationError(409, 'BILLING_OPERATION_IN_PROGRESS');
          }
          if (!current.uuid && !data.uuid)
            throw new ApplicationError(400, 'BILLING_RECOVERY_UUID_REQUIRED');
          if (current.uuid && data.uuid && current.uuid.toUpperCase() !== data.uuid.toUpperCase())
            throw new ApplicationError(409, 'BILLING_UUID_CONFLICT');
          await tx.replace('document', current, {
            ...current,
            activeOperation : operation.code,
            revision        : current.revision + 1,
            updateDate      : clock(),
          });
        } else if (
          kind === 'deliver' &&
          (!current.uuid || current.status === 'cancelled' || !current.files.xml)
        )
          throw new ApplicationError(409, 'BILLING_FILES_NOT_READY');
        if (kind === 'deliver') {
          if (current.deliveryOperation) {
            const previous = await tx.get('operation', {
              code      : current.deliveryOperation,
              workspace : actor.workspace,
            });
            if (previous && ['queued', 'running', 'uncertain'].includes(previous.status))
              throw new ApplicationError(409, 'BILLING_DELIVERY_REQUIRES_RECONCILIATION');
          }
          await tx.replace('document', current, {
            ...current,
            deliveryOperation : operation.code,
            revision          : current.revision + 1,
            updateDate        : clock(),
          });
        }
        await tx.insert('operation', operation);
        await records.audit(tx, actor, resource, current.code, kind + '-requested');
      },
    );
    return present('operation', operation);
  }
  return { enqueue };
}
module.exports = { billingCommands };
