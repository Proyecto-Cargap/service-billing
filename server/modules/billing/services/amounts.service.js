/** @file Cálculo decimal de conceptos, descuentos e impuestos; no acepta totales del navegador. */
'use strict';
const Decimal              = require('decimal.js').clone({
  precision : 40,
  rounding  : 4,
});
const { ApplicationError } = require('../../../shared/application-error');
/** @param {string} value Importe decimal canónico. @param {boolean} positive Exige valor mayor a cero. @returns {Object} Decimal acreditado. */
function amount(value, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/.test(value))
    throw new ApplicationError(400, 'BILLING_INVALID_AMOUNT');
  const result = new Decimal(value);
  if (positive && !result.gt(0)) throw new ApplicationError(400, 'BILLING_INVALID_AMOUNT');
  return result;
}
/** @param {Object[]} lines Conceptos del comprobante. @param {number} decimals Decimales del catálogo de moneda. @returns {Object} Totales y conceptos calculados con redondeo explícito. */
function calculate(lines, decimals) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 500)
    throw new ApplicationError(400, 'BILLING_LINES_REQUIRED');
  let subtotal  = new Decimal(0),
    discount    = new Decimal(0),
    transferred = new Decimal(0),
    withheld    = new Decimal(0);
  const groups = new Map();
  const items  = lines.map(
    /** @param {Object} line Concepto. @returns {Object} Concepto con importes acreditados. */
    (line) => {
      const gross     = amount(line.quantity, true).mul(amount(line.unitPrice)).toDecimalPlaces(6);
      const reduction = amount(line.discount || '0');
      if (reduction.gt(gross)) throw new ApplicationError(400, 'BILLING_DISCOUNT_EXCEEDS_AMOUNT');
      const base = gross.minus(reduction);
      validateTaxObject(line.taxObject, line.taxes || []);
      const seen  = new Set();
      const taxes = (line.taxes || []).map(
        /** @param {Object} tax Regla de impuesto seleccionada. @returns {Object} Base e importe calculados. */
        (tax) => {
          const key = [tax.kind, tax.code, tax.factor, tax.rate || ''].join(':');
          if (seen.has(key) || (tax.kind === 'withheld' && tax.factor === 'Exento'))
            throw new ApplicationError(400, 'BILLING_INVALID_TAX');
          seen.add(key);
          const taxBase = tax.factor === 'Cuota' ? amount(line.quantity, true) : base;
          const total   =
            tax.factor === 'Exento'
              ? new Decimal(0)
              : taxBase.mul(amount(tax.rate)).toDecimalPlaces(6);
          const group   = groups.get(key) || {
            ...tax,
            base   : new Decimal(0),
            amount : new Decimal(0),
          };
          group.base = group.base.plus(taxBase);
          group.amount = group.amount.plus(total);
          groups.set(key, group);
          return {
            ...tax,
            base   : taxBase.toFixed(6),
            amount : total.toFixed(6),
          };
        },
      );
      subtotal = subtotal.plus(gross);
      discount = discount.plus(reduction);
      return {
        ...line,
        discount : reduction.toFixed(6),
        amount   : gross.toFixed(6),
        taxes,
      };
    },
  );
  const taxes  = [...groups.values()].map(
    /** @param {Object} tax Grupo acumulado. @returns {Object} Impuesto redondeado a la moneda. */
    (tax) => {
      const total = tax.amount.toDecimalPlaces(decimals);
      if (tax.kind === 'withheld') withheld = withheld.plus(total);
      else transferred = transferred.plus(total);
      return {
        ...tax,
        base   : tax.base.toFixed(decimals),
        amount : total.toFixed(decimals),
      };
    },
  );
  const total  = subtotal
    .toDecimalPlaces(decimals)
    .minus(discount.toDecimalPlaces(decimals))
    .plus(transferred)
    .minus(withheld);
  if (total.isNegative()) throw new ApplicationError(400, 'BILLING_NEGATIVE_TOTAL');
  return {
    lines       : items,
    subtotal    : subtotal.toFixed(decimals),
    discount    : discount.toFixed(decimals),
    transferred : transferred.toFixed(decimals),
    withheld    : withheld.toFixed(decimals),
    total       : total.toFixed(decimals),
    taxes,
  };
}
/** @param {string} code Objeto fiscal SAT. @param {Object[]} taxes Impuestos del concepto. @returns {void} Acredita las restricciones del Anexo 29 de 2026. */
function validateTaxObject(code, taxes) {
  if (
    !['01', '02', '03', '04', '05', '06', '07', '08'].includes(code) ||
    (['01', '03', '04', '05'].includes(code) && taxes.length) ||
    (code === '02' && !taxes.length) ||
    (['06', '08'].includes(code) &&
      taxes.some(
        /** @param {Object} tax Impuesto. @returns {boolean} Sólo se admite retención ISR. */
        (tax) => tax.kind !== 'withheld' || tax.code !== '001',
      )) ||
    (code === '07' &&
      (taxes.some(
        /** @param {Object} tax Impuesto. @returns {boolean} Se excluyen IVA e ISR trasladado. */
        (tax) => tax.code === '002' || (tax.code === '001' && tax.kind !== 'withheld'),
      ) ||
        !taxes.some(
          /** @param {Object} tax Impuesto. @returns {boolean} Es obligatorio desglosar IEPS trasladado. */
          (tax) => tax.code === '003' && tax.kind === 'transferred',
        )))
  )
    throw new ApplicationError(400, 'BILLING_TAX_OBJECT_CONFLICT');
}
/** @param {Object[]} lines Conceptos históricos. @returns {string} Objeto agregado para el documento relacionado del REP. */
function paymentTaxObject(lines) {
  const codes = new Set(
    lines.map(
      /** @param {Object} line Concepto. @returns {string} Tratamiento fiscal congelado. */
      (line) => line.taxObject,
    ),
  );
  for (const code of ['02', '07', '08', '06', '05', '04', '03', '01'])
    if (codes.has(code)) return code;
  throw new ApplicationError(409, 'BILLING_TAX_OBJECT_REQUIRED');
}
module.exports = {
  Decimal,
  amount,
  calculate,
  validateTaxObject,
  paymentTaxObject,
};
