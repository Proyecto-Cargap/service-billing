/** @file Proceso durable y explícito para extraer una venta de una global sin revertir sus cobros. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { billingAccess }       = require('../policies/billing-access.policy');
const { validateBillingDate } = require('./billing-date.service');
const { present }             = require('../presenters/billing.presenter');
/** @param {Object} dependencies Casos de uso y persistencia compartidos. @returns {Object} Recorrido reanudable con una intención fiscal por confirmación. */
function saleExtraction({ store, records, context, clock, hash, sales, commands, rules }) {
  /** @param {Object} current Proceso. @param {Object} changes Transición. @returns {Object} Nueva revisión. */
  function next(current, changes) {
    return {
      ...current,
      ...changes,
      revision   : current.revision + 1,
      updateDate : clock(),
    };
  }
  /** @param {string} action Acción. @param {Object} data Entrada. @param {Function} work Trabajo atómico. @returns {Promise<Object>} Resultado idempotente. */
  async function once(action, data, work) {
    const actor = context();
    const id    = hash([actor.workspace, actor.user.userCode, action, data.idempotencyKey]);
    return store.transaction(
      /** @param {Object} tx Transacción. @returns {Promise<Object>} Proceso confirmado. */ async (
        tx,
      ) => {
        const receipt = await tx.receiptRead(id);
        if (receipt) {
          if (receipt.fingerprint !== hash(data))
            throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
          await records.get('sale-extraction', receipt.response.code, 'view', actor, tx);
          return receipt.response;
        }
        const response = await work(tx);
        await tx.receiptInsert({
          _id         : id,
          fingerprint : hash(data),
          response,
          createdAt   : clock(),
        });
        return response;
      },
    );
  }
  return {
    /** @param {Object} data Venta global y datos fiscales individuales. @returns {Promise<Object>} Proceso sin iniciar cancelación. */
    async create(data) {
      const actor = context();
      billingAccess(actor, 'sale-extraction', 'create');
      return once(
        'extraction-create',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Proceso y reservas de corrección. */ async (
          tx,
        ) => {
          const sale = await records.get('sale', data.code, 'update', actor, tx);
          records.match(sale, data.revision);
          if (sale.extractionCode)
            return present(
              'sale-extraction',
              await records.get('sale-extraction', sale.extractionCode, 'view', actor, tx),
            );
          const document = await records.get(
            'document',
            sale.fiscalDocuments.production,
            'view',
            actor,
            tx,
          );
          if (
            !document.globalInfo ||
            document.status !== 'issued' ||
            !document.saleCodes?.includes(sale.code)
          )
            throw new ApplicationError(409, 'BILLING_SALE_NOT_IN_GLOBAL');
          await rules.document(
            {
              ...sale,
              type          : 'I',
              date          : data.date,
              cfdiUse       : data.cfdiUse,
              paymentMethod : data.paymentMethod,
              paymentForm   : data.paymentForm,
            },
            await records.historicalIssuer(document, actor, tx),
            null,
          );
          const process = {
            ...records.metadata('sale-extraction', actor),
            saleCode        : sale.code,
            globalCode      : document.code,
            replacementCode : '',
            individualCode  : '',
            stage           : 'cancel',
            error           : '',
            fiscal          : {
              date          : data.date,
              cfdiUse       : data.cfdiUse,
              paymentMethod : data.paymentMethod,
              paymentForm   : data.paymentForm,
            },
            saleCodes       : document.saleCodes,
          };
          for (const code of document.saleCodes) {
            const source = await records.get('sale', code, 'update', actor, tx);
            if (source.extractionCode) throw new ApplicationError(409, 'BILLING_SALE_RESERVED');
            await tx.replace('sale', source, next(source, { extractionCode: process.code }));
          }
          await tx.insert('sale-extraction', process);
          await records.audit(tx, actor, 'sale-extraction', process.code, 'created');
          return present('sale-extraction', process);
        },
      );
    },
    /** @param {Object} data Proceso y revisión. @returns {Promise<Object>} Una transición autorizada, sin bucles de efectos fiscales. */
    async advance(data) {
      const actor = context();
      return once(
        'extraction-advance',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Estado recuperable después de cada paso. */ async (
          tx,
        ) => {
          const current = await records.get('sale-extraction', data.code, 'update', actor, tx);
          if (data.date) {
            validateBillingDate(data.date);
            current.fiscal = {
              ...current.fiscal,
              date : data.date,
            };
          }
          records.match(current, data.revision);
          const original = await records.get('document', current.globalCode, 'view', actor, tx);
          let changes    = {};
          const key      = hash([current.code, current.revision, data.idempotencyKey]);
          if (current.stage === 'cancel') {
            await commands.enqueue('cancel', {
              code           : original.code,
              revision       : original.revision,
              reason         : '04',
              idempotencyKey : key,
            });
            changes = { stage: 'wait-cancellation' };
          } else if (current.stage === 'wait-cancellation') {
            if (original.status === 'cancelled') changes = { stage: 'prepare-global' };
            else if (
              original.status === 'issued' &&
              (original.sat?.cancellation === 'Solicitud rechazada' || original.error)
            )
              changes = {
                stage : 'cancel',
                error : 'BILLING_CANCELLATION_REJECTED',
              };
            else return present('sale-extraction', current);
          } else if (current.stage === 'prepare-global') {
            const codes = current.saleCodes.filter(
              /** @param {string} code Venta. @returns {boolean} Conserva las demás operaciones. */ (
                code,
              ) => code !== current.saleCode,
            );
            if (!codes.length) changes = { stage: 'prepare-individual' };
            else {
              const { operationCodes: ignored, ...globalInfo } = original.globalInfo;
              const draft                                      = await sales.createGlobal({
                saleCodes      : codes,
                globalInfo,
                date           : current.fiscal.date,
                paymentForm    : original.paymentForm,
                idempotencyKey : key,
                extractionCode : current.code,
              });
              if (draft.issuerSnapshot.environment !== 'production')
                throw new ApplicationError(409, 'BILLING_EXTRACTION_REQUIRES_PRODUCTION');
              changes = {
                replacementCode : draft.code,
                stage           : 'issue-global',
                error           : '',
              };
            }
          } else if (current.stage === 'prepare-individual') {
            const sale  = await records.get('sale', current.saleCode, 'update', actor, tx);
            const draft = await sales.createInvoice({
              ...current.fiscal,
              code           : sale.code,
              revision       : sale.revision,
              idempotencyKey : key,
              extractionCode : current.code,
            });
            if (draft.issuerSnapshot.environment !== 'production')
              throw new ApplicationError(409, 'BILLING_EXTRACTION_REQUIRES_PRODUCTION');
            changes = {
              individualCode : draft.code,
              stage          : 'issue-individual',
              error          : '',
            };
          } else if (['issue-global', 'issue-individual'].includes(current.stage)) {
            const global   = current.stage === 'issue-global';
            const document = await records.get(
              'document',
              global ? current.replacementCode : current.individualCode,
              'view',
              actor,
              tx,
            );
            await commands.enqueue('issue', {
              code           : document.code,
              revision       : document.revision,
              idempotencyKey : key,
            });
            changes = { stage: global ? 'wait-global' : 'wait-individual' };
          } else if (['wait-global', 'wait-individual'].includes(current.stage)) {
            const global   = current.stage === 'wait-global';
            const document = await records.get(
              'document',
              global ? current.replacementCode : current.individualCode,
              'view',
              actor,
              tx,
            );
            if (document.status === 'issued')
              changes = {
                stage : global ? 'prepare-individual' : 'complete',
                error : '',
              };
            else if (['draft', 'discarded', 'cancelled'].includes(document.status))
              changes = {
                stage : global ? 'prepare-global' : 'prepare-individual',
                error : document.error || '',
              };
            else return present('sale-extraction', current);
          } else return present('sale-extraction', current);
          const updated = next(current, changes);
          if (updated.stage === 'complete')
            for (const code of current.saleCodes) {
              const sale = await records.get('sale', code, 'update', actor, tx);
              await tx.replace('sale', sale, next(sale, { extractionCode: '' }));
            }
          await tx.replace('sale-extraction', current, updated);
          await records.audit(tx, actor, 'sale-extraction', current.code, updated.stage);
          return present('sale-extraction', updated);
        },
      );
    },
  };
}
module.exports = { saleExtraction };
