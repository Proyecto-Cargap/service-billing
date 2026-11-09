/** @file Puertos documentales sustituibles para aceptación de gastos. */
'use strict';
const assert                     = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { expenseXml }             = require('./expense-xml-fixture.cjs');
const { parseExpenseXml }        = require('../server/adapters/documents/expense-files');
/** @param {string} xml Original. @returns {Object} Puerto privado con fallo recuperable y bytes constantes. */
function storage(xml = expenseXml()) {
  const originals = new Map();
  return {
    originals,
    fail : false,
    /** @returns {Promise<Object>} Datos parseados del original. */ async parseUpload() {
      return parseExpenseXml(xml);
    },
    /** @param {Object} data Carga. @returns {Promise<Object>} Huella acreditada del doble. */ async inspect(
      data,
    ) {
      return {
        name       : data.name,
        byteLength : data.byteLength,
        sha256     : data.sha256,
        kind       : 'xml',
        mimeType   : 'application/xml',
      };
    },
    /** @param {Object} owner Propietario. @param {string} resource Dominio. @param {Object} file Identidad estable. @returns {Promise<void>} El efecto incierto conserva la misma identidad. */ async upload(
      owner,
      resource,
      file,
    ) {
      originals.set(file.fileId, {
        owner,
        resource,
        xml,
      });
      if (this.fail) throw new Error('response-lost');
    },
    /** @param {Object} owner Propietario. @param {Object} file Archivo. @returns {Promise<Object>} Original privado. */ async xml(
      owner,
      file,
    ) {
      assert.equal(originals.get(file.fileId).owner.code, owner.code);
      return parseExpenseXml(originals.get(file.fileId).xml);
    },
    /** @param {Object} owner Propietario. @param {string} resource Dominio. @param {Object} file Referencia. @returns {Promise<Object>} Doble de transferencia privada. */ async read(
      owner,
      resource,
      file,
    ) {
      assert.equal(originals.get(file.fileId).owner.code, owner.code);
      return {
        tempFilePath : '/private/file',
        fileName     : file.name,
        mimeType     : file.mimeType,
      };
    },
    /** @param {Object} owner Propietario. @param {string} resource Dominio. @param {Object} file Archivo huérfano. @returns {Promise<void>} Limpieza idempotente. */ async remove(
      owner,
      resource,
      file,
    ) {
      originals.delete(file.fileId);
    },
  };
}
/** @param {Object} value Gasto. @returns {Object} Transferencia desde Gateway. */
function input(value) {
  const xml = expenseXml();
  return {
    resource       : 'expense',
    code           : value.code,
    revision       : value.revision,
    tempFilePath   : '/private/input',
    name           : 'gasto.xml',
    byteLength     : Buffer.byteLength(xml),
    sha256         : createHash('sha256').update(xml).digest('hex'),
    useXml         : true,
    idempotencyKey : randomUUID(),
  };
}
module.exports = {
  storage,
  input,
};
