/** @file Regresión de cierre bajo supervisor: IPC no retiene un trabajador ya drenado ni requiere SIGKILL. */
'use strict';
const test     = require('node:test');
const assert   = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path     = require('node:path');
for (const failure of [false, true]) {
  test(
    `el cierre libera IPC después del drenaje; fallo=${failure}`,
    { timeout: 5000 },
    /** @param {Object} t Prueba con limpieza propia. @returns {Promise<void>} El hijo termina por sí mismo conservando su código de salida. */ async (
      t,
    ) => {
      const child = fork(path.join(__dirname, 'helpers/shutdown-child.cjs'), [], {
        env   : {
          ...process.env,
          SHUTDOWN_FAILURE : failure ? '1' : '0',
        },
        stdio : ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      t.after(
        /** @returns {void} Sólo elimina el hijo de esta prueba cuando ésta falla. */ () => {
          if (child.exitCode === null) child.kill('SIGKILL');
        },
      );
      const messages = [];
      child.on(
        'message',
        /** @param {string} message Estado técnico. @returns {void} Conserva el orden de cierre. */ (
          message,
        ) => messages.push(message),
      );
      const exited  = once(child, 'exit');
      const [ready] = await once(child, 'message');
      assert.equal(ready, 'ready');
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, failure ? 1 : 0);
      assert.deepEqual(
        messages,
        failure ? ['ready', 'telemetry-closed'] : ['ready', 'drained', 'telemetry-closed'],
      );
    },
  );
}
