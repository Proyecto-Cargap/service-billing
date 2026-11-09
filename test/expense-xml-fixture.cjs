/** @file XML recibido mínimo para pruebas semánticas; no representa validación criptográfica. */
'use strict';
/** @param {string} uuid Identidad fiscal de prueba. @returns {string} CFDI 4.0 de ingreso con IVA y RFC distintos para emisor/receptor. */
function expenseXml(uuid = '00000000-0000-4000-8000-000000000001') {
  return `<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="I" Fecha="2026-11-05T10:00:00" Moneda="MXN" SubTotal="100.00" Total="116.00"><cfdi:Emisor Rfc="AAA010101AAA"/><cfdi:Receptor Rfc="BBB010101BBB"/><cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" ClaveUnidad="E48" Descripcion="Servicio" Cantidad="1" ValorUnitario="100.00" Importe="100.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos><cfdi:Impuestos TotalImpuestosTrasladados="16.00"/><cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/></cfdi:Complemento></cfdi:Comprobante>`;
}
module.exports = { expenseXml };
