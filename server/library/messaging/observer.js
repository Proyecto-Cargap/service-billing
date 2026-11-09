/**
 * @file Adaptador técnico opcional; contiene fallos del observador y ejecuta cada callback una sola vez.
 * No importa SDKs, configuración ni datos de aplicación.
 */
'use strict';
const { validateTelemetry } = require('./protocol');

/** Conserva el resultado o error del callback aunque falle la infraestructura de observación.
 * @param {*} instrument Valor de instrument utilizado por esta operación.
 * @param {Function} callback Operación que se invoca durante el procesamiento.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function isolatedRun(instrument, callback) {
  let invoked = false,
    value,
    failure,
    didThrow  = false;
  /**
   * Ejecuta once dentro del flujo de observer.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const once = () => {
    if (!invoked) {
      invoked = true;
      try {
        value = callback();
      } catch (error) {
        failure = error;
        didThrow = true;
      }
    }
    if (didThrow) throw failure;
    return value;
  };
  try {
    const observation = instrument(once);
    if (observation && typeof observation.catch === 'function')
      observation.catch(
        /**
         * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        () => {},
      );
  } catch {
    /* El resultado funcional pertenece al callback. */
  }
  return once();
}

/** Envuelve una implementación inyectada, con comportamiento inerte cuando no existe.
 * @param {*} observer Valor de observer utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createObserver(observer) {
  return {
    /**
     * Ejecuta captureCarrier dentro del flujo de observer.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    captureCarrier() {
      try {
        const carrier = observer?.captureCarrier?.() ?? null;
        validateTelemetry(carrier);
        return carrier === null
          ? null
          : {
              traceparent : carrier.traceparent,
              ...(carrier.tracestate === undefined ? {} : { tracestate: carrier.tracestate }),
            };
      } catch {
        return null;
      }
    },
    /**
     * Ejecuta runWithCarrier dentro del flujo de observer.
     * @param {*} carrier Valor de carrier utilizado por esta operación.
     * @param {Function} callback Operación que se invoca durante el procesamiento.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    runWithCarrier(carrier, callback) {
      return isolatedRun(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} run Valor de run utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (run) => observer?.runWithCarrier?.(carrier, run),
        callback,
      );
    },
    /**
     * Ejecuta suppress dentro del flujo de observer.
     * @param {Function} callback Operación que se invoca durante el procesamiento.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    suppress(callback) {
      return isolatedRun(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} run Valor de run utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (run) => observer?.suppress?.(run),
        callback,
      );
    },
    /**
     * Ejecuta completePublication dentro del flujo de observer.
     * @param {*} publicationId Valor de publicationId utilizado por esta operación.
     * @param {*} result Valor de result utilizado por esta operación.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    completePublication(publicationId, result) {
      try {
        observer?.completePublication?.(publicationId, result);
      } catch {
        /* No altera confirmaciones ni reintentos. */
      }
    },
    /**
     * Ejecuta beginOperation dentro del flujo de observer.
     * @param {*} kind Valor de kind utilizado por esta operación.
     * @param {*} metadata Valor de metadata utilizado por esta operación.
     * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    beginOperation(kind, metadata) {
      let operation,
        ended = false;
      try {
        operation = observer?.beginOperation?.(kind, metadata);
      } catch {
        /* Observación opcional. */
      }
      return {
        /**
         * Ejecuta run dentro del flujo de observer.
         * @param {Function} callback Operación que se invoca durante el procesamiento.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        run(callback) {
          return isolatedRun(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {*} run Valor de run utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (run) => operation?.run?.(run),
            callback,
          );
        },
        /**
         * Ejecuta end dentro del flujo de observer.
         * @param {*} result Valor de result utilizado por esta operación.
         * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        end(result) {
          if (ended) return;
          ended = true;
          try {
            operation?.end?.(result);
          } catch {
            /* Un fallo del exportador no cambia el transporte. */
          }
        },
      };
    },
  };
}

module.exports = { createObserver };
