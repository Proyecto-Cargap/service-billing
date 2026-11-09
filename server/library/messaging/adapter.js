/**
 * @file Adaptación del mensaje de transporte al contrato que recibe cada controlador de aplicación.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { executeController } = require('./response-policy');

/**
 * Construye un manejador que transforma payload y contexto de ejecución en el mensaje esperado por el
 * controlador.
 *
 * @param {string} action Nombre de la acción que debe ejecutar el destinatario.
 * @param {Function} controller Controlador de aplicación que recibe el mensaje adaptado.
 * @param {Object} options3 Opciones y dependencias de esta operación.
 * @param {string} options3.service Identidad del servicio dentro del transporte.
 * @returns {Function} Manejador que acepta contenido y metadatos de ejecución del transporte.
 */
function adaptController(action, controller, { service }) {
  /**
   * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
   * @param {*} payload Valor de payload utilizado por esta operación.
   * @param {Object} execution Metadatos de la ejecución en curso.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  return (payload, execution) =>
    executeController(
      controller,
      {
        action,
        data          : payload,
        system        : execution.context,
        originService : execution.message.source,
        service,
      },
      execution,
    );
}

module.exports = { adaptController };
