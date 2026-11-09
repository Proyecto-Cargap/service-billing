/** @file Ejecuta trabajo durable exclusivamente por cambios confirmados o vencimientos conocidos. */
'use strict';
const { WakeSignal } = require('../messaging/wake-signal');

/**
 * Coordina una cola sin sondeos en reposo; el repositorio conserva reclamación y fencing.
 * @param {Object} options Fuente de cambios, siguiente vencimiento, procesamiento y logger.
 * @returns {Object} Ciclo de vida independiente de las conexiones compartidas.
 */
function createReactiveWorker({
  source,
  nextAt,
  tick,
  logger,
  component,
  enabled = true,
  retryMs = 1000,
}) {
  const signal = new WakeSignal();
  let controller, running;
  /** @returns {Promise<void>} Drena vencimientos; espera indefinidamente cuando no hay pendientes. */
  async function run() {
    while (!controller.signal.aborted) {
      const version = signal.version;
      try {
        if (!source.ready) {
          await signal.wait(version, { signal: controller.signal });
          continue;
        }
        const deadlineAt = await nextAt();
        if (controller.signal.aborted) break;
        if (!source.ready) continue;
        if (Number.isFinite(deadlineAt) && deadlineAt <= Date.now()) {
          await tick({
            /** @returns {boolean} Interrumpe un lote entre efectos al cerrar o perder el stream. */
            shouldStop : () => controller.signal.aborted || !source.ready,
          });
          continue;
        }
        await signal.wait(version, {
          signal : controller.signal,
          deadlineAt,
        });
      } catch {
        if (controller.signal.aborted) break;
        logger.error({
          component,
          event : 'work_unavailable',
        });
        // Reintento de una operación fallida, nunca una consulta de actualización en reposo.
        await signal.wait(signal.version, {
          signal     : controller.signal,
          deadlineAt : Date.now() + retryMs,
        });
      }
    }
  }
  return {
    /** @returns {void} Abre primero el stream; el procesamiento espera su confirmación. */
    start() {
      if (!enabled || running) return;
      controller = new AbortController();
      source.start(
        /** @returns {void} Notifica cambios, disponibilidad y recuperación sin perder señales. */
        () => signal.notify(),
      );
      running = run();
    },
    /**
     * Cancela espera y stream, respetando el plazo de un efecto externo ya iniciado.
     * @param {Object} options Deadline compartido del proceso.
     * @returns {Promise<void>} No reclama trabajo después del cierre.
     */
    async close({ deadlineAt = Date.now() + 30000 } = {}) {
      if (!running) return;
      controller.abort();
      let timer;
      const ending = Promise.all([source.close(), running]).then(
        /** @returns {void} Permite reiniciar sólo después de liberar todos los recursos propios. */
        () => {
          running = undefined;
        },
      );
      try {
        await Promise.race([
          ending,
          new Promise(
            /** @param {Function} resolve Continuación de cierre. @returns {void} Agenda sólo el límite conocido. */
            (resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
            },
          ),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
module.exports = { createReactiveWorker };
