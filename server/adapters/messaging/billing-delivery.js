/** @file Entrega de CFDI mediante la plantilla y transporte existentes de Connect. */
'use strict';
const { ApplicationError } = require('../../shared/application-error');
/** @param {Object} options Transporte, archivos privados y temporales confinados. @returns {Object} Puerto de entrega sin SMTP propio. */
function billingDelivery({ messaging, files, temporaryFiles }) {
  return {
    /** @param {Object} document Comprobante con XML y PDF registrados. @param {Object} operation Intención durable del destinatario. @returns {Promise<void>} Envío confirmado o incertidumbre explícita sin reintento. */
    async send(document, operation) {
      const attachments = [];
      let size          = 0;
      for (const kind of ['xml', 'pdf']) {
        const file = await files.read(document, kind);
        try {
          const content = await temporaryFiles.promises.readFile(file.tempFilePath);
          size += content.length;
          if (size > 5 * 1024 * 1024) throw new ApplicationError(413, 'BILLING_DELIVERY_TOO_LARGE');
          attachments.push({
            filename    : file.fileName,
            contentType : file.mimeType,
            encoding    : 'base64',
            content     : content.toString('base64'),
          });
        } finally {
          await temporaryFiles.remove(file.tempFilePath);
        }
      }
      let result;
      try {
        result = await messaging.request(
          'service-connect',
          'email-send-transactional',
          {
            template      : 'billing-document',
            workspaceCode : document.workspace,
            email         : operation.input.email,
            data          : JSON.stringify({
              company  : document.issuerSnapshot.legalName,
              name     : document.customerSnapshot.fiscal.legalName,
              series   : document.series,
              folio    : document.folio,
              uuid     : document.uuid,
              total    : document.total,
              currency : document.currency,
            }),
            attachments,
          },
          { timeoutMs: 120000 },
        );
      } catch {
        throw new ApplicationError(502, 'BILLING_DELIVERY_UNCERTAIN', { uncertain: true });
      }
      if (result.statusCode !== 201)
        throw new ApplicationError(result.statusCode, result.descriptionCode, {
          uncertain : result.descriptionCode === 'EMAIL_DELIVERY_UNCERTAIN',
        });
    },
  };
}
module.exports = { billingDelivery };
