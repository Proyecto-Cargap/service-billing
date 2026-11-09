/**
 * @file Errores técnicos del transporte y metadatos que permiten decidir si una operación es reintentable
 * o incierta.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';

/**
 * Agrupa el estado y las operaciones de errores técnicos.
 */
class MessagingError extends Error {
  /**
   * Conserva el código y las propiedades de reintento e incertidumbre de un error técnico.
   *
   * @param {string} code Código o modalidad utilizado por esta operación.
   * @param {string} [message] Descripción interna que conserva la excepción para diagnóstico.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   */
  constructor(code, message = code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'MessagingError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.uncertain = options.uncertain === true;
  }
}

/**
 * Extrae únicamente código y clasificación del fallo para evitar propagar mensajes internos de
 * excepciones.
 *
 * @param {Error|Object} error Fallo que se clasifica, registra o propaga.
 * @returns {Object} Código y atributos de reintento e incertidumbre, sin mensajes internos de excepción.
 */
function errorMetadata(error) {
  return {
    code      : error instanceof MessagingError ? error.code : 'HANDLER_FAILED',
    retryable : error instanceof MessagingError && error.retryable,
    uncertain : error instanceof MessagingError && error.uncertain,
  };
}

module.exports = {
  MessagingError,
  errorMetadata,
};
