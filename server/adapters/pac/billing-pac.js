/** @file Traduce operaciones de aplicación al WSDL y abre credenciales sólo durante la llamada al PAC. */
'use strict';
const { normalizeCsd }                     = require('../crypto/billing-secrets');
const { decodeResult, discardProviderPdf } = require('./cfdi-result');
const { ApplicationError }                 = require('../../shared/application-error');
/** @param {Object} config Revisión privada de PAC. @returns {string} Vínculo de la cuenta y su ambiente. */
function pacBinding(config) {
  return `billing:pac:${config.environment}:${config.code}`;
}
/** @param {Object} issuer Emisor autorizado. @returns {string} Identidad autenticada del sobre de custodia. */
function binding(issuer) {
  return `billing:csd:${issuer.workspace}:${issuer.code}`;
}
/** @param {Object} options Puerto SOAP y custodia cifrada. @returns {Object} Capacidades PAC y de alta de secretos. */
function billingPac({ soap, secrets }) {
  /** @param {Object} issuer Emisor configurado. @param {string} method Operación WSDL. @param {Object} data Parámetros fiscales. @returns {Promise<Object>} Respuesta sin credenciales. */
  async function call(issuer, method, data = {}) {
    const config = issuer.pacConfig;
    if (!config) throw new ApplicationError(409, 'BILLING_PAC_NOT_CONFIGURED');
    const account  = secrets.open(config.secretEnvelope, pacBinding(config));
    const needsCsd = [
      'timbrarJSON',
      'cancelarPEM',
      'consultarAutorizacionesPendientes',
      'autorizarCancelacion',
    ].includes(method);
    const csd      = needsCsd ? secrets.open(issuer.csdEnvelope, binding(issuer)) : {};
    return discardProviderPdf(
      await soap.call(config.environment, method, {
        apikey : account.apiKey,
        ...csd,
        ...data,
      }),
    );
  }
  return {
    decodeResult,
    /** @param {Object} previous Emisor con custodia acreditada. @param {Object} next Nueva asignación del mismo emisor. @returns {string} CSD recifrado sin divulgar secretos ni modificar el original. */
    rebindCsd(previous, next) {
      return secrets.seal(secrets.open(previous.csdEnvelope, binding(previous)), binding(next));
    },
    /** @param {string|undefined} envelope Reemplazo cifrado por Gateway. @param {string} environment Ambiente elegido. @param {string} code Nueva revisión. @param {Object|null} previous Cuenta previa. @returns {string} Clave cifrada y ligada a su revisión privada. */
    preparePac(envelope, environment, code, previous) {
      const value = envelope
        ? secrets.open(envelope, `billing:pac:${environment}:request`)
        : previous
          ? secrets.open(previous.secretEnvelope, pacBinding(previous))
          : null;
      if (!value || typeof value.apiKey !== 'string' || !/^[A-Za-z0-9]{32}$/.test(value.apiKey))
        throw new ApplicationError(400, 'BILLING_INVALID_PAC_CREDENTIALS');
      return secrets.seal(
        { apiKey: value.apiKey },
        pacBinding({
          environment,
          code,
        }),
      );
    },
    /** @param {string} envelope Sobre sellado por Gateway. @param {Object} issuer Propietario. @param {number} now Reloj. @returns {Object} Credenciales normalizadas y cifradas para persistir. */
    prepareCsd(envelope, issuer, now) {
      const result = normalizeCsd(
        secrets.open(envelope, binding(issuer) + ':request'),
        issuer.taxId,
        now,
      );
      return {
        csdEnvelope : secrets.seal(result.credentials, binding(issuer)),
        certificate : result.certificate,
      };
    },
    /** @param {Object} issuer Emisor. @param {Object} layout JSON fiscal. @returns {Promise<Object>} Respuesta durable antes de acreditación. */
    issue(issuer, layout) {
      return call(issuer, 'timbrarJSON', {
        jsonB64 : Buffer.from(JSON.stringify(layout)).toString('base64'),
      });
    },
    /** @param {Object} issuer Emisor. @param {string} uuid Identidad fiscal. @returns {Promise<Object>} XML recuperado desde el mismo ambiente. */
    recover(issuer, uuid) {
      return call(issuer, 'consultarCFDI', { uuid });
    },
    /** @param {Object} issuer Emisor. @param {Object} document CFDI. @returns {Promise<Object>} Estado SAT, sin inferir cancelación desde el acuse de recepción. */
    status(issuer, document) {
      return call(issuer, 'consultarEstadoSAT', {
        uuid        : document.uuid,
        rfcEmisor   : document.issuerSnapshot.taxId,
        rfcReceptor : document.customerSnapshot.fiscal.taxId,
        total       : document.total,
      });
    },
    /** @param {Object} issuer Emisor. @param {Object} document CFDI. @param {Object} operation Solicitud de cancelación. @returns {Promise<Object>} Acuse de recepción o error. */
    cancel(issuer, document, operation) {
      return call(issuer, 'cancelarPEM', {
        uuid             : document.uuid,
        rfcEmisor        : document.issuerSnapshot.taxId,
        rfcReceptor      : document.customerSnapshot.fiscal.taxId,
        total            : document.total,
        motivo           : operation.input.reason,
        folioSustitucion : operation.replacementUuid || '',
      });
    },
    /** @param {Object} issuer Emisor. @param {string} uuid UUID. @returns {Promise<Object>} Acuse recuperable. */
    ack(issuer, uuid) {
      return call(issuer, 'consultarAcuse', { uuid });
    },
    /** @param {Object} config Cuenta global. @returns {Promise<Object>} Créditos de la cuenta del ambiente. */
    credits(config) {
      return call({ pacConfig: config }, 'consultarCreditosDisponibles');
    },
    /** @param {Object} issuer Receptor. @returns {Promise<Object>} Solicitudes pendientes. */
    pending(issuer) {
      return call(issuer, 'consultarAutorizacionesPendientes');
    },
    /** @param {Object} issuer Receptor. @param {Object} input UUID y aceptación. @returns {Promise<Object>} Resultado de la respuesta a cancelación. */
    authorize(issuer, input) {
      return call(issuer, 'autorizarCancelacion', {
        uuid      : input.uuid,
        respuesta : input.accept ? 'Aceptar' : 'Rechazar',
      });
    },
  };
}
module.exports = {
  billingPac,
  binding,
  pacBinding,
};
