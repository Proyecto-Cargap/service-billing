/** @file Catálogo RPC enlazado a los DTO de entrada y salida de cada dominio del servicio. */
'use strict';
const manifest     = require('./service.json');
const actionDtos   = require('./registry');
const { validate } = require('./action-dto');

/**
 * Uniforma el nombre de una operación técnica antes de registrarla o solicitarla.
 * @param {string} name Nombre de la operación RPC.
 * @returns {string} Nombre en minúsculas con guiones.
 */
function actionName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Enlaza cada acción con su DTO y agrega la consulta del contrato vigente del servicio.
 * @param {Object[]} entries Acciones y eventos aportados por la composición de dominios.
 * @returns {Object[]} Catálogo validado con entrada y salida explícitas por acción.
 */
function catalog(entries) {
  const seen   = new Set();
  const result = entries.map(
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} entry Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (entry) => {
      const name = entry.kind === 'event' ? entry.name : actionName(entry.name);
      if (seen.has(name)) throw new Error('DUPLICATE_SERVICE_ACTION:' + name);
      seen.add(name);
      const dto = actionDtos[name];
      if (!dto) throw new Error('SERVICE_CONTRACT_MISSING:' + name);
      return {
        ...entry,
        name,

        /**
         * Ejecuta handler y devuelve el resultado al flujo que lo invoca.
         * @param {*} [message] Valor utilizado por la operación.
         * @returns {Promise<*>} Resultado de la operación; los fallos se propagan al flujo invocador.
         */
        async handler(message = {}) {
          const data = dto.input(message.data);
          return dto.output(
            await entry.handler({
              ...message,
              data,
            }),
          );
        },
      };
    },
  );
  const dto    = actionDtos['service-contracts-get'];
  result.push({
    name : 'service-contracts-get',
    kind : 'action',

    /**
     * Ejecuta handler y devuelve el resultado al flujo que lo invoca.
     * @param {*} message Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    handler(message) {
      dto.input(message?.data);
      return dto.output({
        statusCode      : 200,
        descriptionCode : 'OK',
        data            : manifest,
      });
    },
  });
  // Conserva el ciclo de vida y otros metadatos propios de la composición sin reemplazar handlers.
  for (const key of Reflect.ownKeys(entries)) {
    if (key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key))) continue;
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(entries, key));
  }
  return result;
}

/**
 * Decora una composición síncrona o asíncrona sin iniciar conexiones ni modificar sus colaboradores.
 * @param {Function} factory Composición del catálogo del servicio.
 * @returns {Function} Composición que acredita sus DTO al construir el catálogo.
 */
function catalogFactory(factory) {
  /**
   * Ejecuta createContractCatalog y devuelve el resultado al flujo que lo invoca.
   * @param {...*} args Valor utilizado por la operación.
   * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
   */
  return function createContractCatalog(...args) {
    const result = factory(...args);
    return result && typeof result.then === 'function' ? result.then(catalog) : catalog(result);
  };
}

/**
 * Uniforma nombres de solicitudes y comandos conservando datos, contexto y opciones de entrega.
 * @param {Object} messaging Fachada propia de mensajería.
 * @returns {Object} Fachada con nombres de operación canónicos.
 */
function client(messaging) {
  for (const method of ['request', 'sendCommand']) {
    const original = messaging[method].bind(messaging);
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} target Valor utilizado por la operación.
     * @param {*} action Valor utilizado por la operación.
     * @param {...*} args Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    messaging[method] = (target, action, ...args) => original(target, actionName(action), ...args);
  }
  return messaging;
}
module.exports = {
  manifest,
  actionDtos,
  actionName,
  validate,
  catalog,
  catalogFactory,
  client,
};
