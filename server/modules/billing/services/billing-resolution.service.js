/** @file Resolución manual de efectos inciertos con evidencia externa y liberación contable transaccional. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { billingAccess }    = require('../policies/billing-access.policy');
const { present }          = require('../presenters/billing.presenter');
const { amount }           = require('./amounts.service');
/** @param {Object} options Persistencia, identidad y reloj. @returns {Object} Resolución auditada sin ejecutar efectos del proveedor. */
function billingResolution({ store, records, context, clock }) {
  /** @param {Object} current Registro. @param {Object} changes Cambios confirmados. @returns {Object} Revisión siguiente. */
  function next(current, changes) {
    return {
      ...current,
      ...changes,
      revision   : current.revision + 1,
      updateDate : clock(),
    };
  }
  return {
    /** @param {Object} data Operación incierta y evidencia verificable del PAC o proveedor de correo. @returns {Promise<Object>} Resolución explícita, nunca un reintento automático. */
    async resolve(data) {
      const actor = context();
      billingAccess(actor, 'operation', 'update');
      if (data.evidence.trim().length < 10)
        throw new ApplicationError(400, 'BILLING_RESOLUTION_EVIDENCE_REQUIRED');
      const result = await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Libera reservas sólo cuando se acredita la ausencia del efecto. */
        async (tx) => {
          const operation = await records.get('operation', data.code, 'update', actor, tx);
          records.match(operation, data.revision);
          if (operation.status !== 'uncertain')
            throw new ApplicationError(409, 'BILLING_OPERATION_NOT_UNCERTAIN');
          if (operation.kind === 'authorize') {
            if (data.outcome !== 'authorization-confirmed')
              throw new ApplicationError(400, 'BILLING_INVALID_RESOLUTION');
            await records.historicalIssuer(operation, actor, tx);
          } else {
            const document = await records.get('document', operation.targetCode, 'view', actor, tx);
            if (operation.kind === 'issue' && data.outcome === 'not-issued') {
              if (
                document.ledgerApplied ||
                document.uuid ||
                document.status !== 'uncertain' ||
                document.activeOperation !== operation.code
              )
                throw new ApplicationError(409, 'BILLING_FISCAL_EFFECT_ALREADY_CONFIRMED');
              if (document.type === 'E') {
                const invoice = await records.get(
                  'document',
                  document.relatedDocumentCode,
                  'view',
                  actor,
                  tx,
                );
                if (amount(invoice.creditReserved || '0').lt(document.total))
                  throw new ApplicationError(409, 'BILLING_CREDIT_RESERVATION_MISSING');
                await tx.replace(
                  'document',
                  invoice,
                  next(invoice, {
                    creditReserved : amount(invoice.creditReserved)
                      .minus(document.total)
                      .toFixed(invoice.currencyDecimals),
                  }),
                );
              }
              for (const businessCode of document.globalInfo?.operationCodes || []) {
                const reference = await tx.get('global-operation', {
                  workspace    : actor.workspace,
                  documentCode : document.code,
                  businessCode,
                  active       : true,
                });
                if (reference)
                  await tx.replace(
                    'global-operation',
                    reference,
                    next(reference, { active: false }),
                  );
              }
              await tx.replace(
                'document',
                document,
                next(document, {
                  status          : 'draft',
                  activeOperation : '',
                  error           : '',
                }),
              );
            } else if (
              operation.kind === 'deliver' &&
              ['delivery-sent', 'delivery-not-sent'].includes(data.outcome)
            ) {
              if (document.deliveryOperation !== operation.code)
                throw new ApplicationError(409, 'BILLING_DOCUMENT_CHANGED');
              await tx.replace(
                'document',
                document,
                next(document, {
                  deliveryStatus    : data.outcome === 'delivery-sent' ? 'sent' : 'failed',
                  deliveryOperation : '',
                  error             : '',
                }),
              );
            } else throw new ApplicationError(400, 'BILLING_INVALID_RESOLUTION');
          }
          const updated = next(operation, {
            status     : ['not-issued', 'delivery-not-sent'].includes(data.outcome)
              ? 'failed'
              : 'succeeded',
            error      : ['not-issued', 'delivery-not-sent'].includes(data.outcome)
              ? 'BILLING_CONFIRMED_NO_EFFECT'
              : '',
            resolution : {
              outcome  : data.outcome,
              evidence : data.evidence,
              actor    : actor.user.userCode,
              date     : clock(),
            },
          });
          await tx.replace('operation', operation, updated);
          await records.audit(tx, actor, 'operation', operation.code, data.outcome, data.evidence);
          return updated;
        },
      );
      return present('operation', result);
    },
  };
}
module.exports = { billingResolution };
