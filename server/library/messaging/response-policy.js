/**
 * @file Contrato de respuesta de aplicación y clasificación de rechazos para solicitudes, comandos y
 * eventos.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
/**
 * Contrato de respuesta compartido por los servicios; los datos de aplicación se conservan sin
 * interpretar.
 */
const { MessagingError } = require('./errors');
const responseHelpers    = {
  /**
   * Construye la respuesta satisfactoria de aplicación con código, descripción y datos.
   *
   * @param {number|string} statusCode Código de estado que se incorpora a la respuesta de aplicación.
   * @param {Object} [data] Datos de entrada utilizados por la operación.
   * @returns {Object} Respuesta satisfactoria con código, descripción OK y datos.
   */
  successResponse : (statusCode, data = {}) => ({
    statusCode,
    descriptionCode : 'OK',
    data,
  }),
  /**
   * Construye una respuesta de error con el código y la descripción suministrados.
   *
   * @param {number|string} [statusCode] Código de estado que se incorpora a la respuesta de aplicación.
   * @param {string} [descriptionCode] Descripción estable del resultado de aplicación.
   * @returns {Object} Respuesta con código y descripción del error recibido.
   */
  errorResponse   : (statusCode = '', descriptionCode = '') => ({
    statusCode,
    descriptionCode,
  }),
};
const { errorResponse }  = responseHelpers;

/**
 * Ejecuta el controlador y normaliza su resultado; convierte fallos de comandos y eventos en errores
 * técnicos del transporte.
 *
 * @param {Function} controller Controlador de aplicación que recibe el mensaje adaptado.
 * @param {Object} message Mensaje que se procesa en esta ejecución.
 * @param {Object} execution Metadatos y contexto de la ejecución del manejador.
 * @returns {Promise<*>} Resultado del controlador normalizado para el tipo de mensaje procesado.
 * @throws {Error} La promesa se rechaza
 * ante APPLICATION_REJECTED.
 */
async function executeController(controller, message, execution) {
  let result;
  let transportError;
  try {
    result = await controller(message);
  } catch (error) {
    if (execution.kind !== 'request') {
      if (error instanceof MessagingError) transportError = error;
      else if (error?.uncertain === true) {
        transportError = new MessagingError(
          'EXECUTION_UNCERTAIN',
          'Application effect outcome uncertain',
          { uncertain: true },
        );
      } else if (!error?.statusCode) {
        transportError = new MessagingError(
          'HANDLER_FAILED',
          'Application handler outcome uncertain',
          { uncertain: true },
        );
      }
    }
    result =
      error && error.statusCode
        ? errorResponse(error.statusCode, error.descriptionCode || 'APPLICATION_ERROR')
        : errorResponse(500, 'INTERNAL_ERROR');
  }
  if (transportError) throw transportError;
  if (execution.kind !== 'request' && Number(result?.statusCode) >= 400) {
    throw new MessagingError('APPLICATION_REJECTED', 'Application handler rejected the message', {
      retryable : false,
    });
  }
  return result;
}

module.exports = {
  executeController,
  responseHelpers,
};
