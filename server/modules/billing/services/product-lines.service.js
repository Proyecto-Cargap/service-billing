/** @file Acredita referencias comerciales nuevas y conserva las partidas históricas sin consultas al catálogo. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} references Puerto de Product. @returns {Function} Validación de nuevas referencias sin modificar importes capturados. */
function productLines(references) {
  /** @param {Object} input Borrador fiscal. @param {Object|null} previous Documento anterior. @returns {Promise<void>} Rechaza referencias alteradas o desactualizadas. */
  return async function validate(input, previous) {
    for (const line of input.lines) {
      const reference = line.catalogReference;
      if (!reference) continue;
      const existing =
        previous?.currency === input.currency &&
        previous.lines.some(
          /** @param {Object} old Partida histórica. @returns {boolean} Misma referencia inmutable. */
          (old) =>
            old.catalogReference &&
            Object.keys(reference).every(
              /** @param {string} key Campo de origen. @returns {boolean} Conserva el origen anterior. */
              (key) => old.catalogReference[key] === reference[key],
            ),
        );
      if (existing) continue;
      const current = await references.product({
        skuCode       : reference.skuCode,
        priceListCode : reference.priceListCode,
        currency      : input.currency,
      });
      if (
        !current?.catalogReference ||
        Object.keys(reference).some(
          /** @param {string} key Campo de origen. @returns {boolean} Detecta cambio de revisión o suplantación. */
          (key) => current.catalogReference[key] !== reference[key],
        )
      )
        throw new ApplicationError(409, 'BILLING_PRODUCT_CHANGED');
    }
  };
}
module.exports = { productLines };
