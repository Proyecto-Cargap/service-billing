/** @file Cursor emitido con la respuesta canónica del productor; no usa relojes ni incorpora metadatos al DTO público. Biblioteca portable Messaging. */
'use strict';
const { createHash }     = require('node:crypto');
const { MessagingError } = require('./errors');
const receipts           = new WeakMap();
/** @param {*} value Valor JSON ya serializado. @returns {*} Orden canónico de claves, conservando el orden de las listas. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const entries = [];
    for (const key of Object.keys(value).sort()) entries.push([key, canonical(value[key])]);
    return Object.fromEntries(entries);
  }
  return value;
}
/** @param {*} response Resultado exacto del productor, después de validar su DTO. @returns {string} Identidad del estado consultado, independiente de orden de claves y reloj. */
function issueReadReceipt(response) {
  const json = JSON.parse(JSON.stringify(response) ?? 'null');
  return createHash('sha256')
    .update(JSON.stringify(canonical(json)))
    .digest('hex');
}
/** @param {*} response Respuesta RPC cuyo origen y causalidad ya se comprobaron. @param {string} cursor Cursor del sobre del productor. @returns {*} DTO intacto, con recibo técnico en memoria sólo mientras viva la respuesta. */
function confirmReadReceipt(response, cursor) {
  if (
    typeof cursor !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cursor) ||
    issueReadReceipt(response) !== cursor
  )
    throw new MessagingError('INVALID_READ_RECEIPT');
  if (response && typeof response === 'object') receipts.set(response, cursor);
  return response;
}
/** @param {Object} response Respuesta canónica acreditada por RPC. @param {*} [data] Proyección o ausencia canónica normalizada por la política del dominio. @returns {Object} Datos y cursor del propietario; nunca fabrica un cursor en el consumidor. */
function readSnapshot(response, data = response?.data) {
  const cursor = receipts.get(response);
  if (!cursor) throw new MessagingError('READ_RECEIPT_REQUIRED');
  if (issueReadReceipt(response) !== cursor) throw new MessagingError('READ_RECEIPT_CHANGED');
  return {
    data,
    cursor,
  };
}
module.exports = {
  issueReadReceipt,
  confirmReadReceipt,
  readSnapshot,
};
