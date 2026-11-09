/**
 * @file Composición de la instancia de mensajería con la identidad, configuración, conexión y catálogo
 * del servicio que carga este módulo.
 */
'use strict';
/**
 * Punto de composición compartido: construir la instancia no abre conexiones ni carga los manejadores de
 * aplicación.
 */
const path                       = require('node:path');
const { name }                   = require('../../../package.json');
const { createMessagingService } = require('../../library/messaging/index');
const telemetry                  = require('../../telemetry');
const database                   = require('../mongodb/connection');
const health                     = require('../../library/messaging/health');

module.exports = require('../../contracts/index').client(
  createMessagingService({
    service        : name,
    namespace      : require('../../shared/runtime-identity').runtimeIdentity().namespace,
    url            : process.env.MQ,
    logger         : telemetry.logger,
    observer       : telemetry.observer,
    /**
     * Ejecuta closeTelemetry dentro del flujo de config.
     * @param {Object} options Opciones que delimitan el comportamiento de la operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    closeTelemetry : (options) => telemetry.close(options),
    config         : {
      rpcTimeoutMs : Number(process.env.MQ_RPC_TIMEOUT) || 15000,
      prefetch     : Number(process.env.MQ_PREFETCH) || 20,
    },
    database,
    /**
     * Resuelve loadCatalog aplicando los filtros y colaboradores del módulo.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    loadCatalog    : () =>
      require('../../modules/catalog').createCatalog({
        messaging : module.exports,
      }),
    releaseFile    : path.resolve(__dirname, '../../../release.json'),
  }),
);

try {
  telemetry.attachMessaging(module.exports);
  telemetry.attachHealth(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async () => (await health(database.connection, module.exports)).data,
  );
} catch {
  /* La observación no modifica la disponibilidad del servicio. */
}
