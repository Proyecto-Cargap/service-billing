/**
 * @file Contadores, registros técnicos y estado de disponibilidad de las dependencias del runtime.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';

/**
 * Contadores técnicos, registros estructurados y disponibilidad de las dependencias. Los métodos internos
 * se ejecutan con la instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Incrementa un contador técnico de la instancia para registrar la operación observada.
   *
   * @param {string} key Clave con la que se localiza o identifica el valor.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _count(key) {
    this.counters[key] = (this.counters[key] || 0) + 1;
  },

  /**
   * Emite un registro estructurado con identidad y estado del runtime, junto con los metadatos
   * suministrados.
   *
   * @param {string} event Nombre del evento registrado o emitido.
   * @param {Object} [extra] Metadatos adicionales del registro técnico.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _log(event, extra = {}) {
    this.logger?.info?.({
      component : 'messaging',
      service   : this.service,
      event,
      ...extra,
    });
  },

  /**
   * Calcula disponibilidad a partir de la persistencia, los consumidores y el estado de conexión.
   * @returns {Object} Estado del runtime y disponibilidad de persistencia y mensajería.
   */
  getHealth() {
    const databaseReady =
      this.store?.ready === true &&
      this.dbConnection?.readyState === 1 &&
      this.persistenceFeed?.ready === true &&
      this.persistenceHealth &&
      !this.consumerChannels.some(
        /**
         * Comprueba si el elemento satisface la condición.
         * @param {*} consumer Valor de consumer utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (consumer) => consumer.paused,
      );
    return {
      state     : this.state,
      database  : databaseReady ? 'ready' : 'not_ready',
      messaging : this.state === 'ready' && databaseReady ? 'ready' : 'not_ready',
    };
  },

  /**
   * Obtiene una instantánea de contadores y trabajo pendiente sin modificar su estado.
   * @returns {Object} Instantánea de contadores, solicitudes y confirmaciones pendientes.
   */
  getStats() {
    return {
      ...this.counters,
      state              : this.state,
      pendingRequests    : this.pendingRequests.size,
      processing         : this.inFlight.size,
      pendingConfirms    : (this.publisher?.pending.size || 0) + (this.rpcPublisher?.pending.size || 0),
      bufferedBytes      : this.bufferedBytes,
      pendingAcceptances : this.pendingAcceptances,
      persistence        : this._persistenceSnapshot(),
    };
  },
};
