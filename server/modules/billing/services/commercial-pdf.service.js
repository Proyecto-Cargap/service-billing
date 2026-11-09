/** @file Comprobantes comerciales privados, con reserva durable y reintentos que no modifican dinero. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Puertos documentales y registros. @returns {Object} Descarga de notas de venta y recibos. */
function commercialPdf({ store, records, files, clock, uuid }) {
  /** @param {string} resource Recurso comercial. @param {Object} data Identidad autorizada. @returns {Promise<Object>} Registro legible y no borrador. */
  async function read(resource, data) {
    const value = await records.get(resource, data.code);
    if (value.status === 'draft') throw new ApplicationError(409, 'BILLING_SALE_NOT_CONFIRMED');
    return value;
  }
  return {
    /** @param {string} resource Recurso. @param {Object} data Identidad. @returns {Promise<Object>} Metadatos sin rutas ni contenido privado. */
    async prepare(resource, data) {
      const value = await read(resource, data);
      return {
        fileName : (value.folio || value.code) + '.pdf',
        mimeType : 'application/pdf',
      };
    },
    /** @param {string} resource Recurso. @param {Object} data Identidad. @returns {Promise<Object>} Temporal privado generado desde el estado comercial autorizado. */
    async file(resource, data) {
      let value          = await read(resource, data);
      const resourceType = 'billing-' + resource;
      if (value.commercialPdfRevision === value.revision && value.files?.pdf)
        return files.read(
          {
            ...value,
            resourceType,
          },
          'pdf',
        );
      const token          = uuid();
      const sourceRevision = value.revision;
      value = await store.transaction(
        /** @param {Object} tx Reserva transaccional. @returns {Promise<Object>} Registro reservado. */ async (
          tx,
        ) => {
          const current = await records.get(resource, data.code, 'view', undefined, tx);
          if (current.revision !== sourceRevision)
            throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
          if (current.commercialPdf?.leaseUntil > clock())
            throw new ApplicationError(409, 'BILLING_PDF_PENDING');
          const updated = {
            ...current,
            commercialPdf : {
              token,
              fileId     :
                current.commercialPdf?.sourceRevision === sourceRevision
                  ? current.commercialPdf.fileId
                  : uuid(),
              sourceRevision,
              leaseUntil : clock() + 600000,
            },
          };
          await tx.replace(resource, current, updated);
          return updated;
        },
      );
      try {
        const sale =
          resource === 'sale'
            ? value
            : value.saleCode
              ? await records.get('sale', value.saleCode)
              : null;
        await files.generateCommercial(
          {
            ...value,
            resourceType,
          },
          sale,
          resource,
          value.commercialPdf.fileId,
        );
        await store.transaction(
          /** @param {Object} tx Confirmación. @returns {Promise<void>} Publica sólo la generación todavía vigente. */ async (
            tx,
          ) => {
            const current = await records.get(resource, data.code, 'view', undefined, tx);
            if (current.commercialPdf?.token !== token || current.revision !== sourceRevision)
              throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
            await tx.replace(resource, current, {
              ...current,
              files                 : {
                ...current.files,
                pdf : value.commercialPdf.fileId,
              },
              commercialPdfRevision : current.revision,
              commercialPdf         : {},
            });
          },
        );
        await records.get(resource, data.code);
        return files.read(
          {
            ...value,
            resourceType,
            files : { pdf: value.commercialPdf.fileId },
          },
          'pdf',
        );
      } catch (error) {
        await store.transaction(
          /** @param {Object} tx Libera la reserva propia. @returns {Promise<void>} Permite reintentar sin tocar importes. */ async (
            tx,
          ) => {
            const current = await records.get(resource, data.code, 'view', undefined, tx);
            if (current.commercialPdf?.token === token)
              await tx.replace(resource, current, {
                ...current,
                commercialPdf : {
                  ...current.commercialPdf,
                  leaseUntil : 0,
                },
              });
          },
        );
        throw error;
      }
    },
  };
}
module.exports = { commercialPdf };
