/**
 * @file Propagación del contexto asíncrono y de la sesión transaccional entre operaciones de mensajería.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const protocol = require('./protocol');

/**
 * Propagación del contexto asíncrono opaco y de la sesión transaccional. Los métodos internos se ejecutan
 * con la instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Obtiene el contexto asíncrono vigente o un objeto vacío fuera de una ejecución contextualizada.
   * @returns {Object} Contexto vigente o un objeto vacío fuera de una ejecución contextualizada.
   */
  getContext() {
    const store = this.context.getStore();
    return store ? store.context : {};
  },

  /**
   * Ejecuta una función con otro contexto conservando la sesión y los metadatos asíncronos existentes.
   *
   * @param {Object} context Contexto de ejecución con identidad y atributos proporcionados por el llamador.
   * @param {Function} callback Operación que se invoca dentro del contexto preparado.
   * @returns {*} Resultado devuelto por this.context.run con los argumentos preparados por la función.
   */
  runWithContext(context, callback) {
    return this.context.run(
      {
        ...this.context.getStore(),
        context,
      },
      callback,
    );
  },

  /**
   * Construye un sobre heredando contexto, correlación y causalidad de la ejecución actual cuando no se
   * sobrescriben.
   *
   * @param {string} kind Tipo de mensaje, recurso o selección que procesa la operación.
   * @param {string} name Nombre utilizado para identificar la operación o el recurso.
   * @param {*} payload Contenido de aplicación; el transporte lo conserva sin validar sus reglas de
   * negocio.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @param {string} target Servicio o destino al que se dirige la operación.
   * @returns {Object} Sobre técnico con la identidad de esta instancia y el contexto de ejecución.
   */
  _envelope(kind, name, payload, options = {}, target) {
    const current = this.context.getStore();
    return protocol.createEnvelope({
      telemetry     : this.observer.captureCarrier(),
      kind,
      name,
      payload,
      target,
      source        : this.service,
      version       : options.version,
      messageId     : options.messageId,
      deadlineAt    : options.deadlineAt,
      context       : options.context === undefined ? (current ? current.context : {}) : options.context,
      correlationId : options.correlationId || current?.message?.correlationId,
      causationId   : options.causationId || current?.message?.messageId,
    });
  },

  /**
   * Ejecuta una operación con sesión transaccional propagada mediante el contexto asíncrono del runtime.
   *
   * @param {Function} work Operación ejecutada con la sesión transaccional disponible.
   * @returns {Promise<*>} Resultado devuelto por this.store.transaction con los argumentos preparados por
   * la función.
   */
  async transaction(work) {
    await this._waitFor(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => this.store?.ready === true,
      Date.now() + this.config.startTimeoutMs,
    );
    return this.store.transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (session) =>
        this.context.run(
          {
            ...this.context.getStore(),
            context : this.getContext(),
            session,
          },

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => work(session),
        ),
      { session: this.context.getStore()?.session },
    );
  },
};
