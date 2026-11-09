/**
 * @file Interfaz pública de mensajería con métodos enlazados a la instancia del runtime y constructores
 * de respuesta.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { responseHelpers } = require('./response-policy');

const methods = [
  'start',
  'close',
  'registerAction',
  'subscribe',
  'request',
  'sendCommand',
  'publishEvent',
  'transaction',
  'getContext',
  'runWithContext',
  'getHealth',
  'getStats',
  'replayFailed',
];

/**
 * Enlaza los métodos públicos al runtime para conservar su contexto cuando se invocan desde la
 * aplicación.
 *
 * @param {Object} runtime Instancia que conserva estado y operaciones del transporte.
 * @returns {Object} Interfaz cuyos métodos conservan el contexto del runtime.
 */
function createFacade(runtime) {
  return Object.assign(
    Object.fromEntries(
      methods.map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {*} method Valor de method utilizado por esta operación.
         * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (method) => [method, runtime[method].bind(runtime)],
      ),
    ),
    responseHelpers,
  );
}

module.exports = { createFacade };
