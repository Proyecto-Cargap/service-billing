/** @file Espera cancelable por cambios o vencimientos conocidos, sin consultar persistencia. */
'use strict';

/** Coordina notificaciones sin perder una señal recibida antes de comenzar la espera. */
class WakeSignal {
  /** Inicializa la generación y las esperas activas. */
  constructor() {
    this.version = 0;
    this.waiters = new Set();
  }

  /** @returns {void} Despierta a todos los consumidores de la generación anterior. */
  notify() {
    this.version++;
    for (const finish of [...this.waiters]) finish();
  }

  /**
   * Espera una notificación, una cancelación o un vencimiento concreto.
   * @param {number} version Generación observada antes de consultar el estado.
   * @param {Object} options Señal de cierre y fecha absoluta opcional.
   * @returns {Promise<void>} Finaliza sin dejar listeners ni temporizadores activos.
   */
  wait(version, { signal, deadlineAt } = {}) {
    if (version !== this.version || signal?.aborted) return Promise.resolve();
    return new Promise(
      /** @param {Function} resolve Completa la espera. @returns {void} Registra una sola espera. */
      (resolve) => {
        let timer;
        /** @returns {void} Retira todos los recursos de esta espera. */
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          this.waiters.delete(finish);
          resolve();
        };
        this.waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (Number.isFinite(deadlineAt))
          timer = setTimeout(finish, Math.max(0, Math.min(2147483647, deadlineAt - Date.now())));
        if (version !== this.version || signal?.aborted) finish();
      },
    );
  }
}

module.exports = { WakeSignal };
