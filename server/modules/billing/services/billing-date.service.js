/** @file Valida fechas civiles CFDI sin inventar una zona horaria distinta al lugar de expedición. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {string} value Fecha local ISO del emisor o del cobro. @returns {void} Rechaza fechas imposibles y formatos ambiguos. */
function validateBillingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
    throw new ApplicationError(400, 'BILLING_INVALID_DATE');
  const instant = new Date(value + 'Z');
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 19) !== value)
    throw new ApplicationError(400, 'BILLING_INVALID_DATE');
}
module.exports = { validateBillingDate };
