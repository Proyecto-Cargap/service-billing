/** @file Importación semántica de CFDI recibidos, sin timbrado ni afirmación de vigencia SAT. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { amount, Decimal }     = require('./amounts.service');
const { validateBillingDate } = require('./billing-date.service');
const { validate }            = require('../../../contracts/action-dto');
const manifest                = require('../../../contracts/service.json');
const { billingAccess }       = require('../policies/billing-access.policy');
/** @param {*} value Nodo XML opcional. @returns {Object[]} Nodos como lista. */
function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
/** @param {Object} node Nodo fiscal. @param {string} name Atributo. @param {string} fallback Ausencia permitida. @returns {string} Decimal del original, validado. */
function money(node, name, fallback) {
  const value = node['@_' + name] ?? fallback;
  amount(value);
  return value;
}
/** @param {Object} group Nodo de impuestos. @returns {Object[]} Impuestos de conceptos conservando importes originales. */
function taxes(group) {
  const result = [];
  for (const [container, child, kind] of [
    ['Traslados', 'Traslado', 'transferred'],
    ['Retenciones', 'Retencion', 'withheld'],
  ])
    for (const tax of list(group?.[container]?.[child])) {
      const factor = tax['@_TipoFactor'];
      if (
        !['Tasa', 'Cuota', 'Exento'].includes(factor) ||
        !['001', '002', '003'].includes(tax['@_Impuesto'])
      )
        throw new ApplicationError(400, 'BILLING_EXPENSE_XML_UNSUPPORTED');
      result.push({
        kind,
        code   : tax['@_Impuesto'],
        factor,
        ...(factor !== 'Exento' ? { rate: money(tax, 'TasaOCuota') } : {}),
        base   : money(tax, 'Base'),
        amount : money(tax, 'Importe', '0'),
      });
    }
  return result;
}
/** @param {Object} dependencies Referencias y almacenamiento privado. @returns {Object} Previsualización y adopción fiscal explícita. */
function expenseXml({
  store,
  records,
  references,
  expenses,
  attachments,
  expenseFiles,
  context,
  hash,
}) {
  /** @param {Object} value Gasto autorizado. @param {string} fileId XML adoptado. @param {Object} supplied XML inicial opcional. @returns {Promise<Object>} Datos originales acreditados contra proveedor y empresa. */
  async function preview(value, fileId, supplied) {
    const file = supplied ? null : attachments.file(value, fileId);
    if (file && file.kind !== 'xml')
      throw new ApplicationError(400, 'BILLING_EXPENSE_XML_REQUIRED');
    const xml = supplied || (await expenseFiles.xml(value, file));
    if (
      xml.Emisor?.['@_Rfc'] !== value.supplierSnapshot.taxId ||
      xml.Receptor?.['@_Rfc'] !== value.issuerSnapshot.taxId
    )
      throw new ApplicationError(409, 'BILLING_EXPENSE_XML_RFC_MISMATCH');
    const stamp = xml.Complemento?.TimbreFiscalDigital;
    if (
      !stamp ||
      Array.isArray(stamp) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stamp['@_UUID'] || '')
    )
      throw new ApplicationError(400, 'BILLING_EXPENSE_XML_UUID_REQUIRED');
    if (
      Object.keys(xml.Complemento).some(
        /** @param {string} name Complemento recibido. @returns {boolean} Complemento que podría alterar importes y no está soportado. */
        (name) => !name.startsWith('@_') && name !== 'TimbreFiscalDigital',
      )
    )
      throw new ApplicationError(400, 'BILLING_EXPENSE_XML_UNSUPPORTED');
    const currency = xml['@_Moneda'];
    const catalog  = (
      await references.catalog({
        kind : 'currency',
        code : currency,
      })
    ).items[0];
    if (!catalog || currency === 'XXX') throw new ApplicationError(400, 'BILLING_INVALID_CURRENCY');
    const date = xml['@_Fecha'];
    validateBillingDate(date);
    const lines = list(xml.Conceptos?.Concepto).map(
      /** @param {Object} line Concepto original. @returns {Object} Concepto normalizado sin recalcular sus importes. */
      (line) => ({
        description    : line['@_Descripcion'],
        quantity       : money(line, 'Cantidad'),
        unitPrice      : money(line, 'ValorUnitario'),
        amount         : money(line, 'Importe'),
        discount       : money(line, 'Descuento', '0'),
        productService : line['@_ClaveProdServ'],
        unit           : line['@_ClaveUnidad'],
        taxObject      : line['@_ObjetoImp'],
        taxes          : taxes(line.Impuestos),
      }),
    );
    if (!lines.length || lines.length > 500)
      throw new ApplicationError(400, 'BILLING_LINES_REQUIRED');
    let gross  = new Decimal(0),
      discount = new Decimal(0);
    const groups = new Map();
    for (const line of lines) {
      if (
        !line.description ||
        !amount(line.quantity).gt(0) ||
        amount(line.discount).gt(line.amount)
      )
        throw new ApplicationError(400, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
      if (
        !amount(line.quantity)
          .mul(line.unitPrice)
          .toDecimalPlaces((line.amount.split('.')[1] || '').length)
          .eq(line.amount)
      )
        throw new ApplicationError(400, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
      gross = gross.plus(line.amount);
      discount = discount.plus(line.discount);
      for (const tax of line.taxes) {
        if (
          tax.factor !== 'Exento' &&
          !amount(tax.base)
            .mul(tax.rate)
            .toDecimalPlaces((tax.amount.split('.')[1] || '').length)
            .eq(tax.amount)
        )
          throw new ApplicationError(400, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
        const key      = [tax.kind, tax.code, tax.factor, tax.rate || ''].join(':');
        const previous = groups.get(key);
        groups.set(key, {
          ...tax,
          base   : previous ? amount(previous.base).plus(tax.base).toFixed(6) : tax.base,
          amount : previous ? amount(previous.amount).plus(tax.amount).toFixed(6) : tax.amount,
        });
      }
    }
    const result = {
      date,
      currency,
      exchangeRate : money(xml, 'TipoCambio', '1'),
      lines,
      taxes        : [...groups.values()],
      subtotal     : money(xml, 'SubTotal'),
      discount     : money(xml, 'Descuento', '0'),
      transferred  : money(xml.Impuestos || {}, 'TotalImpuestosTrasladados', '0'),
      withheld     : money(xml.Impuestos || {}, 'TotalImpuestosRetenidos', '0'),
      total        : money(xml, 'Total'),
      uuid         : stamp['@_UUID'].toUpperCase(),
    };
    amount(result.total, true);
    amount(result.exchangeRate, true);
    if (currency === 'MXN' && !amount(result.exchangeRate).eq(1))
      throw new ApplicationError(400, 'BILLING_INVALID_CURRENCY');
    let transferred = amount('0'),
      withheld      = amount('0');
    for (const tax of result.taxes) {
      const rounded = amount(tax.amount).toDecimalPlaces(catalog.decimals);
      if (tax.kind === 'withheld') withheld = withheld.plus(rounded);
      else transferred = transferred.plus(rounded);
    }
    if (
      !gross.toDecimalPlaces(catalog.decimals).eq(result.subtotal) ||
      !discount.toDecimalPlaces(catalog.decimals).eq(result.discount) ||
      !transferred.eq(result.transferred) ||
      !withheld.eq(result.withheld) ||
      !amount(result.subtotal)
        .minus(result.discount)
        .plus(result.transferred)
        .minus(result.withheld)
        .eq(result.total)
    )
      throw new ApplicationError(400, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
    if (
      !validate(
        result,
        manifest.endpoints.find(
          /** @param {Object} endpoint Contrato público. @returns {boolean} Vista previa fiscal. */ (
            endpoint,
          ) => endpoint.name === 'billing-expense-xml-preview',
        ).successData,
      )
    )
      throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
    return result;
  }
  return {
    /** @param {Object} data Cabecera y huella. @returns {Promise<Object>} Capacidad sin crear gasto ni modificar catálogos. */
    async prepareImport(data) {
      billingAccess(context(), 'expense', 'create');
      await records.get('issuer', data.issuerCode);
      await references.supplier(data.supplierCode);
      await expenses.classification(data);
      return {
        name       : data.name,
        byteLength : data.byteLength,
        sha256     : data.sha256,
      };
    },
    /** @param {Object} data Cabecera y archivo XML del transporte. @returns {Promise<Object>} Borrador importado recuperable por la misma intención. */
    async import(data) {
      billingAccess(context(), 'expense', 'create');
      const issuer   = await records.get('issuer', data.issuerCode);
      const supplier = await references.supplier(data.supplierCode);
      const xml      = await expenseFiles.parseUpload(data);
      const source   = await preview(
        {
          issuerSnapshot   : issuer,
          supplierSnapshot : { taxId: supplier.fiscal?.taxId || '' },
        },
        '',
        xml,
      );
      const capture  = {
        issuerCode     : data.issuerCode,
        supplierCode   : data.supplierCode,
        categoryCode   : data.categoryCode,
        costCenterCode : data.costCenterCode,
        projectCode    : data.projectCode || '',
        description    : data.description,
        dueDate        : data.dueDate || '',
        notes          : data.notes || '',
        date           : source.date,
        currency       : source.currency,
        exchangeRate   : source.exchangeRate,
        lines          : source.lines,
        idempotencyKey : hash([data.idempotencyKey, 'draft']),
      };
      const draft    = await expenses.create(capture, source);
      let current    = await records.get('expense', draft.code, 'update');
      if (current.uuid === source.uuid) return records.getOne('expense', { code: current.code });
      const file = await attachments.upload({
        resource       : 'expense',
        code           : draft.code,
        revision       : draft.revision,
        name           : data.name,
        byteLength     : data.byteLength,
        sha256         : data.sha256,
        idempotencyKey : hash([data.idempotencyKey, 'file']),
        useXml         : true,
        tempFilePath   : data.tempFilePath,
      });
      current = await records.get('expense', draft.code, 'update');
      return this.apply({
        code           : draft.code,
        revision       : current.revision,
        fileId         : file.fileId,
        idempotencyKey : hash([data.idempotencyKey, 'apply']),
      });
    },
    /** @param {Object} data Gasto y archivo. @returns {Promise<Object>} Vista previa sin mutación. */
    async preview(data) {
      return preview(await records.get('expense', data.code), data.fileId);
    },
    /** @param {Object} data Gasto, archivo y revisión. @returns {Promise<Object>} Adopción única del UUID, con valores originales e historial intacto. */
    async apply(data) {
      const value    = await records.get('expense', data.code, 'update');
      const source   = await preview(value, data.fileId);
      const currency = (
        await references.catalog({
          kind : 'currency',
          code : source.currency,
        })
      ).items[0];
      return expenses.once(
        'expense',
        'xml-apply',
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Adopción fiscal sin volver a generar saldo. */
        async (tx, actor) => {
          const current = await records.get('expense', data.code, 'update', actor, tx);
          records.match(current, data.revision);
          if (
            !['draft', 'confirmed'].includes(current.status) ||
            current.revision !== value.revision ||
            (current.status === 'confirmed' && current.uuid)
          )
            throw new ApplicationError(409, 'BILLING_EXPENSE_XML_LOCKED');
          const duplicate = await tx.get('expense', {
            uuid       : source.uuid,
            uuidActive : true,
          });
          if (duplicate && duplicate.code !== current.code)
            throw new ApplicationError(409, 'BILLING_EXPENSE_XML_DUPLICATE');
          {
            for (const key of [
              'subtotal',
              'discount',
              'transferred',
              'withheld',
              'total',
              'exchangeRate',
            ])
              if (!amount(current[key]).eq(source[key]))
                throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
            if (
              current.currency !== source.currency ||
              current.lines.length !== source.lines.length
            )
              throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
            for (let i = 0; i < current.lines.length; i++) {
              const oldTaxes = current.lines[i].taxes,
                newTaxes     = source.lines[i].taxes;
              if (oldTaxes.length !== newTaxes.length)
                throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
              for (let t = 0; t < oldTaxes.length; t++) {
                for (const key of ['kind', 'code', 'factor'])
                  if (oldTaxes[t][key] !== newTaxes[t][key])
                    throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
                for (const key of ['base', 'amount', 'rate'])
                  if (!amount(oldTaxes[t][key] || '0').eq(newTaxes[t][key] || '0'))
                    throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
              }
              for (const key of ['quantity', 'unitPrice', 'discount', 'amount'])
                if (!amount(current.lines[i][key] || '0').eq(source.lines[i][key]))
                  throw new ApplicationError(409, 'BILLING_EXPENSE_XML_TOTAL_MISMATCH');
            }
          }
          const updated = expenses.next(current, {
            ...source,
            currencyDecimals : currency.decimals,
            uuidActive       : true,
            xmlFileId        : data.fileId,
          });
          await tx.replace('expense', current, updated);
          await records.audit(tx, actor, 'expense', value.code, 'xml-applied');
          return updated;
        },
      );
    },
  };
}
module.exports = { expenseXml };
