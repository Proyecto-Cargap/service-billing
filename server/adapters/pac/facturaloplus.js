/** @file Adaptador SOAP 1.1 FacturaLO PLUS con destinos fijos, límite de respuesta y resultado incierto explícito. */
'use strict';
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { ApplicationError }        = require('../../shared/application-error');
const ENDPOINTS                   = {
  development : 'https://dev.facturaloplus.com/ws/servicio.do',
  production  : 'https://app.facturaloplus.com/ws/servicio.do',
};
const METHODS                     = {
  timbrarJSON                       : ['apikey', 'jsonB64', 'keyPEM', 'cerPEM'],
  consultarCFDI                     : ['apikey', 'uuid'],
  consultarEstadoSAT                : ['apikey', 'uuid', 'rfcEmisor', 'rfcReceptor', 'total'],
  cancelarPEM                       : [
    'apikey',
    'keyPEM',
    'cerPEM',
    'uuid',
    'rfcEmisor',
    'rfcReceptor',
    'total',
    'motivo',
    'folioSustitucion',
  ],
  consultarAutorizacionesPendientes : ['apikey', 'keyPEM', 'cerPEM'],
  autorizarCancelacion              : ['apikey', 'keyPEM', 'cerPEM', 'uuid', 'respuesta'],
  consultarAcuse                    : ['apikey', 'uuid'],
  consultarCreditosDisponibles      : ['apikey'],
};
/** @param {string} value Texto. @returns {string} Texto XML sin interpretar entidades del usuario. */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
/** @param {string} xml Respuesta acotada. @returns {Object} Árbol sin DTD ni expansión externa. */
function parseXml(xml) {
  if (
    typeof xml !== 'string' ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new ApplicationError(502, 'BILLING_INVALID_PAC_RESPONSE', { uncertain: true });
  return new XMLParser({
    ignoreAttributes    : false,
    removeNSPrefix      : true,
    parseTagValue       : false,
    parseAttributeValue : false,
    trimValues          : false,
  }).parse(xml);
}
/** @param {Object} options Transporte y tiempo límite inyectados. @returns {Object} Puerto PAC sin reintentos automáticos. */
function facturaloplus({ fetch, timeoutMs }) {
  /** @param {string} environment Ambiente explícito. @param {string} method Operación conocida. @param {Object} input Parámetros del WSDL. @returns {Promise<Object>} Campos tipados de la respuesta SOAP. */
  async function call(environment, method, input) {
    if (!ENDPOINTS[environment] || !METHODS[method])
      throw new ApplicationError(400, 'BILLING_INVALID_PAC_OPERATION');
    const params = METHODS[method]
      .map(
        /** @param {string} name Parámetro WSDL. @returns {string} Elemento RPC tipado. */
        (name) => {
          if (input[name] === undefined)
            throw new ApplicationError(400, 'BILLING_MISSING_PAC_PARAMETER');
          return `<${name} xsi:type="xsd:${method === 'cancelarPEM' && name === 'total' ? 'double' : 'string'}">${escapeXml(input[name])}</${name}>`;
        },
      )
      .join('');
    const body   = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><m:${method} xmlns:m="urn:ws_api" soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">${params}</m:${method}></soap:Body></soap:Envelope>`;
    try {
      const response = await fetch(ENDPOINTS[environment], {
        method   : 'POST',
        redirect : 'error',
        headers  : {
          'Content-Type' : 'text/xml; charset=utf-8',
          SOAPAction     : `"urn:ServicioTimbradoWS#${method}"`,
        },
        body,
        signal   : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) throw new Error();
      const chunks = [];
      let size     = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      const soap = parseXml(Buffer.concat(chunks).toString('utf8')).Envelope?.Body;
      if (!soap || soap.Fault) throw new Error();
      const refs = new Map();
      /** @param {Object} node Nodo SOAP. @returns {void} Indexa referencias RPC sin seguir enlaces externos. */
      function index(node) {
        if (!node || typeof node !== 'object') return;
        if (node['@_id']) refs.set(node['@_id'], node);
        for (const value of Object.values(node)) if (typeof value === 'object') index(value);
      }
      index(soap);
      /** @param {*} node Valor SOAP. @returns {*} Resuelve únicamente referencias locales conocidas. */
      function resolve(node) {
        if (node?.['@_href']) return refs.get(node['@_href'].replace(/^#/, ''));
        return node;
      }
      const result = resolve(soap[method + 'Response']?.return);
      if (!result || typeof result !== 'object') throw new Error();
      const fields =
        method === 'consultarEstadoSAT'
          ? ['CodigoEstatus', 'EsCancelable', 'Estado', 'EstatusCancelacion']
          : [
              'code',
              'message',
              'data',
              ...(method === 'cancelarPEM' ? ['status'] : []),
              ...(method === 'consultarCreditosDisponibles' ? ['detail'] : []),
            ];
      const output = {};
      for (const field of fields) {
        const raw = resolve(result[field]),
          value   =
            raw && typeof raw === 'object'
              ? (raw['#text'] ?? (raw['@_type'] === 'xsd:string' ? '' : undefined))
              : raw;
        if (typeof value !== 'string') throw new Error();
        output[field] = value;
      }
      return output;
    } catch {
      throw new ApplicationError(502, 'BILLING_PAC_OUTCOME_UNKNOWN', { uncertain: true });
    }
  }
  return { call };
}
module.exports = {
  facturaloplus,
  parseXml,
  escapeXml,
};
