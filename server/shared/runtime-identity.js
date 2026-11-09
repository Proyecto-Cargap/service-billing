/** @file Identidad aislada por proyecto y ambiente, sin valores de cliente implícitos. */
'use strict';
/**
 * Ejecuta runtimeIdentity dentro del flujo de runtime-identity.
 * @param {*} [env] Valor de env utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function runtimeIdentity(env = process.env) {
  const id          = env.PLATFORM_ID;
  const environment = env.ENV_NAME;
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(id) ||
    !['development', 'test', 'prod'].includes(environment)
  )
    throw new Error('PLATFORM_ID_AND_ENV_NAME_REQUIRED');
  return {
    id,
    environment,
    namespace : `${id}.${environment}`,
  };
}
module.exports = { runtimeIdentity };
