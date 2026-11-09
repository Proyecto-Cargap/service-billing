/** @file Carga el entorno compartido antes de importar telemetría o drivers. */
'use strict';
const fs   = require('node:fs');
const path = require('node:path');
/**
 * Resuelve loadEnvironment aplicando los filtros y colaboradores del módulo.
 * @returns {void} Finaliza después de aplicar los efectos de la operación.
 */
function loadEnvironment() {
  const files = [
    process.env.ENV_FILE,
    process.env.SERVICE_ENV_FILE,
    process.env.BILLING_ENV_FILE,
  ].filter(Boolean);
  if (
    files.some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {*} file Valor de file utilizado por esta operación.
       * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (file) => !path.isAbsolute(file),
    ) ||
    new Set(files).size > 1
  )
    throw new Error('ENV_FILE_MUST_BE_ONE_ABSOLUTE_PATH');
  const file = files[0] || path.resolve(__dirname, '../../../.env');
  if (files.length || fs.existsSync(file)) process.loadEnvFile(file);
}
module.exports = { loadEnvironment };
