/** @file Coordina PDF propios, regeneración histórica y reservas durables sin volver a timbrar. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} options Persistencia, archivos, reloj y UUID inyectados. @returns {Object} Representación imprimible privada e idempotente. */
function billingPdf({ store, files, clock, uuid }) {
  /** @param {Object} document Identidad autorizada. @param {Object} source Unidad de lectura. @returns {Promise<Object>} Comprobante actual, sin ampliar el ámbito recibido. */
  async function current(document, source = store) {
    const value = await source.get('document', {
      workspace : document.workspace,
      code      : document.code,
    });
    if (!value?.uuid || !value.files?.xml) throw new ApplicationError(409, 'BILLING_XML_NOT_READY');
    return value;
  }
  /** @param {Object} document Comprobante autorizado. @param {string} xml XML ya acreditado, opcional en recuperación. @returns {Promise<string>} PDF propio; conserva el original histórico como evidencia interna. */
  async function ensure(document, xml = '') {
    let latest = await current(document);
    if (latest.pdfOrigin === 'platform' && latest.files.pdf && (await files.hasPdf(latest)))
      return latest.files.pdf;
    const token = uuid(),
      now       = clock();
    latest = await store.transaction(
      /** @param {Object} tx Reserva atómica sin llamadas externas. @returns {Promise<Object>} Revisión con referencia estable para esta generación. */
      async (tx) => {
        const previous = await current(document, tx);
        if (previous.pdfGeneration?.leaseUntil > now)
          throw new ApplicationError(409, 'BILLING_PDF_PENDING');
        const candidate = previous.pdfGeneration?.fileId;
        const reusable  =
          candidate &&
          (previous.pdfOrigin === 'platform' ||
            (candidate !== previous.files.pdf && !previous.previousPdfFiles?.includes(candidate)));
        const next      = {
          ...previous,
          revision      : previous.revision + 1,
          updateDate    : now,
          pdfGeneration : {
            fileId     : reusable ? candidate : uuid(),
            token,
            leaseUntil : now + 600000,
          },
        };
        await tx.replace('document', previous, next);
        return next;
      },
    );
    try {
      const fileId = latest.pdfGeneration.fileId;
      await files.generatePdf(latest, xml || (await files.readXml(latest)), fileId);
      await store.transaction(
        /** @param {Object} tx Confirma sólo la reserva vigente. @returns {Promise<void>} Archivo y procedencia publicados juntos, manteniendo referencias previas. */
        async (tx) => {
          const previous = await current(document, tx);
          if (previous.pdfGeneration?.token !== token)
            throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
          const archived = [...(previous.previousPdfFiles || [])];
          if (
            previous.files.pdf &&
            previous.files.pdf !== fileId &&
            !archived.includes(previous.files.pdf)
          )
            archived.push(previous.files.pdf);
          const next = {
            ...previous,
            files            : {
              ...previous.files,
              pdf : fileId,
            },
            fileIds          : {
              ...previous.fileIds,
              pdf : fileId,
            },
            pdfOrigin        : 'platform',
            previousPdfFiles : archived,
            pdfGeneration    : { fileId },
            revision         : previous.revision + 1,
            updateDate       : clock(),
            error            : previous.error === 'BILLING_PDF_PENDING' ? '' : previous.error,
          };
          await tx.replace('document', previous, next);
        },
      );
      return fileId;
    } catch (error) {
      await store.transaction(
        /** @param {Object} tx Libera únicamente la reserva propia. @returns {Promise<void>} Mantiene XML, UUID, saldo y referencia de generación para reintentar. */
        async (tx) => {
          const previous = await current(document, tx);
          if (previous.pdfGeneration?.token !== token) return;
          await tx.replace('document', previous, {
            ...previous,
            pdfGeneration : { fileId: previous.pdfGeneration.fileId },
            revision      : previous.revision + 1,
            updateDate    : clock(),
            error         : 'BILLING_PDF_PENDING',
          });
        },
      );
      throw error;
    }
  }
  return {
    ensure,
    /** @param {Object} document Comprobante autorizado. @param {string} kind Archivo. @returns {Promise<Object>} Descarga privada; nunca devuelve PDF de origen ajeno o desconocido. */
    async read(document, kind) {
      if (kind === 'pdf') {
        await ensure(document);
        document = await current(document);
      }
      return files.read(document, kind);
    },
  };
}
module.exports = { billingPdf };
