/** @file Proceso aislado con IPC de supervisor y recursos que se drenan al recibir SIGTERM. */
'use strict';
const { createLifecycle }   = require('../../server/library/messaging/lifecycle');
const { setTimeout: delay } = require('node:timers/promises');
process.on(
  'message',
  /** @returns {void} Conserva el canal IPC como un supervisor real. */ () => {},
);
const lifecycle = createLifecycle({
  database  : {
    /** @returns {Promise<void>} Cierre de persistencia simulado. */ async close() {
      await delay(10);
    },
  },
  messaging : {
    /** @returns {Promise<void>} Confirma que el trabajo pendiente termina antes de salir. */ async close() {
      await delay(20);
      if (process.env.SHUTDOWN_FAILURE === '1') throw new Error('CLOSE_FAILED');
      process.send('drained');
    },
  },
  /** @returns {void} El proceso de prueba no registra negocio. */ register() {},
  /** @returns {Promise<void>} Vacía el exportador después de los recursos funcionales. */ async closeTelemetry() {
    await delay(10);
    process.send('telemetry-closed');
  },
});
lifecycle.installShutdown();
process.send('ready');
