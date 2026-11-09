/** @file Preferencias y vencimiento de consultas externas, sin temporizadores ni acceso a proveedores. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object|null} value Preferencia explícita. @returns {Object} Consulta desactivada por defecto con intervalo acotado. */
function refreshValue(value) {
  if (value == null)
    return {
      enabled         : false,
      intervalSeconds : 60,
    };
  if (
    typeof value.enabled !== 'boolean' ||
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds < 60 ||
    value.intervalSeconds > 86400
  ) {
    throw new ApplicationError(400, 'BILLING_EXTERNAL_REFRESH_INVALID');
  }
  return {
    enabled         : value.enabled,
    intervalSeconds : value.intervalSeconds,
  };
}
/** @param {Object|null} record Cuenta global. @returns {Object} Preferencias independientes sin credenciales. */
function refreshEnvironments(record) {
  return {
    development : refreshValue(record?.externalRefreshByEnvironment?.development),
    production  : refreshValue(record?.externalRefreshByEnvironment?.production),
  };
}
/** @param {Object} document Estado fiscal persistido. @param {Object} preference Configuración vigente. @returns {number|undefined} Vencimiento concreto o ausencia de trabajo habilitado. */
function refreshDeadline(document, preference) {
  if (
    !preference?.enabled ||
    document.status !== 'cancel-requested' ||
    document.activeOperation ||
    document.externalRefreshBlocked
  )
    return undefined;
  return Math.max(
    Math.max(
      document.sat?.checkedAt || document.creationDate || 0,
      document.externalRefreshLastStartedAt || 0,
      preference.changedAt || 0,
    ) +
      preference.intervalSeconds * 1000,
    document.externalRefreshRetryAt || 0,
  );
}
module.exports = {
  refreshValue,
  refreshEnvironments,
  refreshDeadline,
};
