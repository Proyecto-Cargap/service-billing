/** @file Ventas comerciales sin receptor fiscal, confirmación atómica y facturas derivadas con reserva exclusiva. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { billingAccess }       = require('../policies/billing-access.policy');
const { present, editable }   = require('../presenters/billing.presenter');
const { amount, calculate }   = require('./amounts.service');
const { validateBillingDate } = require('./billing-date.service');
const { productLines }        = require('./product-lines.service');
/** @param {Object} dependencies Puertos compartidos y casos de uso fiscales. @returns {Object} Operaciones comerciales sin efectos PAC implícitos. */
function salesService({ store, records, references, context, clock, hash, rules, receipts }) {
  /** @param {Object} current Registro. @param {Object} changes Cambios. @returns {Object} Nueva revisión. */
  function next(current, changes) {
    return {
      ...current,
      ...changes,
      revision   : current.revision + 1,
      updateDate : clock(),
    };
  }
  /** @param {string} action Acción. @param {Object} data Intención. @param {Function} work Persistencia. @returns {Promise<Object>} Resultado confirmado una sola vez. */
  async function once(action, data, work) {
    const actor = context();
    if (!data.idempotencyKey?.trim())
      throw new ApplicationError(400, 'BILLING_IDEMPOTENCY_KEY_REQUIRED');
    const key         = hash([actor.workspace, actor.user.userCode, action, data.idempotencyKey]);
    const fingerprint = hash(data);
    return store.transaction(
      /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Resultado durable. */ async (
        tx,
      ) => {
        const previous = await tx.receiptRead(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
          await records.get(previous.resource, previous.response.code, 'view', actor, tx);
          return previous.response;
        }
        const response = await work(tx);
        const resource =
          action.includes('invoice') || action.includes('global') ? 'document' : 'sale';
        await tx.receiptInsert({
          _id       : key,
          fingerprint,
          resource,
          response,
          createdAt : clock(),
        });
        return response;
      },
    );
  }
  /** @param {Object} input Captura comercial. @param {Object|null} previous Venta previa. @returns {Promise<Object>} Instantáneas y cálculos acreditados sin consultar PAC. */
  async function prepare(input, previous = null) {
    const data = editable('sale', input);
    validateBillingDate(data.date);
    const actor  = context();
    const issuer = await records.get('issuer', data.issuerCode);
    if (!issuer.active || ![actor.workspace, 'allWorkspaces'].includes(issuer.workspace))
      throw new ApplicationError(409, 'BILLING_ISSUER_INACTIVE');
    const customer = await references.customer(data.customerCode);
    if (customer.state !== 'customer') throw new ApplicationError(409, 'BILLING_CUSTOMER_REQUIRED');
    const currency = (
      await references.catalog({
        kind : 'currency',
        code : data.currency,
      })
    ).items[0];
    if (
      !currency ||
      data.currency === 'XXX' ||
      (data.currency === 'MXN' && !amount(data.exchangeRate).eq(1))
    )
      throw new ApplicationError(400, 'BILLING_INVALID_CURRENCY');
    amount(data.exchangeRate, true);
    await productLines(references)(data, previous);
    await rules.validateLines(data.lines);
    const totals = calculate(data.lines, currency.decimals);
    amount(totals.total, true);
    return {
      ...data,
      ...totals,
      currencyDecimals : currency.decimals,
      customerSnapshot : {
        customerCode : data.customerCode,
        revision     : customer.revision,
        name         :
          customer.tradeName ||
          customer.personProfile?.displayName ||
          [
            customer.personProfile?.name?.firstName,
            customer.personProfile?.name?.lastNamePaternal,
            customer.personProfile?.name?.lastNameMaternal,
          ]
            .filter(Boolean)
            .join(' ') ||
          customer.fiscal?.legalName ||
          customer.code ||
          data.customerCode,
      },
      issuerSnapshot   : {
        name      : issuer.name,
        legalName : issuer.legalName,
        taxId     : issuer.taxId,
      },
    };
  }
  /** @param {Object} sale Venta. @returns {Object[]} Partidas editables sin importes derivados. */
  function lines(sale) {
    return editable('document', { lines: sale.lines }).lines.map(
      /** @param {Object} line Partida histórica. @returns {Object} Captura fiscal. */ (line) => {
        const { amount: ignored, ...value } = line;
        return {
          ...value,
          taxes : line.taxes.map(
            /** @param {Object} tax Impuesto. @returns {Object} Definición original. */ (tax) => {
              const { base: ignoredBase, amount: ignoredAmount, ...definition } = tax;
              return definition;
            },
          ),
        };
      },
    );
  }
  /** @param {string} date Fecha civil. @param {string} periodicity Agrupación comercial. @returns {string} Periodo calendario; la semana comienza en lunes. */
  function periodKey(date, periodicity) {
    if (periodicity === '01') return date.slice(0, 10);
    if (periodicity === '02') {
      const day = new Date(date.slice(0, 10) + 'T00:00:00Z');
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      return day.toISOString().slice(0, 10);
    }
    if (periodicity === '03')
      return date.slice(0, 7) + (Number(date.slice(8, 10)) <= 15 ? '-1' : '-2');
    if (periodicity === '05')
      return date.slice(0, 4) + '-' + Math.ceil(Number(date.slice(5, 7)) / 2);
    return date.slice(0, 7);
  }
  /** @param {Object} tx Transacción. @param {Object[]} sales Ventas. @param {Object} input CFDI. @returns {Promise<Object>} Borrador fiscal reservado. */
  async function invoice(tx, sales, input) {
    const actor = context();
    for (const sale of sales) {
      await records.get('sale', sale.code, 'update', actor, tx);
      if (sale.status !== 'confirmed' || amount(sale.credited).gt(0))
        throw new ApplicationError(409, 'BILLING_SALE_NOT_AVAILABLE');
      if (sale.extractionCode && sale.extractionCode !== input.extractionCode)
        throw new ApplicationError(409, 'BILLING_SALE_RESERVED');
    }
    const { extractionCode, ...draft } = input;
    const document                     = await records.create('document', draft, sales);
    const environment                  = document.issuerSnapshot.environment;
    for (const sale of sales) {
      if (sale.fiscalDocuments[environment])
        throw new ApplicationError(409, 'BILLING_SALE_RESERVED');
      await tx.replace(
        'sale',
        sale,
        next(sale, {
          fiscalDocuments : {
            ...sale.fiscalDocuments,
            [environment] : document.code,
          },
          ...(environment === 'production' ? { fiscalStatus: 'reserved' } : {}),
        }),
      );
    }
    const current  = await records.get('document', document.code, 'view', actor, tx);
    const updated  = next(current, {
      saleCodes        : sales.map(
        /** @param {Object} sale Venta. @returns {string} Identidad. */ (sale) => sale.code,
      ),
      commercialSource : true,
    });
    const expected = sales.reduce(
      /** @param {Object} total Acumulado decimal. @param {Object} sale Venta. @returns {Object} Suma exacta. */ (
        total,
        sale,
      ) => total.plus(sale.total),
      amount('0'),
    );
    if (!amount(updated.total).eq(expected))
      throw new ApplicationError(409, 'BILLING_SALE_TOTAL_MISMATCH');
    await tx.replace('document', current, updated);
    return present('document', updated);
  }
  const service = {
    next,
    once,
    /** @param {Object} data Captura con intento estable. @returns {Promise<Object>} Borrador comercial. */
    async create(data) {
      billingAccess(context(), 'sale', 'create');
      const prepared = await prepare(data);
      return once(
        'sale-create',
        data,
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Alta auditada. */ async (
          tx,
        ) => {
          await tx.guardIssuer(await records.get('issuer', data.issuerCode));
          const sale = {
            ...prepared,
            ...records.metadata('sale', context()),
            status          : 'draft',
            paid            : '0',
            credited        : '0',
            balance         : '0',
            partiality      : 0,
            paymentStatus   : 'pending',
            fiscalStatus    : 'unbilled',
            fiscalDocuments : {},
            files           : {},
          };
          await tx.insert('sale', sale);
          await records.audit(tx, context(), 'sale', sale.code, 'created');
          return present('sale', sale);
        },
      );
    },
    /** @param {Object} data Captura y revisión. @returns {Promise<Object>} Borrador actualizado. */
    async update(data) {
      const previous = await records.get('sale', data.code, 'update');
      records.match(previous, data.revision);
      if (previous.status !== 'draft') throw new ApplicationError(409, 'BILLING_SALE_NOT_DRAFT');
      const prepared = await prepare(data, previous);
      return store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Revisión confirmada. */ async (
          tx,
        ) => {
          await tx.guardIssuer(await records.get('issuer', data.issuerCode));
          const updated = next(previous, prepared);
          await tx.replace('sale', previous, updated);
          await records.audit(tx, context(), 'sale', previous.code, 'updated');
          return present('sale', updated);
        },
      );
    },
    /** @param {Object} data Venta y pago inicial opcional. @returns {Promise<Object>} Venta y pago confirmados juntos. */
    async confirm(data) {
      billingAccess(context(), 'sale', 'update');
      return once(
        'sale-confirm',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Resultado comercial. */ async (
          tx,
        ) => {
          const sale = await records.get('sale', data.code, 'update', context(), tx);
          records.match(sale, data.revision);
          if (sale.status !== 'draft') throw new ApplicationError(409, 'BILLING_SALE_NOT_DRAFT');
          const issuer = await records.get('issuer', sale.issuerCode);
          if (!issuer.active) throw new ApplicationError(409, 'BILLING_ISSUER_INACTIVE');
          await tx.guardIssuer(issuer);
          const folio     =
            'V-' +
            (await tx.folio(
              {
                ...issuer,
                environment : 'commercial',
                series      : { S: 'V' },
              },
              'S',
            ));
          const confirmed = next(sale, {
            status         : 'confirmed',
            balance        : sale.total,
            remainingTaxes : structuredClone(sale.taxes),
            folio,
          });
          await tx.replace('sale', sale, confirmed);
          if (data.payment)
            await receipts.create({
              ...data.payment,
              issuerCode     : sale.issuerCode,
              customerCode   : sale.customerCode,
              currency       : sale.currency,
              exchangeRate   : sale.exchangeRate,
              allocations    : [
                {
                  saleCode    : sale.code,
                  amount      : data.payment.amount,
                  equivalence : '1',
                },
              ],
              idempotencyKey : hash(['initial-payment', sale.code, data.idempotencyKey]),
            });
          await records.audit(tx, context(), 'sale', sale.code, 'confirmed');
          return present('sale', await records.get('sale', sale.code, 'view', context(), tx));
        },
      );
    },
    /** @param {Object} data Venta y motivo. @returns {Promise<Object>} Cancelación comercial sin borrado. */
    async cancel(data) {
      billingAccess(context(), 'sale', 'delete');
      return once(
        'sale-cancel',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Cancelación auditada. */ async (
          tx,
        ) => {
          const sale = await records.get('sale', data.code, 'delete', context(), tx);
          records.match(sale, data.revision);
          if (!data.reason.trim() || sale.status === 'cancelled')
            throw new ApplicationError(409, 'BILLING_INVALID_SALE_CANCELLATION');
          if (
            amount(sale.paid).gt(0) ||
            amount(sale.credited).gt(0) ||
            Object.values(sale.fiscalDocuments).some(Boolean) ||
            sale.extractionCode
          )
            throw new ApplicationError(409, 'BILLING_REVERSE_DEPENDENCIES_FIRST');
          const updated = next(sale, {
            status             : 'cancelled',
            balance            : '0',
            cancellationReason : data.reason,
          });
          await tx.replace('sale', sale, updated);
          await records.audit(tx, context(), 'sale', sale.code, 'cancelled', data.reason);
          return present('sale', updated);
        },
      );
    },
    /** @param {Object} data Venta y preferencias fiscales. @returns {Promise<Object>} Factura pendiente de timbrado explícito. */
    async createInvoice(data) {
      billingAccess(context(), 'sale', 'update');
      return once(
        'sale-invoice',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Borrador reservado. */ async (
          tx,
        ) => {
          const sale = await records.get('sale', data.code, 'update', context(), tx);
          records.match(sale, data.revision);
          return invoice(tx, [sale], {
            type           : 'I',
            issuerCode     : sale.issuerCode,
            customerCode   : sale.customerCode,
            currency       : sale.currency,
            exchangeRate   : sale.exchangeRate,
            lines          : lines(sale),
            notes          : sale.notes,
            date           : data.date,
            paymentMethod  : data.paymentMethod,
            paymentForm    : data.paymentForm,
            cfdiUse        : data.cfdiUse,
            extractionCode : data.extractionCode,
          });
        },
      );
    },
    /** @param {Object} data Selección y periodo. @returns {Promise<Object>} Global derivada de ventas liquidadas. */
    async createGlobal(data) {
      billingAccess(context(), 'sale', 'update');
      return once(
        'sale-global',
        data,
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Reserva de todas las ventas o ninguna. */ async (
          tx,
        ) => {
          if (!data.saleCodes.length || new Set(data.saleCodes).size !== data.saleCodes.length)
            throw new ApplicationError(400, 'BILLING_INVALID_SALE_SELECTION');
          const sales = [];
          for (const code of data.saleCodes) {
            const sale  = await records.get('sale', code, 'update', context(), tx);
            const first = sales[0] || sale;
            if (
              sale.invoiceRequested ||
              !amount(sale.balance).eq(0) ||
              !amount(sale.paid).eq(sale.total) ||
              ['issuerCode', 'currency', 'exchangeRate'].some(
                /** @param {string} key Campo. @returns {boolean} Diferencia de agrupación. */ (
                  key,
                ) => sale[key] !== first[key],
              )
            )
              throw new ApplicationError(409, 'BILLING_GLOBAL_SALE_INELIGIBLE');
            if (
              first &&
              periodKey(sale.date, data.globalInfo.periodicity) !==
                periodKey(first.date, data.globalInfo.periodicity)
            )
              throw new ApplicationError(409, 'BILLING_GLOBAL_PERIOD_MISMATCH');
            const month    = Number(sale.date.slice(5, 7));
            const selected = Number(data.globalInfo.month);
            const months   =
              selected <= 12 ? [selected] : [(selected - 13) * 2 + 1, (selected - 13) * 2 + 2];
            if (Number(sale.date.slice(0, 4)) !== data.globalInfo.year || !months.includes(month))
              throw new ApplicationError(409, 'BILLING_GLOBAL_PERIOD_MISMATCH');
            sales.push(sale);
          }
          const first    = sales[0];
          const concepts = sales.flatMap(lines);
          if (concepts.length > 500) throw new ApplicationError(400, 'BILLING_TOO_MANY_LINES');
          return invoice(tx, sales, {
            type           : 'I',
            issuerCode     : first.issuerCode,
            customerCode   : '',
            currency       : first.currency,
            exchangeRate   : first.exchangeRate,
            lines          : concepts,
            notes          : '',
            date           : data.date,
            paymentMethod  : 'PUE',
            paymentForm    : data.paymentForm,
            cfdiUse        : 'S01',
            globalInfo     : {
              ...data.globalInfo,
              operationCodes : sales.map(
                /** @param {Object} sale Venta. @returns {string} Identidad comercial. */ (sale) =>
                  sale.code,
              ),
            },
            extractionCode : data.extractionCode,
          });
        },
      );
    },
  };
  return service;
}
module.exports = { salesService };
