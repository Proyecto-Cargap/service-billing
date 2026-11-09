/** @file Reglas fiscales para datos maestros, instantáneas de Customer y preparación decimal de borradores. */
'use strict';
const { validateBillingDate } = require('./billing-date.service');
const { ApplicationError }    = require('../../../shared/application-error');
const { amount, calculate }   = require('./amounts.service');
/** @param {Object} options Referencias canónicas y reloj. @returns {Object} Reglas sin transporte ni persistencia concreta. */
function billingRules({ references, clock }) {
  /** @param {Object[]} lines Conceptos. @returns {Promise<void>} Acredita claves y tasas vigentes. */
  async function validateLines(lines) {
    const values = [],
      rates      = await references.catalog({
        kind    : 'tax-rate',
        perPage : 100,
      });
    for (const line of lines) {
      if (!line.description.trim()) throw new ApplicationError(400, 'BILLING_DESCRIPTION_REQUIRED');
      for (const [kind, code] of [
        ['product-service', line.productService],
        ['unit', line.unit],
        ['tax-object', line.taxObject],
      ])
        values.push({
          kind,
          code,
        });
      if (line.taxObject === '02' && !line.taxes.length)
        throw new ApplicationError(400, 'BILLING_TAXES_REQUIRED');
      for (const tax of line.taxes) {
        if (tax.factor === 'Exento') {
          if (tax.kind !== 'transferred' || tax.code !== '002' || tax.rate)
            throw new ApplicationError(400, 'BILLING_INVALID_TAX');
          continue;
        }
        const rate = amount(tax.rate);
        if (
          !rates.items.some(
            /** @param {Object} entry Tasa publicada. @returns {boolean} Coincide impuesto, factor, dirección y rango. */
            (entry) =>
              entry.tax === tax.code &&
              entry.factor === tax.factor &&
              entry[tax.kind] &&
              (entry.kind === 'fixed'
                ? rate.eq(entry.max)
                : rate.gte(entry.min) && rate.lte(entry.max)),
          )
        )
          throw new ApplicationError(400, 'BILLING_INVALID_TAX_RATE');
      }
    }
    await references.values(values);
  }
  /** @param {Object} customer Cliente canónico. @returns {Object} Datos fiscales históricos mínimos desde el domicilio fiscal existente. */
  function snapshot(customer) {
    if (customer.state !== 'customer')
      throw new ApplicationError(409, 'BILLING_CUSTOMER_STATE_INVALID');
    const fiscal = customer.fiscal || {},
      address    = fiscal.address || {};
    const country = (address.country || '').trim();
    if (
      !/^(MEX|MX|M[EÉ]XICO)$/i.test(country) ||
      !/^\d{5}$/.test(address.postalCode || '') ||
      !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(fiscal.taxId || '') ||
      !fiscal.legalName?.trim() ||
      !fiscal.taxRegime
    )
      throw new ApplicationError(409, 'BILLING_CUSTOMER_FISCAL_DATA_INCOMPLETE');
    return {
      customerCode : customer.customerCode,
      revision     : customer.revision,
      fiscal       : {
        taxId      : fiscal.taxId,
        legalName  : fiscal.legalName,
        taxRegime  : fiscal.taxRegime,
        postalCode : address.postalCode,
        country,
      },
    };
  }
  return {
    snapshot,
    validateLines,
    /** @param {Object} input Emisor propuesto. @returns {Promise<Object>} Datos acreditados sin credenciales. */
    async issuer(input) {
      if (!input.name.trim() || !input.legalName.trim() || /^X[AE]XX010101000$/.test(input.taxId))
        throw new ApplicationError(400, 'BILLING_INVALID_ISSUER');
      await references.profile({
        taxId     : input.taxId,
        taxRegime : input.taxRegime,
      });
      return input;
    },
    /** @param {Object} input Borrador editable. @param {Object} issuer Emisor disponible o referencia histórica autorizada. @param {Object|null} related CFDI relacionado autorizado. @returns {Promise<Object>} Documento completo con importes y fotografías fiscales. */
    async document(input, issuer, related) {
      validateBillingDate(input.date);
      if (!issuer.active) throw new ApplicationError(409, 'BILLING_ISSUER_INACTIVE');
      const currency = (
        await references.catalog({
          kind : 'currency',
          code : input.currency,
        })
      ).items[0];
      if (!currency || currency.code === 'XXX')
        throw new ApplicationError(400, 'BILLING_INVALID_CURRENCY');
      if (
        input.currency === 'MXN'
          ? !amount(input.exchangeRate).eq(1)
          : !amount(input.exchangeRate, true)
      )
        throw new ApplicationError(400, 'BILLING_INVALID_EXCHANGE_RATE');
      if (
        (input.paymentMethod === 'PPD') !== (input.paymentForm === '99') ||
        (input.type === 'E' && input.paymentMethod !== 'PUE')
      )
        throw new ApplicationError(400, 'BILLING_PAYMENT_TERMS_CONFLICT');
      await validateLines(input.lines);
      let customerSnapshot;
      if (input.globalInfo) {
        if (
          input.type !== 'I' ||
          input.customerCode ||
          input.paymentMethod !== 'PUE' ||
          input.cfdiUse !== 'S01' ||
          !input.globalInfo.operationCodes.length ||
          new Set(input.globalInfo.operationCodes).size !== input.globalInfo.operationCodes.length
        )
          throw new ApplicationError(400, 'BILLING_INVALID_GLOBAL_INVOICE');
        await references.values([
          {
            kind : 'periodicity',
            code : input.globalInfo.periodicity,
          },
          {
            kind : 'month',
            code : input.globalInfo.month,
          },
        ]);
        if (
          (input.globalInfo.periodicity === '05') !== Number(input.globalInfo.month) >= 13 ||
          (input.globalInfo.periodicity === '05' && issuer.taxRegime !== '621') ||
          input.globalInfo.year > Number(input.date.slice(0, 4)) ||
          input.globalInfo.year < Number(input.date.slice(0, 4)) - 5
        )
          throw new ApplicationError(400, 'BILLING_INVALID_GLOBAL_PERIOD');
        customerSnapshot = {
          customerCode : '',
          revision     : 1,
          fiscal       : {
            taxId      : 'XAXX010101000',
            legalName  : 'PUBLICO EN GENERAL',
            taxRegime  : '616',
            postalCode : issuer.postalCode,
            country    : 'México',
          },
        };
      } else customerSnapshot = snapshot(await references.customer(input.customerCode));
      if (/^X[AE]XX010101000$/.test(customerSnapshot.fiscal.taxId) && !input.globalInfo)
        throw new ApplicationError(400, 'BILLING_GENERIC_RECEIVER_REQUIRES_GLOBAL_INVOICE');
      await references.profile({
        taxId         : customerSnapshot.fiscal.taxId,
        taxRegime     : customerSnapshot.fiscal.taxRegime,
        cfdiUse       : input.cfdiUse,
        paymentMethod : input.paymentMethod,
        paymentForm   : input.paymentForm,
      });
      const totals = calculate(input.lines, currency.decimals);
      amount(totals.total, true);
      if (
        input.type === 'E' &&
        (!related ||
          related.type !== 'I' ||
          related.status !== 'issued' ||
          related.issuerCode !== issuer.code ||
          related.customerCode !== input.customerCode ||
          related.currency !== input.currency ||
          amount(totals.total).gt(related.balance))
      )
        throw new ApplicationError(409, 'BILLING_INVALID_CREDIT_TARGET');
      if (input.relatedDocumentCode) {
        if (
          !related ||
          !['issued', 'cancel-requested'].includes(related.status) ||
          related.issuerCode !== issuer.code ||
          related.customerCode !== input.customerCode ||
          !input.relationship
        )
          throw new ApplicationError(409, 'BILLING_INVALID_RELATED_DOCUMENT');
        await references.values([
          {
            kind : 'relationship',
            code : input.relationship,
          },
        ]);
      }
      if (input.type === 'E' && !['01', '03'].includes(input.relationship))
        throw new ApplicationError(400, 'BILLING_INVALID_CREDIT_RELATIONSHIP');
      return {
        ...input,
        ...totals,
        currencyDecimals : currency.decimals,
        customerSnapshot,
        issuerSnapshot   : {
          taxId       : issuer.taxId,
          legalName   : issuer.legalName,
          taxRegime   : issuer.taxRegime,
          postalCode  : issuer.postalCode,
          environment : issuer.environment,
        },
        ...(related ? { relatedUuid: related.uuid } : {}),
        status           : 'draft',
        paid             : '0',
        credited         : '0',
        balance          : '0',
        partiality       : 0,
        files            : {},
        deliveryStatus   : 'pending',
      };
    },
  };
}
module.exports = { billingRules };
