/** @file Carga entorno y telemetría antes de importar los adaptadores de la aplicación. */
'use strict';
require('./shared/runtime-environment').loadEnvironment();
require('./shared/runtime-identity').runtimeIdentity();
const telemetry = require('./telemetry');
telemetry.start();
const bootstrap = require('./bootstrap');
bootstrap.start().catch(
  /**
   * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async () => {
    telemetry.logger.error({
      component : 'service',
      event     : 'startup_failed',
      code      : 'STARTUP_FAILED',
    });
    await bootstrap.close().catch(
      /**
       * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {},
    );
    process.exitCode = 1;
  },
);
