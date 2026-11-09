/** @file Implementación de indexes. */
'use strict';
const { isDeepStrictEqual } = require('node:util');
const options               = [
  'partialFilterExpression',
  'expireAfterSeconds',
  'collation',
  'wildcardProjection',
];
/**
 * Ejecuta matchesIndex dentro del flujo de indexes.
 * @param {*} actual Valor de actual utilizado por esta operación.
 * @param {*} expected Valor de expected utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function matchesIndex(actual, expected) {
  return (
    JSON.stringify(actual.key) === JSON.stringify(expected.key) &&
    (!expected.name || actual.name === expected.name) &&
    ['unique', 'sparse', 'hidden'].every(
      /**
       * Comprueba la condición requerida para cada elemento.
       * @param {string} key Clave del campo o recurso que se procesa.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (key) => !!actual[key] === !!expected[key],
    ) &&
    options.every(
      /**
       * Comprueba la condición requerida para cada elemento.
       * @param {string} key Clave del campo o recurso que se procesa.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (key) => isDeepStrictEqual(actual[key], expected[key]),
    )
  );
}
/**
 * Ejecuta inspectIndexes dentro del flujo de indexes.
 * @param {*} db Valor de db utilizado por esta operación.
 * @param {*} collections Valor de collections utilizado por esta operación.
 * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function inspectIndexes(db, collections) {
  const missing = [],
    conflicts   = [];
  for (const [collection, expected] of Object.entries(collections)) {
    let actual;
    try {
      actual = await db.collection(collection).listIndexes().toArray();
    } catch (error) {
      if (error.code === 26) actual = [];
      else throw error;
    }
    for (const index of expected) {
      if (
        actual.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {*} existing Valor de existing utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (existing) => matchesIndex(existing, index),
        )
      )
        continue;
      const expectedName =
        index.name ||
        Object.entries(index.key)
          .map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {Array<*>} argument1 Valor de argument1 utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            ([key, direction]) => key + '_' + direction,
          )
          .join('_');
      const competing    = actual.some(
        /**
         * Comprueba si el elemento satisface la condición.
         * @param {*} existing Valor de existing utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (existing) => existing.name === expectedName,
      );
      (competing ? conflicts : missing).push({
        collection,
        index,
      });
    }
  }
  return {
    missing,
    conflicts,
  };
}
/**
 * Ejecuta verifyIndexes dentro del flujo de indexes.
 * @param {*} db Valor de db utilizado por esta operación.
 * @param {*} collections Valor de collections utilizado por esta operación.
 * @returns {Promise<boolean>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function verifyIndexes(db, collections) {
  const report = await inspectIndexes(db, collections);
  if (report.missing.length || report.conflicts.length) {
    const error = new Error('MongoDB index prerequisites must be prepared administratively');
    error.code = 'MONGODB_INDEXES_REQUIRED';
    error.missing = report.missing.map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => ({
        collection : item.collection,
        key        : item.index.key,
      }),
    );
    error.conflicts = report.conflicts.map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} item Valor de item utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (item) => ({
        collection : item.collection,
        key        : item.index.key,
      }),
    );
    throw error;
  }
  return true;
}
module.exports = {
  matchesIndex,
  inspectIndexes,
  verifyIndexes,
};
