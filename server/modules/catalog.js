/** @file Raíz de composición técnica y registro RPC; el transporte no contiene reglas fiscales. */
'use strict';
const { composeBilling } = require('./billing/compositions/billing.composition');
/** @param {Object} options Transporte abierto y servicios opcionales de prueba. @returns {Object[]} Acciones con contrato y contexto por solicitud. */
function createCatalog({ messaging, services }) {
  if (!services) {
    const crypto = require('node:crypto'),
      database   = require('../adapters/mongodb/connection').connection;
    const temporaryFiles = require('../adapters/filesystem/temporary-files').createTemporaryFiles({
      root : process.env.TEMP,
    });
    const files          = require('../adapters/documents/billing-files').billingFiles({
      messaging,
      temporaryFiles,
    });
    const pac            = require('../adapters/pac/billing-pac').billingPac({
      soap    : require('../adapters/pac/facturaloplus').facturaloplus({
        fetch     : globalThis.fetch,
        timeoutMs : Number(process.env.BILLING_PAC_TIMEOUT_MS) || 60000,
      }),
      secrets : require('../adapters/crypto/billing-secrets').billingSecrets(
        process.env.BILLING_ENCRYPTION_KEY,
      ),
    });
    const store          = require('./billing/repositories/billing-store.repository').createBillingStore({
      db      : database.db,
      client  : database.getClient(),
      publish : messaging.publishEvent.bind(messaging),
    });
    services = composeBilling({
      store,
      references   : require('../adapters/messaging/billing-references').billingReferences(messaging),
      pac,
      files,
      expenseFiles : require('../adapters/documents/expense-files').expenseFiles({
        messaging,
        temporaryFiles,
      }),
      delivery     : require('../adapters/messaging/billing-delivery').billingDelivery({
        messaging,
        files,
        temporaryFiles,
      }),
      /** @returns {Object} Contexto aislado de la petición activa. */
      context      : () => messaging.getContext(),
      /** @returns {number} Milisegundos UTC. */
      clock        : () => Date.now(),
      /** @param {string} resource Tipo de entidad. @returns {string} Identidad estable de dominio. */
      identifier   : (resource) => 'BIL-' + resource + '-' + crypto.randomUUID(),
      uuid         : crypto.randomUUID,
      /** @param {Object} value Contenido acreditado. @returns {string} Huella determinista independiente del orden de claves. */
      hash(value) {
        /** @param {*} item Valor JSON. @returns {*} Representación canónica. */
        function canonical(item) {
          if (Array.isArray(item)) return item.map(canonical);
          if (!item || typeof item !== 'object') return item;
          const sorted = {};
          for (const key of Object.keys(item).sort())
            if (item[key] !== undefined) sorted[key] = canonical(item[key]);
          return sorted;
        }
        return crypto
          .createHash('sha256')
          .update(JSON.stringify(canonical(value)))
          .digest('hex');
      },
    });
    messaging.billingWorker =
      require('./billing/compositions/billing-workers.composition').billingWorkers({
        connection : database,
        store,
        services,
        logger     : require('../telemetry').logger,
      });
  }
  const entries = [];
  /** @param {string} name Acción canónica. @param {Function} invoke Caso de uso. @param {number} status Código de éxito. @returns {void} Registra la adaptación del sobre RPC. */
  function register(name, invoke, status = 200) {
    entries.push({
      name,
      kind : 'action',
      /** @param {Object} message Entrada acreditada por DTO. @returns {Promise<Object>} Sobre público validado a la salida. */
      async handler(message) {
        return messaging.successResponse(
          status,
          await services.delegated.execute(name, message.data, invoke),
        );
      },
    });
  }
  for (const resource of [
    'issuer',
    'document',
    'receipt',
    'operation',
    'audit',
    'sale',
    'expense',
    'expense-payment',
    'expense-category',
    'cost-center',
  ]) {
    register(
      `billing-${resource}-get-one`,
      /** @param {Object} data Identidad. @returns {Promise<Object>} Recurso autorizado. */
      (data) => services.records.getOne(resource, data),
    );
    register(
      `billing-${resource}-get-list`,
      /** @param {Object} data Filtros. @returns {Promise<Object>} Página autorizada. */
      (data) => services.records.getList(resource, data),
    );
    if (!['issuer', 'document'].includes(resource)) continue;
    for (const operation of ['create', 'update'])
      register(
        `billing-${resource}-${operation}`,
        /** @param {Object} data Entrada editable. @returns {Promise<Object>} Recurso persistido. */
        (data) => services.records[operation](resource, data),
        operation === 'create' ? 201 : 200,
      );
  }
  for (const resource of ['expense-category', 'cost-center'])
    for (const operation of ['create', 'update'])
      register(
        `billing-${resource}-${operation}`,
        /** @param {Object} data Catálogo global. @returns {Promise<Object>} Resultado auditado. */
        (data) => services.expenses.catalogSave(resource, data),
        operation === 'create' ? 201 : 200,
      );
  register('billing-expense-create', services.expenses.create, 201);
  register('billing-expense-update', services.expenses.update);
  for (const action of ['confirm', 'cancel', 'discard'])
    register(
      'billing-expense-' + action,
      /** @param {Object} data Transición explícita. @returns {Promise<Object>} Estado auditado. */
      (data) => services.expenses.transition(action, data),
    );
  register('billing-expense-payment-create', services.expensePayments.create, 201);
  register('billing-expense-payment-reverse', services.expensePayments.reverse);
  register('billing-expense-file-upload-prepare', services.expenseAttachments.prepareUpload);
  register('billing-expense-file-upload', services.expenseAttachments.upload, 201);
  register('billing-expense-file-download-prepare', services.expenseAttachments.prepareDownload);
  register('billing-expense-file-get', services.expenseAttachments.read);
  register('billing-expense-xml-preview', services.expenseXml.preview);
  register('billing-expense-xml-apply', services.expenseXml.apply);
  register('billing-expense-import-prepare', services.expenseXml.prepareImport);
  register(
    'billing-expense-import-upload',
    /** @param {Object} data Cabecera y temporal privado. @returns {Promise<Object>} Borrador recuperable importado. */
    (data) => services.expenseXml.import(data),
    201,
  );
  register('billing-sale-extraction-create', services.extraction.create, 201);
  register('billing-sale-extraction-advance', services.extraction.advance);
  register(
    'billing-sale-extraction-get-one',
    /** @param {Object} data Identidad. @returns {Promise<Object>} Proceso autorizado. */ (data) =>
      services.records.getOne('sale-extraction', data),
  );
  for (const resource of ['sale', 'receipt']) {
    register(
      'billing-' + resource + '-file-get',
      /** @param {Object} data Identidad. @returns {Promise<Object>} Archivo privado. */ (data) =>
        services.commercialPdf.file(resource, data),
    );
    register(
      'billing-' + resource + '-download-prepare',
      /** @param {Object} data Identidad. @returns {Promise<Object>} Metadatos. */ (data) =>
        services.commercialPdf.prepare(resource, data),
    );
  }
  register('billing-sale-create', services.sales.create, 201);
  register('billing-sale-update', services.sales.update);
  register('billing-sale-confirm', services.sales.confirm);
  register('billing-sale-cancel', services.sales.cancel);
  register('billing-sale-invoice-create', services.sales.createInvoice, 201);
  register('billing-sale-global-create', services.sales.createGlobal, 201);
  register('billing-document-discard', services.records.discard);
  register('billing-document-redate', services.records.redate);
  register('billing-operation-resolve', services.resolution.resolve);
  register('billing-issuer-csd-set', services.records.setCsd);
  register('billing-pac-get-one', services.pacSettings.getOne);
  register('billing-pac-update', services.pacSettings.update);
  register('billing-pac-credits-get', services.pacSettings.credits);
  register('billing-issuer-cancellations-get-list', services.pending);
  register(
    'billing-document-refresh-customer',
    services.records.refreshCustomer.bind(services.records),
  );
  register('billing-document-file-get', services.file);
  register('billing-document-download-prepare', services.prepareFile);
  register('billing-receipt-create', services.receipts.create, 201);
  register('billing-receipt-reverse', services.receipts.reverse);
  register('billing-receipt-rep-create', services.receipts.createRep, 201);
  for (const kind of ['issue', 'cancel', 'reconcile', 'deliver', 'authorize'])
    register(
      kind === 'authorize' ? 'billing-cancellation-authorize' : 'billing-document-' + kind,
      /** @param {Object} data Intención. @returns {Promise<Object>} Operación durable sin bloquear el RPC con efectos PAC. */
      (data) => services.commands.enqueue(kind, data),
      202,
    );
  return entries;
}
module.exports = { createCatalog: require('../contracts/index').catalogFactory(createCatalog) };
