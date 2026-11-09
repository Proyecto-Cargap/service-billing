/** @file Conecta agendas independientes de operaciones fiscales y limpieza documental a Change Streams. */
'use strict';
const { createReactiveWorker } = require('../../../library/work/reactive-worker');
const { createMongoChanges }   = require('../../../library/work/mongo-changes');
/** @param {Object} options Conexión abierta, repositorio, casos de uso y logger. @returns {Object} Ciclo de vida coordinado sin bloquear limpieza por latencia del PAC. */
function billingWorkers({ connection, store, services, logger }) {
  const workers = [
    {
      component   : 'billing-operations',
      collections : ['BILLING_OPERATION', 'BILLING_DOCUMENT', 'BILLING_PAC'],
      nextAt      : services.effects.nextAt,
      tick        : services.effects.tick,
    },
    {
      component   : 'billing-cleanup',
      collections : ['BILLING_EXPENSE_FILE_JOB'],
      nextAt      : store.nextExpenseCleanupAt,
      tick        : services.expenseAttachments.tick,
    },
  ].map(
    /** @param {Object} definition Capacidad mínima de cada agenda. @returns {Object} Trabajador detenido con fuente propia. */
    (definition) =>
      createReactiveWorker({
        ...definition,
        logger,
        source : createMongoChanges({
          connection,
          collections : definition.collections,
          logger,
          component   : definition.component,
        }),
      }),
  );
  return {
    /** @returns {void} Inicia cursores antes de reclamar pendientes. */
    start() {
      for (const worker of workers) worker.start();
    },
    /** @param {Object} options Plazo de cierre. @returns {Promise<void>} Libera ambas fuentes antes de cerrar MongoDB. */
    async close(options) {
      const results = await Promise.allSettled(
        workers.map(
          /** @param {Object} worker Procesador propio. @returns {Promise<void>} Cierre independiente. */
          (worker) => worker.close(options),
        ),
      );
      const failure = results.find(
        /** @param {Object} result Resultado de cierre. @returns {boolean} Fallo que se propaga después de cerrar ambos. */
        (result) => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
  };
}
module.exports = { billingWorkers };
