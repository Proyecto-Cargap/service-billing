/** @file Proyección imprimible del XML fiscal ya acreditado; Documents conserva renderizado, QR y temporales. */
'use strict';
const { parseXml } = require('../pac/facturaloplus');
const { amount }   = require('../../modules/billing/services/amounts.service');
/** @param {*} value Nodo XML singular o repetido. @returns {Object[]} Nodos en orden fiscal. */
function array(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
/** @param {Object} node Nodo XML. @param {string} key Atributo. @returns {string} Texto fiscal original sin interpretación HTML. */
function attr(node, key) {
  return String(node?.['@_' + key] || '');
}
/** @param {Object} document CFDI persistido. @param {string} xml XML verificado contra el layout. @returns {Object} Vista serializable con tablas, metadatos, sellos y enlace SAT. */
function billingPrintView(document, xml) {
  const cfdi = parseXml(xml).Comprobante,
    tfd      = cfdi.Complemento.TimbreFiscalDigital;
  const sections = [],
    tables       = [];
  /** @param {string} title Encabezado. @param {Object} values Etiquetas y valores. @returns {void} Añade una sección omitiendo atributos opcionales ausentes. */
  function section(title, values) {
    const rows = [];
    for (const [label, value] of Object.entries(values))
      if (value !== '' && value !== undefined)
        rows.push({
          label,
          value : String(value),
        });
    sections.push({
      title,
      rows,
    });
  }
  section('Comprobante', {
    Versión               : attr(cfdi, 'Version'),
    Tipo                  : attr(cfdi, 'TipoDeComprobante'),
    'Folio fiscal'        : document.uuid,
    Expedición            : attr(cfdi, 'Fecha'),
    'Lugar de expedición' : attr(cfdi, 'LugarExpedicion'),
    Moneda                : attr(cfdi, 'Moneda'),
    'Tipo de cambio'      : attr(cfdi, 'TipoCambio'),
    'Método de pago'      : attr(cfdi, 'MetodoPago'),
    'Forma de pago'       : attr(cfdi, 'FormaPago'),
    Exportación           : attr(cfdi, 'Exportacion'),
  });
  for (const [key, label] of [
    ['Emisor', 'Emisor'],
    ['Receptor', 'Receptor'],
  ])
    section(label, {
      RFC                : attr(cfdi[key], 'Rfc'),
      Nombre             : attr(cfdi[key], 'Nombre'),
      'Régimen fiscal'   : attr(
        cfdi[key],
        key === 'Emisor' ? 'RegimenFiscal' : 'RegimenFiscalReceptor',
      ),
      'Domicilio fiscal' : attr(cfdi[key], 'DomicilioFiscalReceptor'),
      'Uso CFDI'         : attr(cfdi[key], 'UsoCFDI'),
    });
  if (cfdi.InformacionGlobal)
    section('Información global', {
      Periodicidad : attr(cfdi.InformacionGlobal, 'Periodicidad'),
      Meses        : attr(cfdi.InformacionGlobal, 'Meses'),
      Año          : attr(cfdi.InformacionGlobal, 'Año'),
    });
  const concepts = array(cfdi.Conceptos.Concepto),
    rows         = [];
  for (const [index, line] of concepts.entries())
    rows.push([
      String(index + 1),
      ...[
        'ClaveProdServ',
        'Descripcion',
        'Cantidad',
        'ClaveUnidad',
        'ValorUnitario',
        'Descuento',
        'Importe',
        'ObjetoImp',
      ].map(
        /** @param {string} key Atributo del concepto. @returns {string} Valor textual del XML. */
        (key) => attr(line, key),
      ),
    ]);
  tables.push({
    title   : 'Conceptos',
    headers : [
      'Partida',
      'Clave SAT',
      'Descripción',
      'Cantidad',
      'Unidad',
      'Precio',
      'Descuento',
      'Importe',
      'Objeto',
    ],
    rows,
  });
  /** @param {Object} node Impuestos XML. @param {string} suffix Sufijo del complemento. @returns {string[][]} Traslados y retenciones originales sin recalcular ni agrupar importes. */
  function taxRows(node, suffix) {
    if (!node) return [];
    const rows = [];
    for (const [group, singular, label] of [
      ['Traslados', 'Traslado', 'Traslado'],
      ['Retenciones', 'Retencion', 'Retención'],
    ])
      for (const tax of array(node[group + suffix]?.[singular + suffix]))
        rows.push([
          label,
          ...['Impuesto', 'Base', 'TipoFactor', 'TasaOCuota', 'Importe'].map(
            /** @param {string} key Atributo. @returns {string} Dato firmado del impuesto. */
            (key) => attr(tax, key + suffix),
          ),
        ]);
    return rows;
  }
  /** @param {Object} node Impuestos XML. @param {string} suffix Sufijo. @param {string} title Encabezado. @returns {void} Publica el desglose firmado del comprobante o del pago. */
  function taxes(node, suffix, title) {
    const rows = taxRows(node, suffix);
    if (rows.length)
      tables.push({
        title,
        headers : ['Aplicación', 'Impuesto', 'Base', 'Factor', 'Tasa/cuota', 'Importe'],
        rows,
      });
  }
  const conceptTaxes = [];
  for (const [index, concept] of concepts.entries())
    for (const tax of taxRows(concept.Impuestos, ''))
      conceptTaxes.push([String(index + 1), ...tax]);
  // El contrato RPC admite hasta 500 filas por tabla; conserva la numeración al continuar.
  for (let offset = 0; offset < conceptTaxes.length; offset += 500)
    tables.push({
      title   : 'Impuestos por partida',
      headers : ['Partida', 'Aplicación', 'Impuesto', 'Base', 'Factor', 'Tasa/cuota', 'Importe'],
      rows    : conceptTaxes.slice(offset, offset + 500),
    });
  taxes(cfdi.Impuestos, '', 'Impuestos del comprobante');
  section('Totales', {
    Subtotal                : attr(cfdi, 'SubTotal'),
    Descuento               : attr(cfdi, 'Descuento'),
    'Impuestos trasladados' : attr(cfdi.Impuestos, 'TotalImpuestosTrasladados'),
    'Impuestos retenidos'   : attr(cfdi.Impuestos, 'TotalImpuestosRetenidos'),
    Total                   : attr(cfdi, 'Total') + ' ' + attr(cfdi, 'Moneda'),
  });
  for (const related of array(cfdi.CfdiRelacionados))
    section('CFDI relacionados · ' + attr(related, 'TipoRelacion'), {
      UUID : array(related.CfdiRelacionado)
        .map(
          /** @param {Object} value Relación. @returns {string} UUID relacionado. */
          (value) => attr(value, 'UUID'),
        )
        .join(', '),
    });
  if (cfdi.Complemento.Pagos) {
    const payments = cfdi.Complemento.Pagos;
    const totals   = {};
    const labels   = {
      MontoTotalPagos             : 'Monto total pagado',
      TotalRetencionesIVA         : 'IVA retenido',
      TotalRetencionesISR         : 'ISR retenido',
      TotalRetencionesIEPS        : 'IEPS retenido',
      TotalTrasladosBaseIVA16     : 'Base IVA 16%',
      TotalTrasladosImpuestoIVA16 : 'IVA 16%',
      TotalTrasladosBaseIVA8      : 'Base IVA 8%',
      TotalTrasladosImpuestoIVA8  : 'IVA 8%',
      TotalTrasladosBaseIVA0      : 'Base IVA 0%',
      TotalTrasladosImpuestoIVA0  : 'IVA 0%',
      TotalTrasladosBaseIVAExento : 'Base IVA exento',
    };
    for (const [key, value] of Object.entries(payments.Totales))
      if (key.startsWith('@_')) totals[labels[key.slice(2)] || key.slice(2)] = value;
    section('Pagos 2.0 · Totales MXN', totals);
    for (const payment of array(payments.Pago)) {
      section('Pago', {
        Fecha            : attr(payment, 'FechaPago'),
        Forma            : attr(payment, 'FormaDePagoP'),
        Moneda           : attr(payment, 'MonedaP'),
        'Tipo de cambio' : attr(payment, 'TipoCambioP'),
        Monto            : attr(payment, 'Monto'),
        Operación        : attr(payment, 'NumOperacion'),
      });
      const rows = [];
      for (const related of array(payment.DoctoRelacionado)) {
        rows.push(
          [
            'IdDocumento',
            'MonedaDR',
            'EquivalenciaDR',
            'NumParcialidad',
            'ImpSaldoAnt',
            'ImpPagado',
            'ImpSaldoInsoluto',
            'ObjetoImpDR',
          ].map(
            /** @param {string} key Atributo del pago. @returns {string} Aplicación histórica firmada. */
            (key) => attr(related, key),
          ),
        );
        taxes(related.ImpuestosDR, 'DR', 'Impuestos del documento ' + attr(related, 'IdDocumento'));
      }
      tables.push({
        title   : 'Documentos pagados',
        headers : [
          'UUID',
          'Moneda',
          'Equivalencia',
          'Parcialidad',
          'Saldo anterior',
          'Pagado',
          'Saldo insoluto',
          'Objeto',
        ],
        rows,
      });
      taxes(payment.ImpuestosP, 'P', 'Impuestos del pago');
    }
  }
  const chain = [
    '1.1',
    attr(tfd, 'UUID'),
    attr(tfd, 'FechaTimbrado'),
    attr(tfd, 'RfcProvCertif'),
    ...(attr(tfd, 'Leyenda') ? [attr(tfd, 'Leyenda')] : []),
    attr(tfd, 'SelloCFD'),
    attr(tfd, 'NoCertificadoSAT'),
  ];
  section('Certificación', {
    'Certificado del emisor'                                           : attr(cfdi, 'NoCertificado'),
    'Certificado SAT'                                                  : attr(tfd, 'NoCertificadoSAT'),
    'Fecha de certificación'                                           : attr(tfd, 'FechaTimbrado'),
    'RFC proveedor'                                                    : attr(tfd, 'RfcProvCertif'),
    'Sello digital del CFDI'                                           : attr(tfd, 'SelloCFD'),
    'Sello digital del SAT'                                            : attr(tfd, 'SelloSAT'),
    'Cadena original del complemento de certificación digital del SAT' :
      '||' + chain.join('|') + '||',
  });
  const verificationUrl =
    'https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?' +
    new URLSearchParams({
      id : document.uuid,
      re : attr(cfdi.Emisor, 'Rfc'),
      rr : attr(cfdi.Receptor, 'Rfc'),
      tt : amount(attr(cfdi, 'Total')).toFixed(6),
      fe : attr(cfdi, 'Sello').slice(-8),
    }).toString();
  return {
    title     :
      document.issuerSnapshot.environment === 'development'
        ? 'CFDI DE PRUEBAS'
        : document.type === 'P'
          ? 'Complemento de pago'
          : document.type === 'E'
            ? 'Nota de crédito'
            : 'Factura',
    reference : [document.series, document.folio].filter(Boolean).join(' '),
    sections,
    tables,
    verificationUrl,
  };
}
module.exports = { billingPrintView };
