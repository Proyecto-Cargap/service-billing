/** @file XML sintético para acreditar contratos y PDF locales sin validez fiscal. */
'use strict';
const { XMLBuilder } = require('fast-xml-parser');
/** @param {Object} layout Layout ya preparado. @param {string} uuid Identidad de prueba. @returns {string} XML sintético con estructuras CFDI y sello ficticio; no tiene validez fiscal. */
function xmlFixture(layout, uuid) {
  /** @param {Object} input Nodo del layout. @returns {Object} Atributos y contenedores del XML equivalente. */
  function node(input) {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') output['@_' + key] = value;
      else if (key === 'Conceptos') output.Conceptos = { Concepto: value.map(node) };
      else if (
        [
          'Traslados',
          'Retenciones',
          'TrasladosP',
          'RetencionesP',
          'TrasladosDR',
          'RetencionesDR',
        ].includes(key)
      ) {
        const singular = key.replace('Traslados', 'Traslado').replace('Retenciones', 'Retencion');
        output[key] = { [singular]: value.map(node) };
      } else if (key === 'CfdiRelacionado')
        output[key] = value.map(
          /** @param {string} id UUID. @returns {Object} Atributo firmado. */ (id) => ({
            '@_UUID' : id,
          }),
        );
      else if (key === 'Complemento') output.Complemento = { Pagos: node(value[0].Pagos20) };
      else output[key] = Array.isArray(value) ? value.map(node) : node(value);
    }
    return output;
  }
  const cfdi = node(layout.Comprobante);
  cfdi['@_Sello'] = 'SELLO-SINTETICO-12345678';
  cfdi['@_NoCertificado'] = '30001000000500003416';
  cfdi.Complemento ||= {};
  cfdi.Complemento.TimbreFiscalDigital = {
    '@_Version'          : '1.1',
    '@_UUID'             : uuid,
    '@_SelloCFD'         : cfdi['@_Sello'],
    '@_SelloSAT'         : 'SELLO-SAT-SINTETICO',
    '@_FechaTimbrado'    : '2026-10-22T06:01:00',
    '@_RfcProvCertif'    : 'AAA010101AAA',
    '@_NoCertificadoSAT' : '30001000000500003416',
  };
  return new XMLBuilder({ ignoreAttributes: false }).build({ Comprobante: cfdi });
}
module.exports = { xmlFixture };
