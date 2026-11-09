/** @file Error de aplicación con código público estable y causa interna no serializada. */
'use strict';

class ApplicationError extends Error {
  /**
   * @param {number} statusCode Código público de error entre 400 y 599.
   * @param {string} descriptionCode Descripción pública estable; nunca texto de una excepción externa.
   * @param {Object} [options] Causa interna y uncertain cuando un efecto externo pudo completarse.
   */
  constructor(statusCode = 500, descriptionCode = 'INTERNAL_ERROR', options) {
    super(descriptionCode, options);
    this.name = 'ApplicationError';
    this.statusCode =
      Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    this.descriptionCode = descriptionCode;
    if (options?.uncertain === true) this.uncertain = true;
  }

  /** Expone únicamente el contrato público, sin stack, causa ni propiedades técnicas.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  toJSON() {
    return {
      statusCode      : this.statusCode,
      descriptionCode : this.descriptionCode,
    };
  }
}

module.exports = { ApplicationError };
