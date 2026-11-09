/**
 * @file Registro de manejadores por nombre y versión, con su modalidad de ejecución y seguridad de
 * reintento.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { MessagingError } = require('./errors');

/**
 * Registro técnico de manejadores y búsqueda por versión del protocolo. Los métodos internos se ejecutan
 * con la instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Combina nombre y versión para identificar inequívocamente un manejador en el registro.
   *
   * @param {string} name Nombre utilizado para identificar la operación o el recurso.
   * @param {number} version Versión del contrato que se registra o publica.
   * @returns {string} Clave de registro formada por nombre y versión.
   */
  _key(name, version) {
    return `${name}@${version}`;
  },

  /**
   * Valida y registra un manejador; rechaza duplicados y cambios después del inicio del runtime.
   *
   * @param {Map} map Registro donde se conserva la definición del manejador.
   * @param {Object} definition Nombre, versión, manejador y modalidad de ejecución que se registran.
   * @returns {Object} La instancia del runtime que recibió la definición.
   * @throws {Error} Interrumpe la operación
   * ante REGISTRY_LOCKED, INVALID_REGISTRATION, DUPLICATE_HANDLER.
   */
  _register(map, definition) {
    if (this.state !== 'created') throw new MessagingError('REGISTRY_LOCKED');
    const {
      name,
      version = 1,
      handler,
      execution = 'nonTransactional',
      retrySafe = false,
    } = definition;
    if (
      typeof name !== 'string' ||
      !/^[a-zA-Z0-9._:-]+$/.test(name) ||
      typeof handler !== 'function' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !['transactional', 'nonTransactional'].includes(execution)
    ) {
      throw new MessagingError('INVALID_REGISTRATION');
    }
    const key = this._key(name, version);
    if (map.has(key)) throw new MessagingError('DUPLICATE_HANDLER');
    map.set(key, {
      name,
      version,
      handler,
      execution,
      retrySafe : retrySafe === true,
    });
    return this;
  },

  /**
   * Registra una acción dirigida en el catálogo de solicitudes y comandos.
   *
   * @param {Object} definition Nombre, versión, manejador y modalidad de ejecución que se registran.
   * @returns {Object} La instancia del runtime con la acción registrada.
   */
  registerAction(definition) {
    return this._register(this.actions, definition);
  },

  /**
   * Registra una suscripción versionada para recibir eventos del transporte.
   *
   * @param {Object} definition Nombre, versión, manejador y modalidad de ejecución que se registran.
   * @returns {Object} La instancia del runtime con la suscripción registrada.
   */
  subscribe(definition) {
    return this._register(this.subscriptions, definition);
  },
};
