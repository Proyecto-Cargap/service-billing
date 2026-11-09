/**
 * @file Fábrica que compone el runtime, la fachada y el ciclo de vida con dependencias inyectadas por el
 * servicio.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { MessagingRuntime } = require('./runtime');
const { createFacade }     = require('./facade');
const { registerCatalog }  = require('./catalog');
const { createLifecycle }  = require('./lifecycle');
const health               = require('./health');

/**
 * Compone una instancia autónoma con fachada pública, identidad de versión y ciclo de vida de la base de
 * datos.
 *
 * @param {Object} options Opciones y dependencias de esta operación.
 * @param {string} options.service Identidad del servicio dentro del transporte.
 * @param {string} options.namespace Espacio de nombres que aísla los recursos del transporte.
 * @param {*} options.url Dirección del recurso que se utiliza.
 * @param {Object} [options.logger] Receptor de registros técnicos de la operación.
 * @param {Object} [options.config] Configuración que define el comportamiento de la operación.
 * @param {Object} options.database Adaptador de conexión y cierre de la base de datos.
 * @param {*} [options.loadCatalog] Función que obtiene el catálogo de acciones y suscripciones.
 * @param {string} options.releaseFile Ruta explícita al archivo con la identidad de la versión
 * desplegada.
 * @returns {Object} Fachada de mensajería con operaciones de arranque y cierre coordinadas.
 */
function createMessagingService({
  service,
  namespace,
  url,
  logger = console,
  config = {},
  database,
  /**
   * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
   * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  loadCatalog = () => [],
  releaseFile,
  observer,
  closeTelemetry,
  healthChecks = {},
}) {
  const runtime   = new MessagingRuntime({
    service,
    namespace,
    url,
    logger,
    config,
    observer,
  });
  const messaging = createFacade(runtime);
  const identity  = health.captureIdentity(releaseFile);
  const lifecycle = createLifecycle({
    messaging,
    database,
    logger,
    shutdownMs : config.shutdownMs,
    closeTelemetry,
    /**
     * Carga el catálogo de la aplicación y lo registra utilizando la conexión ya abierta.
     *
     * @param {Object} connection Conexión de base de datos o transporte utilizada por el módulo.
     * @returns {Promise<*>} Resultado devuelto por registerCatalog con los argumentos preparados por la
     * función.
     */
    register   : async (connection) =>
      registerCatalog(messaging, {
        connection,
        catalog : await loadCatalog(),
        /**
         * Ejecuta health dentro del flujo de service.
         * @param {*} databaseConnection Valor de databaseConnection utilizado por esta operación.
         * @param {*} transport Valor de transport utilizado por esta operación.
         * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        health  : async (databaseConnection, transport) => {
          const result = await health(databaseConnection, transport, identity);
          for (const [name, check] of Object.entries(healthChecks)) {
            try {
              result.data[name] = (await check()) === true ? 'ready' : 'unavailable';
            } catch {
              result.data[name] = 'unavailable';
            }
            if (result.data[name] !== 'ready') result.statusCode = 503;
          }
          return result;
        },
        service,
      }),
  });
  return Object.assign(createFacade(runtime), lifecycle);
}

module.exports = { createMessagingService };
