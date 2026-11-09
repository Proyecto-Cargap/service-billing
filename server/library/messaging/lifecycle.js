/**
 * @file Arranque y cierre coordinados de entradas, mensajería y base de datos, con un plazo común para
 * liberar recursos.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';

/**
 * Construye operaciones de arranque y cierre que comparten dependencias y evitan ejecuciones duplicadas.
 *
 * @param {Object} options Opciones y dependencias de esta operación.
 * @param {Object} options.messaging Interfaz de mensajería de la instancia.
 * @param {Object} options.database Adaptador de conexión y cierre de la base de datos.
 * @param {*} options.register Función que registra las operaciones después de abrir la conexión.
 * @param {Object} [options.logger] Receptor de registros técnicos de la operación.
 * @param {number} [options.shutdownMs] Plazo máximo del cierre coordinado, en milisegundos.
 * @returns {Object} Operaciones start, close e installShutdown que comparten el ciclo de vida.
 */
function createLifecycle({
  messaging,
  database,
  register,
  logger = console,
  shutdownMs = 30000,
  closeTelemetry,
  telemetryShutdownMs = 5000,
}) {
  let starting;
  let stopping;
  let stopIngress;
  let signalHandler;

  /**
   * Conecta la base de datos, registra manejadores y arranca mensajería respetando un cierre concurrente.
   * @returns {Promise<void>} Promesa compartida que finaliza cuando las dependencias están disponibles.
   */
  function start() {
    if (stopping) return Promise.reject(new Error('Service is stopping'));
    if (!starting)
      starting = (
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
         */
        async () => {
          const connection = await database.connect();
          if (stopping) throw new Error('Service is stopping');
          await register(connection);
          if (stopping) throw new Error('Service is stopping');
          await messaging.start({ connection });
          logger.info?.({
            component : 'service',
            event     : 'ready',
          });
        }
      )();
    return starting;
  }

  /**
   * Registra una sola vez las señales de terminación y la operación que detiene nuevas entradas.
   *
   * @param {Function} [closeIngress] Operación que deja de aceptar nuevas entradas durante el cierre.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  function installShutdown(
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
     */
    closeIngress = async () => {},
  ) {
    stopIngress = closeIngress;
    if (signalHandler || stopping) return;
    /**
     * Inicia el cierre al recibir una señal y marca el proceso con error si la liberación falla.
     * @returns {*} Resultado devuelto por close().catch con los argumentos preparados por la función.
     */
    signalHandler = () =>
      close()
        .catch(
          /**
           * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            process.exitCode = 1;
          },
        )
        .finally(
          /** @returns {void} Libera IPC del supervisor después del drenaje, incluso si algún cierre falló. */
          () => {
            if (process.connected && typeof process.disconnect === 'function') process.disconnect();
          },
        );
    process.once('SIGTERM', signalHandler);
    process.once('SIGINT', signalHandler);
  }

  /**
   * Detiene entradas, mensajería y base de datos con una fecha límite común y retira las señales
   * registradas.
   *
   * @param {Object} [options] Opciones y dependencias de esta operación.
   * @param {number} options.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<void>} Promesa compartida que finaliza al liberar recursos o vencer el plazo de
   * cierre.
   */
  function close({ deadlineAt: requestedDeadline } = {}) {
    if (stopping) return stopping;
    stopping = (
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
       */
      async () => {
        const totalDeadline = Math.min(
          requestedDeadline ?? Infinity,
          Date.now() + shutdownMs + (closeTelemetry ? telemetryShutdownMs : 0),
        );
        const deadlineAt    = Math.min(requestedDeadline ?? Infinity, Date.now() + shutdownMs);
        let ingressTimer;
        const ingress         = Promise.resolve().then(
          /**
           * Procesa el resultado de la operación asíncrona.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => stopIngress?.({ deadlineAt }),
        );
        const ingressDeadline = new Promise(
          /**
           * Coordina la resolución o el rechazo de la operación asíncrona.
           * @param {Function} resolve Continuación que confirma el resultado de la promesa.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (resolve) => {
            ingressTimer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
          },
        );
        try {
          await Promise.race([ingress, ingressDeadline]);
        } finally {
          clearTimeout(ingressTimer);
          /**
           * Las entradas, el transporte y la base de datos comparten una sola fecha límite de cierre.
           */
          try {
            await messaging.close({ deadlineAt });
          } finally {
            try {
              let databaseTimer;
              try {
                await Promise.race([
                  database.close({ force: Date.now() >= deadlineAt }),
                  new Promise(
                    /**
                     * Coordina la resolución o el rechazo de la operación asíncrona.
                     * @param {Function} resolve Continuación que confirma el resultado de la promesa.
                     * @returns {void} Finaliza después de aplicar los efectos de la operación.
                     */
                    (resolve) => {
                      databaseTimer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
                    },
                  ),
                ]);
              } finally {
                clearTimeout(databaseTimer);
              }
            } finally {
              let telemetryTimer;
              try {
                if (closeTelemetry)
                  await Promise.race([
                    Promise.resolve()
                      .then(
                        /**
                         * Procesa el resultado de la operación asíncrona.
                         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                         */
                        () =>
                          closeTelemetry({
                            deadlineAt : Math.min(totalDeadline, Date.now() + telemetryShutdownMs),
                          }),
                      )
                      .catch(
                        /**
                         * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
                         * @returns {void} Finaliza después de aplicar los efectos de la operación.
                         */
                        () => {},
                      ),
                    new Promise(
                      /**
                       * Coordina la resolución o el rechazo de la operación asíncrona.
                       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
                       * @returns {void} Finaliza después de aplicar los efectos de la operación.
                       */
                      (resolve) => {
                        telemetryTimer = setTimeout(
                          resolve,
                          Math.max(0, Math.min(totalDeadline - Date.now(), telemetryShutdownMs)),
                        );
                      },
                    ),
                  ]);
              } finally {
                clearTimeout(telemetryTimer);
                if (signalHandler) {
                  process.removeListener('SIGTERM', signalHandler);
                  process.removeListener('SIGINT', signalHandler);
                  signalHandler = undefined;
                }
              }
            }
          }
        }
      }
    )();
    return stopping;
  }

  return {
    start,
    close,
    installShutdown,
  };
}

module.exports = { createLifecycle };
