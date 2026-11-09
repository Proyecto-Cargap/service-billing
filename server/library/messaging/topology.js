/**
 * @file Nombres y declaración de intercambios, colas quorum y enlaces AMQP a partir del espacio de
 * nombres y el servicio.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { MessagingError } = require('./errors');

/**
 * Valida los nombres y construye identificadores de intercambios y colas para el espacio de nombres y
 * servicio.
 *
 * @param {string} namespace Espacio de nombres que aísla los recursos del transporte.
 * @param {string} service Identidad del servicio dentro del transporte.
 * @returns {Object} Nombres de intercambios y colas aislados por espacio de nombres y servicio.
 * @throws {Error} Interrumpe la operación
 * ante INVALID_CONFIGURATION.
 */
function topology(namespace, service) {
  for (const value of [namespace, service]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(value) || value.length > 100) {
      throw new MessagingError('INVALID_CONFIGURATION', 'Invalid messaging namespace or service');
    }
  }
  const base      = `${namespace}.messaging.v1`;
  const exchanges = Object.fromEntries(
    ['events', 'commands', 'rpc', 'failures'].map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} kind Valor de kind utilizado por esta operación.
       * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (kind) => [kind, `${base}.${kind}`],
    ),
  );
  const queues    = Object.fromEntries(
    ['events', 'commands', 'rpc', 'failures'].map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} kind Valor de kind utilizado por esta operación.
       * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (kind) => [kind, `${base}.${service}.${kind}`],
    ),
  );
  return {
    base,
    exchanges,
    queues,
  };
}

/**
 * Construye la clave de enrutamiento de un evento incluyendo su versión contractual.
 *
 * @param {string} name Nombre utilizado para identificar la operación o el recurso.
 * @param {number} version Versión del contrato que se registra o publica.
 * @returns {string} Clave de evento con sufijo de versión.
 */
function eventKey(name, version) {
  return `${name}.v${version}`;
}

/**
 * Declara intercambios durables, colas quorum y enlaces para las acciones y suscripciones registradas.
 *
 * @param {Object} channel Canal AMQP utilizado para la operación.
 * @param {*} names Nombres de los recursos de transporte calculados para esta instancia.
 * @param {string} service Identidad del servicio dentro del transporte.
 * @param {Iterable<Object>} subscriptions Suscripciones versionadas que determinan los enlaces de
 * eventos.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */
async function declare(channel, names, service, subscriptions) {
  for (const [kind, exchange] of Object.entries(names.exchanges)) {
    await channel.assertExchange(exchange, kind === 'events' ? 'topic' : 'direct', {
      durable : true,
    });
  }
  for (const queue of Object.values(names.queues)) {
    await channel.assertQueue(queue, {
      durable   : true,
      arguments : { 'x-queue-type': 'quorum' },
    });
  }
  for (const kind of ['commands', 'rpc', 'failures']) {
    await channel.bindQueue(names.queues[kind], names.exchanges[kind], service);
  }
  /**
   * Los nombres utilizados proceden exclusivamente del registro explícito de la aplicación.
   */
  for (const definition of subscriptions) {
    await channel.bindQueue(
      names.queues.events,
      names.exchanges.events,
      eventKey(definition.name, definition.version),
    );
  }
}

module.exports = {
  topology,
  eventKey,
  declare,
};
