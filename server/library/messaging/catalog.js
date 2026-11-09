/**
 * @file Registro de acciones, suscripciones y comprobación de salud a partir del catálogo suministrado
 * por el servicio.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { adaptController } = require('./adapter');

/**
 * Registra la acción técnica de salud y adapta cada entrada del catálogo como acción o suscripción.
 *
 * @param {Object} messaging Interfaz de mensajería de la instancia.
 * @param {Object} options2 Opciones y dependencias de esta operación.
 * @param {Object} options2.connection Conexión de base de datos o transporte utilizada por el módulo.
 * @param {Object[]} options2.catalog Definiciones de acciones y eventos propias del servicio.
 * @param {Function} options2.health Operación que calcula la salud técnica de las dependencias.
 * @param {string} options2.service Identidad del servicio dentro del transporte.
 * @returns {void} Finaliza después de aplicar los efectos de esta operación.
 */
function registerCatalog(messaging, { connection, catalog, health, service }) {
  messaging.registerAction({
    name      : 'health',
    version   : 1,
    execution : 'nonTransactional',
    retrySafe : true,
    /**
     * Atiende el mensaje con el contrato y las reglas de la operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    handler   : () => health(connection, messaging),
  });
  /**
   * Recorre los registros afectados y aplica a cada uno la transición de estado correspondiente.
   */
  for (const entry of catalog) {
    const registration = {
      name      : entry.name,
      version   : 1,
      execution : 'nonTransactional',
      retrySafe : false,
      handler   : adaptController(entry.name, entry.handler, { service }),
    };
    if (entry.kind === 'event') messaging.subscribe(registration);
    else messaging.registerAction(registration);
  }
}

module.exports = { registerCatalog };
