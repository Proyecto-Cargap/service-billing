/** @file Construye los layouts JSON publicados por FacturaLO PLUS para CFDI 4.0 y Pagos 2.0. */
'use strict';
const { Decimal, amount } = require('./amounts.service');
/** @param {Object} tax Impuesto calculado. @param {string} suffix Sufijo CFDI o Pagos. @returns {Object} Atributos fiscales, omitiendo importe y tasa de exentos. */
function taxAttributes(tax, suffix = '') {
  return {
    ['Base' + suffix]       : tax.base,
    ['Impuesto' + suffix]   : tax.code,
    ['TipoFactor' + suffix] : tax.factor,
    ...(tax.factor !== 'Exento'
      ? {
          ['TasaOCuota' + suffix] : amount(tax.rate).toFixed(6),
          ['Importe' + suffix]    : tax.amount,
        }
      : {}),
  };
}
/** @param {Object[]} taxes Impuestos ya calculados. @param {string} suffix Sufijo del complemento. @param {boolean} totals Resumen de retenciones sólo por impuesto. @returns {Object} Nodos de impuestos según layout PAC. */
function taxNodes(taxes, suffix = '', totals = false) {
  const transferred = [],
    withheld        = [],
    groups          = new Map();
  for (const tax of taxes) {
    if (tax.kind === 'transferred') transferred.push(taxAttributes(tax, suffix));
    else if (!totals) withheld.push(taxAttributes(tax, suffix));
    else groups.set(tax.code, (groups.get(tax.code) || new Decimal(0)).plus(tax.amount));
  }
  if (totals)
    for (const [code, value] of groups)
      withheld.push({
        ['Impuesto' + suffix] : code,
        ['Importe' + suffix]  : value.toFixed(suffix ? 6 : 2),
      });
  return {
    ...(transferred.length ? { ['Traslados' + suffix]: transferred } : {}),
    ...(withheld.length ? { ['Retenciones' + suffix]: withheld } : {}),
  };
}
/** @param {Object} document Documento y fotografías fiscales. @param {Object} issuer Certificado vigente del emisor. @returns {Object} Encabezado común sin datos de infraestructura. */
function header(document, issuer) {
  const sender = document.issuerSnapshot,
    receiver   = document.customerSnapshot.fiscal;
  return {
    Version           : '4.0',
    Serie             : document.series,
    Folio             : document.folio,
    Fecha             : document.date,
    NoCertificado     : issuer.certificate.serial,
    SubTotal          : document.subtotal,
    Moneda            : document.currency,
    Total             : document.total,
    TipoDeComprobante : document.type,
    Exportacion       : '01',
    LugarExpedicion   : sender.postalCode,
    Emisor            : {
      Rfc           : sender.taxId,
      Nombre        : sender.legalName,
      RegimenFiscal : sender.taxRegime,
    },
    Receptor          : {
      Rfc                     : receiver.taxId,
      Nombre                  : receiver.legalName,
      DomicilioFiscalReceptor : receiver.postalCode,
      RegimenFiscalReceptor   : receiver.taxRegime,
      UsoCFDI                 : document.type === 'P' ? 'CP01' : document.cfdiUse,
    },
    ...(document.relatedUuid
      ? {
          CfdiRelacionados : {
            TipoRelacion    : document.relationship,
            CfdiRelacionado : [document.relatedUuid],
          },
        }
      : {}),
  };
}
/** @param {Object} document Factura o nota de crédito calculada. @param {Object} issuer Certificado vigente. @returns {Object} JSON de timbrarJSON sin secretos. */
function invoiceLayout(document, issuer) {
  const totalTaxes = taxNodes(document.taxes, '', true);
  // Los importes de resumen conservan los decimales de la moneda del comprobante.
  if (totalTaxes.Retenciones)
    for (const tax of totalTaxes.Retenciones)
      tax.Importe = document.taxes
        .filter(
          /** @param {Object} item Impuesto. @returns {boolean} Retenciones del mismo código. */
          (item) => item.kind === 'withheld' && item.code === tax.Impuesto,
        )
        .reduce(
          /** @param {Object} total Acumulado decimal. @param {Object} item Impuesto. @returns {Object} Suma sin conversión binaria. */
          (total, item) => total.plus(item.amount),
          new Decimal(0),
        )
        .toFixed(document.currencyDecimals);
  return {
    Comprobante : {
      ...header(document, issuer),
      FormaPago  : document.paymentForm,
      MetodoPago : document.paymentMethod,
      ...(document.currency !== 'MXN' ? { TipoCambio: document.exchangeRate } : {}),
      ...(amount(document.discount).gt(0) ? { Descuento: document.discount } : {}),
      ...(document.globalInfo
        ? {
            InformacionGlobal : {
              Periodicidad : document.globalInfo.periodicity,
              Meses        : document.globalInfo.month,
              Año          : String(document.globalInfo.year),
            },
          }
        : {}),
      Conceptos  : document.lines.map(
        /** @param {Object} line Concepto calculado. @returns {Object} Atributos del layout oficial. */
        (line) => ({
          ClaveProdServ : line.productService,
          Cantidad      : line.quantity,
          ClaveUnidad   : line.unit,
          ...(line.unitName ? { Unidad: line.unitName } : {}),
          Descripcion   : line.description,
          ValorUnitario : line.unitPrice,
          Importe       : line.amount,
          ...(amount(line.discount).gt(0) ? { Descuento: line.discount } : {}),
          ObjetoImp     : line.taxObject,
          ...(line.taxes.length ? { Impuestos: taxNodes(line.taxes) } : {}),
        }),
      ),
      ...(document.taxes.length
        ? {
            Impuestos : {
              ...totalTaxes,
              ...(totalTaxes.Traslados?.some(
                /** @param {Object} tax Traslado. @returns {boolean} Existe traslado no exento. */
                (tax) => tax.TipoFactor !== 'Exento',
              )
                ? { TotalImpuestosTrasladados: document.transferred }
                : {}),
              ...(totalTaxes.Retenciones ? { TotalImpuestosRetenidos: document.withheld } : {}),
            },
          }
        : {}),
    },
    CamposPDF   : { Comentarios: document.notes || '' },
  };
}
/** @param {Object} receipt Cobro confirmado con aplicaciones e impuestos congelados. @returns {Object} Complemento Pagos20 con equivalencias e importes MXN. */
function paymentComplement(receipt) {
  const groups = new Map(),
    exchange   = amount(receipt.exchangeRate, true);
  const documents = (receipt.fiscalAllocations || receipt.allocations).map(
    /** @param {Object} allocation Aplicación histórica del cobro. @returns {Object} Documento relacionado con parcialidad e impuestos. */
    (allocation) => {
      for (const tax of allocation.taxes) {
        const key = [tax.kind, tax.code, tax.factor, tax.rate || ''].join(':'),
          group   = groups.get(key) || {
            ...tax,
            base   : new Decimal(0),
            amount : new Decimal(0),
          };
        group.base = group.base.plus(amount(tax.base).div(allocation.equivalence));
        group.amount = group.amount.plus(amount(tax.amount).div(allocation.equivalence));
        groups.set(key, group);
      }
      return {
        IdDocumento      : allocation.uuid,
        Serie            : allocation.series,
        Folio            : allocation.folio,
        MonedaDR         : allocation.currency,
        EquivalenciaDR   : allocation.equivalence,
        NumParcialidad   : String(allocation.partiality),
        ImpSaldoAnt      : allocation.previousBalance,
        ImpPagado        : allocation.amount,
        ImpSaldoInsoluto : allocation.remainingBalance,
        ObjetoImpDR      : allocation.taxObject,
        ...(allocation.taxes.length ? { ImpuestosDR: taxNodes(allocation.taxes, 'DR') } : {}),
      };
    },
  );
  const taxes     = [...groups.values()].map(
    /** @param {Object} tax Acumulado en moneda del pago. @returns {Object} Precisión permitida de Pagos 2.0. */
    (tax) => ({
      ...tax,
      base   : tax.base.toFixed(6),
      amount : tax.amount.toFixed(6),
    }),
  );
  const totals    = { MontoTotalPagos: amount(receipt.amount).mul(exchange).toFixed(2) };
  for (const tax of taxes) {
    if (tax.kind === 'withheld') {
      const key =
        'TotalRetenciones' +
        {
          '001' : 'ISR',
          '002' : 'IVA',
          '003' : 'IEPS',
        }[tax.code];
      totals[key] = new Decimal(totals[key] || 0).plus(amount(tax.amount).mul(exchange)).toFixed(2);
    } else if (tax.code === '002') {
      const rate = tax.factor === 'Exento' ? 'Exento' : amount(tax.rate).mul(100).toFixed(0);
      totals['TotalTrasladosBaseIVA' + rate] = amount(tax.base).mul(exchange).toFixed(2);
      if (rate !== 'Exento')
        totals['TotalTrasladosImpuestoIVA' + rate] = amount(tax.amount).mul(exchange).toFixed(2);
    }
  }
  return {
    Pagos20 : {
      Version : '2.0',
      Totales : totals,
      Pago    : [
        {
          FechaPago        : receipt.date,
          FormaDePagoP     : receipt.paymentForm,
          MonedaP          : receipt.currency,
          TipoCambioP      : receipt.exchangeRate,
          Monto            : receipt.amount,
          ...(receipt.reference ? { NumOperacion: receipt.reference } : {}),
          DoctoRelacionado : documents,
          ...(taxes.length ? { ImpuestosP: taxNodes(taxes, 'P', true) } : {}),
        },
      ],
    },
  };
}
/** @param {Object} document REP preparado. @param {Object} issuer Certificado. @param {Object} receipt Cobro confirmado. @returns {Object} Layout completo CFDI P con complemento. */
function paymentLayout(document, issuer, receipt) {
  return {
    Comprobante : {
      ...header(document, issuer),
      Conceptos   : [
        {
          ClaveProdServ : '84111506',
          Cantidad      : '1',
          ClaveUnidad   : 'ACT',
          Descripcion   : 'Pago',
          ValorUnitario : '0',
          Importe       : '0',
          ObjetoImp     : '01',
        },
      ],
      Complemento : [paymentComplement(receipt)],
    },
    CamposPDF   : { Comentarios: receipt.reference },
  };
}
module.exports = {
  invoiceLayout,
  paymentLayout,
  paymentComplement,
};
