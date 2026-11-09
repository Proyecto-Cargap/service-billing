/** @file Conserva XML, PDF y acuses mediante Documents con identidades estables y temporales confinados. */
'use strict';
const { billingPrintView } = require('./billing-print-view');
const { ApplicationError } = require('../../shared/application-error');
const { verifyCfdi }       = require('../pac/cfdi-result');
/** @param {Object} options Transporte y acceso confinado a temporales. @returns {Object} Puerto documental privado de Billing. */
function billingFiles({ messaging, temporaryFiles }) {
  /** @param {string} action Operación canónica. @param {Object} data Entrada de Documents. @returns {Promise<Object>} Resultado o error explícito. */
  async function request(action, data) {
    const result = await messaging.request('service-documents', 'files-storage-' + action, data, {
      timeoutMs : 310000,
    });
    if (result.statusCode < 200 || result.statusCode >= 300)
      throw new ApplicationError(result.statusCode, result.descriptionCode);
    return result.data;
  }
  const adapter = {
    /** @param {Object} value Registro comercial. @param {Object|null} sale Venta de origen. @param {string} kind Tipo. @param {string} fileId Referencia estable. @returns {Promise<string>} PDF no fiscal generado por Documents. */
    async generateCommercial(value, sale, kind, fileId) {
      if (
        await adapter.hasPdf({
          ...value,
          files : {
            ...value.files,
            pdf : fileId,
          },
        })
      )
        return fileId;
      let rendered;
      const document = {
        title      : kind === 'sale' ? 'Nota de venta' : 'Recibo de pago',
        code       : value.folio || value.code,
        date       : value.date,
        status     :
          {
            confirmed : 'Confirmada',
            cancelled : 'Cancelada',
            reversed  : 'Revertido',
          }[value.status] || value.status,
        issuerName : sale?.issuerSnapshot.legalName || value.issuerCode,
        customer   : sale?.customerSnapshot.name || value.customerCode,
        currency   : value.currency,
        subtotal   : kind === 'sale' ? value.subtotal : '',
        discount   : kind === 'sale' ? value.discount : '',
        taxes      :
          kind === 'sale'
            ? value.taxes.map(
                /** @param {Object} tax Grupo fiscal histórico. @returns {Object} Desglose comercial sin acreditación CFDI. */ (
                  tax,
                ) => ({
                  label  :
                    (tax.kind === 'withheld' ? 'Retención ' : 'Traslado ') +
                    tax.code +
                    ' ' +
                    tax.factor +
                    (tax.rate ? ' ' + tax.rate : ''),
                  amount : tax.amount,
                }),
              )
            : [],
        total      : value.total || value.amount,
        paid       : kind === 'sale' ? value.paid : value.amount,
        balance    : kind === 'sale' ? value.balance : value.allocations[0]?.remainingBalance || '',
        reference  : value.reference || value.notes || '',
        lines      :
          kind === 'sale'
            ? value.lines.map(
                /** @param {Object} line Concepto histórico. @returns {Object} Partida imprimible. */ (
                  line,
                ) => ({
                  description : line.description,
                  quantity    : line.quantity,
                  unitPrice   : line.unitPrice,
                  amount      : line.amount,
                }),
              )
            : value.allocations.map(
                /** @param {Object} line Aplicación histórica. @returns {Object} Partida imprimible. */ (
                  line,
                ) => ({
                  description : sale?.folio
                    ? 'Venta ' + sale.folio
                    : line.saleCode || line.documentCode,
                  quantity    : '1',
                  unitPrice   : line.amount,
                  amount      : line.amount,
                }),
              ),
      };
      try {
        const response = await messaging.request(
          'service-documents',
          'pdf-billing-commercial-create',
          { document },
          { timeoutMs: 310000 },
        );
        if (response.statusCode !== 200)
          throw new ApplicationError(response.statusCode, response.descriptionCode);
        rendered = await temporaryFiles.validate(response.data.tempFilePath);
        const bytes = await temporaryFiles.promises.readFile(rendered);
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
          throw new ApplicationError(502, 'BILLING_INVALID_PDF');
        return await adapter.upload(value, 'pdf', fileId, bytes.toString('base64'));
      } finally {
        if (rendered) await temporaryFiles.remove(rendered);
      }
    },
    /** @param {Object} document Comprobante. @returns {Promise<boolean>} Existencia del PDF vigente; los fallos técnicos no se convierten en ausencia. */
    async hasPdf(document) {
      if (!document.files.pdf) return false;
      const result = await messaging.request(
        'service-documents',
        'files-storage-read',
        {
          fileId       : document.files.pdf,
          resourceType : document.resourceType || 'billing-document',
          resourceCode : document.code,
        },
        { timeoutMs: 310000 },
      );
      if (result.statusCode === 404) return false;
      if (result.statusCode !== 200)
        throw new ApplicationError(result.statusCode, result.descriptionCode);
      await temporaryFiles.remove(result.data.tempFilePath);
      return true;
    },
    /** @param {Object} document Comprobante con XML almacenado. @returns {Promise<string>} Evidencia fiscal original, retirando siempre su copia temporal. */
    async readXml(document) {
      const file = await adapter.read(document, 'xml');
      try {
        const path = await temporaryFiles.validate(file.tempFilePath);
        return await temporaryFiles.promises.readFile(path, 'utf8');
      } finally {
        await temporaryFiles.remove(file.tempFilePath);
      }
    },
    /** @param {Object} document Comprobante. @param {string} xml Evidencia fiscal. @param {string} fileId Referencia reservada. @returns {Promise<string>} PDF generado exclusivamente por Documents desde el XML acreditado. */
    async generatePdf(document, xml, fileId) {
      verifyCfdi(xml, document.expectedLayout, document.uuid);
      if (
        await adapter.hasPdf({
          ...document,
          files : {
            ...document.files,
            pdf : fileId,
          },
        })
      )
        return fileId;
      let rendered;
      try {
        const response = await messaging.request(
          'service-documents',
          'pdf-billing-create',
          { document: billingPrintView(document, xml) },
          { timeoutMs: 310000 },
        );
        if (response.statusCode !== 200)
          throw new ApplicationError(response.statusCode, response.descriptionCode);
        rendered = await temporaryFiles.validate(response.data.tempFilePath);
        const bytes = await temporaryFiles.promises.readFile(rendered);
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
          throw new ApplicationError(502, 'BILLING_INVALID_PDF');
        return await adapter.upload(document, 'pdf', fileId, bytes.toString('base64'));
      } finally {
        if (rendered) await temporaryFiles.remove(rendered);
      }
    },
    /** @param {Object} document Comprobante propietario. @param {string} kind XML, PDF o acuse. @param {string} fileId Identidad UUID estable asignada antes de transferir. @param {string} content XML textual o PDF base64. @returns {Promise<string>} Identidad persistida; reintento con iguales bytes es idempotente. */
    async upload(document, kind, fileId, content) {
      const name = `${document.uuid || document.code}-${kind}.${kind === 'pdf' ? 'pdf' : 'xml'}`,
        path     = temporaryFiles.uniquePath(name);
      try {
        await temporaryFiles.promises.writeFile(
          path,
          Buffer.from(content, kind === 'pdf' ? 'base64' : 'utf8'),
          {
            flag : 'wx',
            mode : 0o600,
          },
        );
        await request('upload', {
          fileId,
          tempFilePath     : path,
          name,
          visibility       : 'private',
          generateVariants : false,
          image            : false,
          resourceType     : document.resourceType || 'billing-document',
          resourceCode     : document.code,
          workspace        : document.workspace,
        });
        return fileId;
      } finally {
        await temporaryFiles.remove(path);
      }
    },
    /** @param {Object} document CFDI autorizado por Billing. @param {string} kind Tipo de archivo registrado. @returns {Promise<Object>} Transferencia temporal consumida por Gateway o Connect, sin URL pública. */
    async read(document, kind) {
      if (!document.files[kind]) throw new ApplicationError(404, 'BILLING_FILE_NOT_FOUND');
      const result = await request('read', {
        fileId       : document.files[kind],
        resourceType : document.resourceType || 'billing-document',
        resourceCode : document.code,
      });
      return {
        tempFilePath : result.tempFilePath,
        fileName     : result.fileName,
        mimeType     : kind === 'pdf' ? 'application/pdf' : 'application/xml',
      };
    },
  };
  return adapter;
}
module.exports = { billingFiles };
