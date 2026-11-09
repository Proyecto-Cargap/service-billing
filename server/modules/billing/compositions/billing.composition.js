/** @file Construye la aplicación de Billing con capacidades explícitas sustituibles y sin abrir conexiones. */
'use strict';
const { billingStore }       = require('../ports/billing-store.port');
const { billingRules }       = require('../services/billing-rules.service');
const { billingRecords }     = require('../services/billing-records.service');
const { billingCommands }    = require('../services/billing-commands.service');
const { receiptsService }    = require('../services/receipts.service');
const { billingResolution }  = require('../services/billing-resolution.service');
const { billingEffects }     = require('../services/billing-effects.service');
const { ApplicationError }   = require('../../../shared/application-error');
const { billingPacSettings } = require('../services/billing-pac-settings.service');
const { billingPdf }         = require('../services/billing-pdf.service');
/** @param {Object} dependencies Puertos ya construidos. @returns {Object} Casos de uso y trabajador componibles. */
function composeBilling(dependencies) {
  billingStore(dependencies.store);
  for (const name of ['context', 'clock', 'identifier', 'uuid', 'hash'])
    if (typeof dependencies[name] !== 'function')
      throw new TypeError('BILLING_CAPABILITY_REQUIRED:' + name);
  const pacSettings = billingPacSettings(dependencies),
    pdf             = billingPdf(dependencies);
  const ledger = require('../services/sale-ledger.service').saleLedger(dependencies);
  const rules = billingRules(dependencies),
    records   = billingRecords({
      productLines : require('../services/product-lines.service').productLines(
        dependencies.references,
      ),
      ...dependencies,
      ledger,
      pacSettings,
      pdf,
      rules,
      credentials  : dependencies.pac,
    }),
    commands  = billingCommands({
      ...dependencies,
      ledger,
      pacSettings,
      pdf,
      rules,
      records,
    }),
    receipts  = receiptsService({
      ...dependencies,
      ledger,
      pacSettings,
      pdf,
      records,
    }),
    effects   = billingEffects({
      ...dependencies,
      ledger,
      pacSettings,
      pdf,
      records,
    });
  const sales              = require('../services/sales.service').salesService({
    ...dependencies,
    records,
    rules,
    receipts,
  });
  const extraction         = require('../services/sale-extraction.service').saleExtraction({
    ...dependencies,
    rules,
    records,
    sales,
    commands,
  });
  const expenses           = require('../services/expenses.service').expensesService({
    ...dependencies,
    records,
  });
  const expensePayments    = require('../services/expense-payments.service').expensePayments({
    ...dependencies,
    records,
    expenses,
  });
  const expenseAttachments = require('../services/expense-attachments.service').expenseAttachments({
    ...dependencies,
    records,
    expenses,
  });
  const expenseXml         = require('../services/expense-xml.service').expenseXml({
    ...dependencies,
    records,
    expenses,
    attachments : expenseAttachments,
  });
  return {
    expenses,
    expensePayments,
    expenseAttachments,
    expenseXml,
    commercialPdf : require('../services/commercial-pdf.service').commercialPdf({
      ...dependencies,
      records,
    }),
    extraction,
    delegated     : require('../services/billing-delegation.service').billingDelegation({
      ...dependencies,
      ledger,
      records,
    }),
    records,
    sales,
    pacSettings,
    pdf,
    commands,
    receipts,
    effects,
    resolution    : billingResolution({
      ...dependencies,
      ledger,
      pacSettings,
      pdf,
      records,
    }),
    /** @param {Object} data Emisor receptor. @returns {Promise<Object>} UUID pendientes de aceptación, según contrato del proveedor. */
    async pending(data) {
      const issuer = {
          ...(await records.get('issuer', data.code)),
          pacConfig : await pacSettings.resolve(),
        },
        response   = await dependencies.pac.pending(issuer);
      if (response.code === '101') return { items: [] };
      if (response.code !== '100')
        throw new ApplicationError(502, 'BILLING_PAC_CANCELLATIONS_UNAVAILABLE');
      const items = response.data
        .split(',')
        .filter(Boolean)
        .map(
          /** @param {string} value UUID recibido del PAC. @returns {Object} Referencia mínima; el proveedor no entrega RFC ni importe en esta consulta. */
          (value) => {
            const uuid = value.trim().toUpperCase();
            if (!/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(uuid))
              throw new ApplicationError(502, 'BILLING_INVALID_PAC_RESPONSE');
            return { uuid };
          },
        );
      return { items };
    },
    /** @param {Object} data Documento y formato. @returns {Promise<Object>} Metadatos para transferir un archivo con autorización vigente. */
    async prepareFile(data) {
      const document = await records.get('document', data.code);
      if (!document.files?.[data.kind] && !(data.kind === 'pdf' && document.files?.xml))
        throw new ApplicationError(409, 'BILLING_FILES_NOT_READY');
      return {
        fileName : document.code + '.' + (data.kind === 'pdf' ? 'pdf' : 'xml'),
        mimeType : data.kind === 'pdf' ? 'application/pdf' : 'application/xml',
      };
    },
    /** @param {Object} data Identidad y clase del archivo. @returns {Promise<Object>} Temporal autorizado para transferencia binaria. */
    async file(data) {
      return pdf.read(await records.get('document', data.code), data.kind);
    },
  };
}
module.exports = { composeBilling };
