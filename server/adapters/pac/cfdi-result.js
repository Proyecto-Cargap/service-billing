/** @file Acredita la identidad y contenido del XML devuelto por el PAC antes de registrar un efecto fiscal. */
'use strict';
const { parseXml }         = require('./facturaloplus');
const { Decimal }          = require('../../modules/billing/services/amounts.service');
const { ApplicationError } = require('../../shared/application-error');
const NUMERIC              = new Set([
  'Cantidad',
  'ValorUnitario',
  'Importe',
  'Base',
  'Descuento',
  'SubTotal',
  'Total',
  'TipoCambio',
  'TasaOCuota',
  'TotalImpuestosTrasladados',
  'TotalImpuestosRetenidos',
  'EquivalenciaDR',
  'ImpSaldoAnt',
  'ImpPagado',
  'ImpSaldoInsoluto',
  'Monto',
  'TipoCambioP',
  'BaseDR',
  'ImporteDR',
  'TasaOCuotaDR',
  'BaseP',
  'ImporteP',
  'TasaOCuotaP',
]);
/** @param {*} value Nodo único o repetido. @returns {Object[]} Colección normalizada. */
function array(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
/** @param {Object} expected Atributos preparados antes de timbrar. @param {Object} actual Nodo del XML. @returns {void} Rechaza cambios semánticos sin imponer formato decimal del proveedor. */
function attributes(expected, actual) {
  if (!actual) throw new Error();
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value !== 'string') continue;
    const received = actual['@_' + key];
    if (typeof received !== 'string') throw new Error();
    if (NUMERIC.has(key) || key.startsWith('Total') || key === 'MontoTotalPagos') {
      if (!new Decimal(value).eq(received)) throw new Error();
    } else if (value !== received) throw new Error();
  }
}
/** @param {Object|undefined} expected Impuestos esperados. @param {Object|undefined} actual Nodo XML. @param {string} suffix Sufijo de complemento. @returns {void} Verifica direcciones, cardinalidad y valores fiscales. */
function taxes(expected, actual, suffix = '') {
  if (!expected) {
    if (actual && Object.keys(actual).length) throw new Error();
    return;
  }
  attributes(expected, actual);
  for (const [plural, singular] of [
    ['Traslados', 'Traslado'],
    ['Retenciones', 'Retencion'],
  ]) {
    const wanted = expected[plural + suffix] || [],
      received   = array(actual?.[plural + suffix]?.[singular + suffix]);
    if (wanted.length !== received.length) throw new Error();
    for (let index = 0; index < wanted.length; index++) attributes(wanted[index], received[index]);
  }
}
/** @param {string} xml CFDI completo. @param {Object} layout Layout persistido antes del envío. @param {string} requestedUuid UUID esperado cuando se concilia. @returns {Object} XML e identidad fiscal acreditados. */
function verifyCfdi(xml, layout, requestedUuid = '') {
  try {
    const cfdi = parseXml(xml).Comprobante,
      expected = layout.Comprobante;
    attributes(expected, cfdi);
    attributes(expected.Emisor, cfdi.Emisor);
    attributes(expected.Receptor, cfdi.Receptor);
    const stamp = cfdi.Complemento?.TimbreFiscalDigital,
      uuid      = stamp?.['@_UUID'];
    if (
      !/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(uuid || '') ||
      !stamp['@_SelloSAT'] ||
      !stamp['@_SelloCFD'] ||
      cfdi['@_Sello'] !== stamp['@_SelloCFD'] ||
      !/^\d{20}$/.test(stamp['@_NoCertificadoSAT'] || '') ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(stamp['@_FechaTimbrado'] || '') ||
      !/^[A-Z&Ñ]{3}\d{6}[A-Z0-9]{3}$/.test(stamp['@_RfcProvCertif'] || '') ||
      stamp['@_Version'] !== '1.1' ||
      (requestedUuid && requestedUuid.toUpperCase() !== uuid.toUpperCase())
    )
      throw new Error();
    const concepts = array(cfdi.Conceptos?.Concepto);
    if (concepts.length !== expected.Conceptos.length) throw new Error();
    for (let index = 0; index < concepts.length; index++) {
      attributes(expected.Conceptos[index], concepts[index]);
      taxes(expected.Conceptos[index].Impuestos, concepts[index].Impuestos);
    }
    taxes(expected.Impuestos, cfdi.Impuestos);
    if (expected.InformacionGlobal) attributes(expected.InformacionGlobal, cfdi.InformacionGlobal);
    if (expected.CfdiRelacionados) {
      attributes(expected.CfdiRelacionados, cfdi.CfdiRelacionados);
      const related = array(cfdi.CfdiRelacionados.CfdiRelacionado);
      if (related.length !== expected.CfdiRelacionados.CfdiRelacionado.length) throw new Error();
      for (let index = 0; index < related.length; index++)
        if (
          related[index]['@_UUID'].toUpperCase() !==
          expected.CfdiRelacionados.CfdiRelacionado[index].toUpperCase()
        )
          throw new Error();
    }
    if (expected.TipoDeComprobante === 'P') {
      const payments = expected.Complemento[0].Pagos20,
        received     = cfdi.Complemento.Pagos;
      attributes(payments, received);
      attributes(payments.Totales, received.Totales);
      const paid = array(received.Pago);
      if (paid.length !== payments.Pago.length) throw new Error();
      for (let index = 0; index < paid.length; index++) {
        const wanted = payments.Pago[index];
        attributes(wanted, paid[index]);
        taxes(wanted.ImpuestosP, paid[index].ImpuestosP, 'P');
        const applied = array(paid[index].DoctoRelacionado);
        if (applied.length !== wanted.DoctoRelacionado.length) throw new Error();
        for (let offset = 0; offset < applied.length; offset++) {
          attributes(wanted.DoctoRelacionado[offset], applied[offset]);
          taxes(wanted.DoctoRelacionado[offset].ImpuestosDR, applied[offset].ImpuestosDR, 'DR');
        }
      }
    }
    return {
      uuid : uuid.toUpperCase(),
      xml,
    };
  } catch {
    throw new ApplicationError(502, 'BILLING_PAC_DOCUMENT_MISMATCH', { uncertain: true });
  }
}
/** @param {Object} response Respuesta SOAP persistida. @param {Object} layout Layout esperado. @param {string} uuid UUID de consulta. @returns {Object} Archivos e identidad, nunca sólo una bandera de éxito del proveedor. */
function decodeResult(response, layout, uuid = '') {
  try {
    let xml;
    if (response.data.trim().startsWith('<')) xml = response.data;
    else {
      const data = JSON.parse(response.data);
      xml = data.xml || data.XML;
      if (typeof xml === 'string' && !xml.trim().startsWith('<'))
        xml = Buffer.from(xml, 'base64').toString('utf8');
    }
    return {
      ...verifyCfdi(xml, layout, uuid),
    };
  } catch {
    throw new ApplicationError(502, 'BILLING_PAC_DOCUMENT_MISMATCH', { uncertain: true });
  }
}
/** @param {Object} response Respuesta del proveedor. @returns {Object} Evidencia fiscal sin adjuntos PDF ajenos a la plataforma. */
function discardProviderPdf(response) {
  if (typeof response.data !== 'string' || response.data.trim().startsWith('<')) return response;
  try {
    const data = JSON.parse(response.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
    for (const key of Object.keys(data)) if (key.toLowerCase() === 'pdf') delete data[key];
    return {
      ...response,
      data : JSON.stringify(data),
    };
  } catch {
    return response;
  }
}
module.exports = {
  verifyCfdi,
  decodeResult,
  discardProviderPdf,
};
