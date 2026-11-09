/** @file Libro comercial único y aplicaciones fiscales derivadas; timbrar nunca vuelve a registrar dinero. */
'use strict';
const { ApplicationError }         = require('../../../shared/application-error');
const { amount, paymentTaxObject } = require('./amounts.service');
/** @param {Object} options Reloj y registros. @returns {Object} Coordinación transaccional entre ventas y documentos. */
function saleLedger({ clock, records }) {
  /** @param {Object} value Registro. @param {Object} changes Cambios. @returns {Object} Revisión siguiente. */
  function next(value, changes) {
    return {
      ...value,
      ...changes,
      revision   : value.revision + 1,
      updateDate : clock(),
    };
  }
  /** @param {Object} document CFDI. @param {Object} receipt Cobro original. @returns {Object[]} Aplicaciones fiscales sin modificar el cobro original. */
  function allocations(document, receipt) {
    return receipt.allocations.map(
      /** @param {Object} entry Aplicación comercial histórica. @returns {Object} Asociación fiscal. */ (
        entry,
      ) => ({
        ...entry,
        documentCode     : document.code,
        uuid             : document.uuid,
        series           : document.series,
        folio            : document.folio,
        paymentMethod    : document.paymentMethod,
        customerSnapshot : document.customerSnapshot,
        issuerSnapshot   : document.issuerSnapshot,
        taxObject        : paymentTaxObject(document.lines),
      }),
    );
  }
  /** @param {Object} tx Transacción. @param {Object} document CFDI confirmado. @returns {Promise<void>} Asociaciones fiscales recuperables para todos los cobros existentes. */
  async function bindReceipts(tx, document) {
    if (
      document.saleCodes?.length !== 1 ||
      document.globalInfo ||
      document.issuerSnapshot.environment !== 'production'
    )
      return;
    let page = 1;
    while (true) {
      const result = await tx.list(
        'receipt',
        {
          workspace : document.workspace,
          saleCode  : document.saleCodes[0],
          status    : 'confirmed',
        },
        {
          page,
          perPage : 100,
        },
      );
      for (const receipt of result.items) {
        if (receipt.fiscalDocumentCode === document.code) continue;
        await tx.replace(
          'receipt',
          receipt,
          next(receipt, {
            fiscalDocumentCode : document.code,
            fiscalAllocations  : allocations(document, receipt),
            repDocumentCode    : '',
          }),
        );
      }
      if (page++ * 100 >= result.pagination.total) break;
    }
  }
  return {
    allocations,
    /** @param {Object} tx Transacción. @param {Object} sale Venta. @returns {Promise<void>} Bloquea cambios de dinero durante cobertura global o extracción. */
    async assertPaymentMutable(tx, sale) {
      if (sale.extractionCode) throw new ApplicationError(409, 'BILLING_SALE_EXTRACTION_PENDING');
      for (const code of Object.values(sale.fiscalDocuments || {})) {
        const document = await tx.get('document', {
          workspace : sale.workspace,
          code,
        });
        if (document?.globalInfo && !['cancelled', 'discarded'].includes(document.status))
          throw new ApplicationError(409, 'BILLING_CANCEL_GLOBAL_FIRST');
      }
    },
    /** @param {Object} tx Transacción. @param {Object} document CFDI con fuentes. @returns {Promise<void>} Acredita que las reservas siguen perteneciendo al documento. */
    async assertReserved(tx, document) {
      if (document.globalInfo && !document.saleCodes?.length)
        for (const code of document.globalInfo.operationCodes) {
          if (
            await tx.get('sale', {
              workspace : document.workspace,
              code,
            })
          )
            throw new ApplicationError(409, 'BILLING_USE_SALES_GLOBAL');
        }
      for (const code of document.saleCodes || []) {
        const sale = await tx.get('sale', {
          workspace : document.workspace,
          code,
        });
        if (
          !sale ||
          sale.status !== 'confirmed' ||
          sale.fiscalDocuments[document.issuerSnapshot.environment] !== document.code
        )
          throw new ApplicationError(409, 'BILLING_SALE_RESERVATION_MISSING');
        if (
          document.globalInfo &&
          (!amount(sale.balance).eq(0) || !amount(sale.paid).eq(sale.total))
        )
          throw new ApplicationError(409, 'BILLING_GLOBAL_SALE_INELIGIBLE');
      }
    },
    /** @param {Object} tx Transacción. @param {Object} document CFDI emitido. @returns {Promise<Object>} Saldos derivados sin apertura de otra deuda. */
    async issued(tx, document) {
      if (!document.saleCodes?.length) return document;
      let paid   = amount('0'),
        balance  = amount('0'),
        credited = amount('0');
      let first;
      for (const code of document.saleCodes) {
        const sale = await tx.get('sale', {
          workspace : document.workspace,
          code,
        });
        first ||= sale;
        paid = paid.plus(sale.paid);
        balance = balance.plus(sale.balance);
        credited = credited.plus(sale.credited);
        if (document.issuerSnapshot.environment === 'production')
          await tx.replace(
            'sale',
            sale,
            next(sale, { fiscalStatus: document.globalInfo ? 'global' : 'individual' }),
          );
      }
      const updated = {
        ...document,
        paid     : paid.toFixed(document.currencyDecimals),
        balance  : balance.toFixed(document.currencyDecimals),
        credited : credited.toFixed(document.currencyDecimals),
        ...(document.globalInfo
          ? {}
          : {
              partiality     : first.partiality,
              remainingTaxes : structuredClone(first.remainingTaxes),
            }),
      };
      await bindReceipts(tx, updated);
      return updated;
    },
    /** @param {Object} tx Transacción. @param {Object} document Rechazado, descartado o cancelado. @returns {Promise<void>} Libera únicamente reservas propias. */
    async release(tx, document) {
      for (const code of document.saleCodes || []) {
        const sale        = await tx.get('sale', {
          workspace : document.workspace,
          code,
        });
        const environment = document.issuerSnapshot.environment;
        if (sale?.fiscalDocuments[environment] !== document.code) continue;
        const links = { ...sale.fiscalDocuments };
        delete links[environment];
        await tx.replace(
          'sale',
          sale,
          next(sale, {
            fiscalDocuments : links,
            ...(environment === 'production' ? { fiscalStatus: 'unbilled' } : {}),
          }),
        );
      }
    },
    /** @param {Object} tx Transacción. @param {Object} sale Venta modificada por pago. @returns {Promise<Object|null>} Proyección fiscal actualizada, sin efecto PAC. */
    async sync(tx, sale) {
      const code = sale.fiscalDocuments.production;
      if (!code) return null;
      const document = await tx.get('document', {
        workspace : sale.workspace,
        code,
      });
      if (!document || document.status !== 'issued') return null;
      if (document.globalInfo) throw new ApplicationError(409, 'BILLING_CANCEL_GLOBAL_FIRST');
      const updated = next(document, {
        paid           : sale.paid,
        credited       : sale.credited,
        balance        : sale.balance,
        partiality     : sale.partiality,
        remainingTaxes : structuredClone(sale.remainingTaxes),
      });
      await tx.replace('document', document, updated);
      return updated;
    },
    /** @param {Object} tx Transacción. @param {Object} invoice Factura modificada por nota de crédito. @returns {Promise<void>} Replica el crédito una sola vez al libro comercial. */
    async credit(tx, invoice) {
      if (!invoice.saleCodes?.length || invoice.issuerSnapshot.environment !== 'production') return;
      if (invoice.saleCodes.length !== 1 || invoice.globalInfo)
        throw new ApplicationError(409, 'BILLING_CANCEL_GLOBAL_FIRST');
      const sale = await tx.get('sale', {
        workspace : invoice.workspace,
        code      : invoice.saleCodes[0],
      });
      await tx.replace(
        'sale',
        sale,
        next(sale, {
          credited       : invoice.credited,
          balance        : amount(sale.total)
            .minus(sale.paid)
            .minus(invoice.credited)
            .toFixed(sale.currencyDecimals),
          creditReserved : invoice.creditReserved || '0',
          remainingTaxes : structuredClone(invoice.remainingTaxes),
          paymentStatus  : amount(invoice.balance).eq(0)
            ? 'paid'
            : amount(sale.paid).gt(0)
              ? 'partial'
              : 'pending',
        }),
      );
    },
    /** @param {Object} tx Transacción. @param {Object} document Documento por cancelar. @returns {Promise<void>} Rechaza cancelación con aplicaciones fiscales activas. */
    async cancellable(tx, document) {
      if (!document.saleCodes?.length) return;
      let page = 1;
      while (true) {
        const result = await tx.list(
          'receipt',
          {
            workspace          : document.workspace,
            fiscalDocumentCode : document.code,
            status             : 'confirmed',
          },
          {
            page,
            perPage : 100,
          },
        );
        for (const receipt of result.items) {
          const rep = await tx.get('document', {
            workspace   : document.workspace,
            receiptCode : receipt.code,
            status      : { $in: ['draft', 'queued', 'issued', 'uncertain', 'cancel-requested'] },
          });
          if (rep) throw new ApplicationError(409, 'BILLING_CANCEL_REP_FIRST');
        }
        if (page++ * 100 >= result.pagination.total) break;
      }
    },
  };
}
module.exports = { saleLedger };
