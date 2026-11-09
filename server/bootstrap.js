/** @file Composición y ciclo de vida explícitos; importar este módulo no abre conexiones. */
'use strict';
const lifecycle = require('./adapters/messaging/config');
/** Abre dependencias y registra las señales de cierre coordinado.
 * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function start() {
  lifecycle.installShutdown(
    /** @returns {Promise<void>} Detiene el trabajador antes de cerrar sus conexiones compartidas. */
    async () => {
      await lifecycle.billingWorker?.close();
    },
  );
  await lifecycle.start();
  lifecycle.billingWorker.start();
  return lifecycle;
}
/** Drena recursos mediante el mismo ciclo de vida utilizado al detener el proceso.
 * @param {Object} options Opciones que delimitan el comportamiento de la operación.
 * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function close(options) {
  await lifecycle.billingWorker?.close();
  return lifecycle.close(options);
}
module.exports = {
  start,
  close,
};
