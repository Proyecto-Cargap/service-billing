/** @file Cobros manuales y parcialidades transaccionales, independientes de la emisión y cancelación de REP. */
'use strict';
const { validateBillingDate }               = require('./billing-date.service');
const { ApplicationError }                  = require('../../../shared/application-error');
const { billingAccess }                     = require('../policies/billing-access.policy');
const { present }                           = require('../presenters/billing.presenter');
const { amount, Decimal, paymentTaxObject } = require('./amounts.service');
/** @param {Object} options Persistencia, referencias, contexto y utilidades puras inyectadas. @returns {Object} Casos de uso del cobro. */
function receiptsService({ store, records, references, context, clock, hash, ledger }) {
  const commercial = require('./sale-receipts.service').saleReceipts({
    store,
    records,
    references,
    context,
    clock,
    hash,
    ledger,
  });
  /** @param {Object} current Registro. @param {Object} changes Valores calculados. @returns {Object} Siguiente revisión. */
  function next(current, changes) {
    return {
      ...current,
      ...changes,
      revision   : current.revision + 1,
      updateDate : clock(),
    };
  }
  return {
    /** @param {Object} data Cobro y aplicaciones en moneda de cada factura. @returns {Promise<Object>} Cobro confirmado una sola vez o conflicto explícito. */
    async create(data) {
      if (
        data.allocations.some(
          /** @param {Object} entry Aplicación. @returns {boolean} Indica origen comercial. */ (
            entry,
          ) => entry.saleCode,
        )
      )
        return commercial.create(data);
      validateBillingDate(data.date);
      const actor = context();
      billingAccess(actor, 'receipt', 'create');
      if (
        data.paymentForm === '99' ||
        new Set(
          data.allocations.map(
            /** @param {Object} allocation Aplicación. @returns {string} Identidad de la factura. */
            (allocation) => allocation.documentCode,
          ),
        ).size !== data.allocations.length ||
        !data.allocations.length
      )
        throw new ApplicationError(400, 'BILLING_INVALID_RECEIPT');
      const sender = await records.historicalIssuer(
        await records.get('document', data.allocations[0].documentCode, 'view', actor),
        actor,
      );
      if (sender.code !== data.issuerCode)
        throw new ApplicationError(409, 'BILLING_INVALID_RECEIPT');
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
      amount(data.amount, true);
      if (!amount(data.amount).eq(amount(data.amount).toDecimalPlaces(currency.decimals)))
        throw new ApplicationError(400, 'BILLING_CURRENCY_PRECISION');
      await references.values([
        {
          kind : 'payment-form',
          code : data.paymentForm,
        },
      ]);
      const digest = hash(data),
        identity   = records.metadata('receipt', actor);
      const result = await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Cobro más libro de saldos atómicos. */
        async (tx) => {
          const existing = await tx.get('receipt', {
            workspace      : actor.workspace,
            idempotencyKey : data.idempotencyKey,
          });
          if (existing) {
            if (existing.digest !== digest || existing.userCreate !== actor.user.userCode)
              throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
            return existing;
          }
          let total         = new Decimal(0);
          const allocations = [];
          for (const allocation of data.allocations) {
            const invoice = await records.get(
              'document',
              allocation.documentCode,
              'view',
              actor,
              tx,
            );
            if (
              invoice.saleCodes?.length ||
              invoice.type !== 'I' ||
              invoice.status !== 'issued' ||
              invoice.issuerCode !== data.issuerCode ||
              invoice.customerCode !== data.customerCode ||
              (allocations.length > 0 &&
                allocations[0].issuerSnapshot.environment !== invoice.issuerSnapshot.environment)
            )
              throw new ApplicationError(409, 'BILLING_INVALID_RECEIPT_TARGET');
            const paid  = amount(allocation.amount, true),
              balance   = amount(invoice.balance),
              available = balance.minus(invoice.creditReserved || '0');
            if (
              amount(invoice.creditReserved || '0').gt(0) ||
              paid.gt(available) ||
              !paid.eq(paid.toDecimalPlaces(invoice.currencyDecimals)) ||
              (invoice.currency === data.currency && !amount(allocation.equivalence).eq(1))
            )
              throw new ApplicationError(409, 'BILLING_RECEIPT_EXCEEDS_BALANCE');
            total = total.plus(paid.div(amount(allocation.equivalence, true)));
            const taxes          = (invoice.remainingTaxes || invoice.taxes).map(
              /** @param {Object} tax Saldo fiscal por grupo. @returns {Object} Parte pagada, conservando el residuo exacto en el último pago. */
              (tax) => ({
                ...tax,
                base   : paid.eq(balance)
                  ? tax.base
                  : amount(tax.base).mul(paid).div(balance).toFixed(6),
                amount : paid.eq(balance)
                  ? tax.amount
                  : amount(tax.amount).mul(paid).div(balance).toFixed(6),
              }),
            );
            const remainingTaxes = (invoice.remainingTaxes || invoice.taxes).map(
              /** @param {Object} tax Saldo previo. @param {number} index Grupo estable. @returns {Object} Saldo fiscal después del cobro. */
              (tax, index) => ({
                ...tax,
                base   : amount(tax.base).minus(taxes[index].base).toFixed(6),
                amount : amount(tax.amount).minus(taxes[index].amount).toFixed(6),
              }),
            );
            const remainingBalance = balance.minus(paid).toFixed(invoice.currencyDecimals),
              partiality           = (invoice.partiality || 0) + 1;
            allocations.push({
              ...allocation,
              taxes,
              remainingBalance,
              previousBalance  : invoice.balance,
              partiality,
              currency         : invoice.currency,
              uuid             : invoice.uuid,
              series           : invoice.series,
              folio            : invoice.folio,
              paymentMethod    : invoice.paymentMethod,
              taxObject        : paymentTaxObject(invoice.lines),
              customerSnapshot : invoice.customerSnapshot,
              issuerSnapshot   : invoice.issuerSnapshot,
            });
            await tx.replace(
              'document',
              invoice,
              next(invoice, {
                paid    : amount(invoice.paid).plus(paid).toFixed(invoice.currencyDecimals),
                balance : remainingBalance,
                partiality,
                remainingTaxes,
              }),
            );
          }
          if (!total.toDecimalPlaces(currency.decimals).eq(data.amount))
            throw new ApplicationError(400, 'BILLING_RECEIPT_ALLOCATION_MISMATCH');
          const receipt = {
            ...data,
            ...identity,
            digest,
            status          : 'confirmed',
            allocations,
            repDocumentCode : '',
          };
          await tx.insert('receipt', receipt);
          await records.audit(tx, actor, 'receipt', receipt.code, 'confirmed');
          return receipt;
        },
      );
      return present('receipt', result);
    },
    /** @param {Object} data Cobro, revisión y motivo obligatorio. @returns {Promise<Object>} Reversión contable explícita que nunca cancela automáticamente un CFDI. */
    async reverse(data) {
      if ((await records.get('receipt', data.code, 'delete')).saleCode)
        return commercial.reverse(data);
      const actor = context();
      billingAccess(actor, 'receipt', 'delete');
      if (!data.reason.trim()) throw new ApplicationError(400, 'BILLING_REVERSAL_REASON_REQUIRED');
      const result = await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Reversión integral o rechazo sin efectos parciales. */
        async (tx) => {
          const receipt = await records.get('receipt', data.code, 'delete', actor, tx);
          records.match(receipt, data.revision);
          if (receipt.status !== 'confirmed')
            throw new ApplicationError(409, 'BILLING_RECEIPT_ALREADY_REVERSED');
          const activeRep = await tx.get('document', {
            workspace   : actor.workspace,
            receiptCode : receipt.code,
            status      : { $in: ['draft', 'queued', 'issued', 'uncertain', 'cancel-requested'] },
          });
          if (activeRep) throw new ApplicationError(409, 'BILLING_CANCEL_REP_FIRST');
          for (const allocation of receipt.allocations) {
            const invoice = await records.get(
              'document',
              allocation.documentCode,
              'view',
              actor,
              tx,
            );
            if (
              !['issued', 'cancelled'].includes(invoice.status) ||
              invoice.partiality !== allocation.partiality ||
              amount(invoice.creditReserved || '0').gt(0)
            )
              throw new ApplicationError(409, 'BILLING_REVERSE_LATEST_RECEIPT_FIRST');
            const remainingTaxes = invoice.remainingTaxes.map(
              /** @param {Object} tax Saldo actual. @param {number} index Grupo estable. @returns {Object} Restituye exactamente el impuesto aplicado. */
              (tax, index) => ({
                ...tax,
                base   : amount(tax.base).plus(allocation.taxes[index].base).toFixed(6),
                amount : amount(tax.amount).plus(allocation.taxes[index].amount).toFixed(6),
              }),
            );
            await tx.replace(
              'document',
              invoice,
              next(invoice, {
                paid       : amount(invoice.paid)
                  .minus(allocation.amount)
                  .toFixed(invoice.currencyDecimals),
                balance    :
                  invoice.status === 'cancelled'
                    ? '0'
                    : amount(invoice.balance)
                        .plus(allocation.amount)
                        .toFixed(invoice.currencyDecimals),
                partiality : invoice.partiality - 1,
                remainingTaxes,
              }),
            );
          }
          const updated = next(receipt, {
            status         : 'reversed',
            reversalReason : data.reason,
          });
          await tx.replace('receipt', receipt, updated);
          await records.audit(tx, actor, 'receipt', receipt.code, 'reversed', data.reason);
          return updated;
        },
      );
      return present('receipt', result);
    },
    /** @param {Object} data Cobro, revisión y fecha de emisión. @returns {Promise<Object>} Un REP borrador por cobro, preservando aplicaciones históricas. */
    async createRep(data) {
      validateBillingDate(data.date);
      const actor = context();
      billingAccess(actor, 'document', 'create');
      const result = await store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Borrador único, sin ejecutar timbrado. */
        async (tx) => {
          const receipt = await records.get('receipt', data.code, 'update', actor, tx);
          records.match(receipt, data.revision);
          if (receipt.saleCode) {
            if (!receipt.fiscalDocumentCode || !receipt.fiscalAllocations?.length)
              throw new ApplicationError(409, 'BILLING_SALE_NOT_INVOICED');
            const invoice = await records.get(
              'document',
              receipt.fiscalDocumentCode,
              'view',
              actor,
              tx,
            );
            if (invoice.status !== 'issued')
              throw new ApplicationError(409, 'BILLING_SALE_NOT_INVOICED');
          }
          const fiscalAllocations = receipt.fiscalAllocations || receipt.allocations;
          if (
            receipt.status !== 'confirmed' ||
            fiscalAllocations.some(
              /** @param {Object} allocation Aplicación histórica. @returns {boolean} PUE no pertenece a un REP. */
              (allocation) => allocation.paymentMethod !== 'PPD',
            )
          )
            throw new ApplicationError(409, 'BILLING_REP_REQUIRES_PPD');
          let previous;
          if (receipt.repDocumentCode) {
            previous = await tx.get('document', {
              code      : receipt.repDocumentCode,
              workspace : actor.workspace,
            });
            if (
              !previous ||
              (!['cancelled', 'discarded'].includes(previous.status) &&
                !(previous.status === 'issued' && data.replaceDocumentCode === previous.code))
            )
              throw new ApplicationError(409, 'BILLING_REP_ALREADY_EXISTS');
            if (previous.relatedDocumentCode) {
              const older = await tx.get('document', {
                workspace : actor.workspace,
                code      : previous.relatedDocumentCode,
              });
              if (older && older.status !== 'cancelled')
                throw new ApplicationError(409, 'BILLING_CANCEL_PREVIOUS_REP_FIRST');
            }
          }
          const first = fiscalAllocations[0],
            document  = {
              ...records.metadata('document', actor),
              type             : 'P',
              issuerCode       : receipt.issuerCode,
              customerCode     : receipt.customerCode,
              receiptCode      : receipt.code,
              date             : data.date,
              currency         : 'XXX',
              currencyDecimals : 0,
              exchangeRate     : '1',
              subtotal         : '0',
              discount         : '0',
              transferred      : '0',
              withheld         : '0',
              total            : '0',
              paid             : '0',
              credited         : '0',
              balance          : '0',
              lines            : [],
              taxes            : [],
              customerSnapshot : first.customerSnapshot,
              issuerSnapshot   : first.issuerSnapshot,
              status           : 'draft',
              files            : {},
              deliveryStatus   : 'pending',
              ...(previous?.uuid
                ? {
                    relatedDocumentCode : previous.code,
                    relatedUuid         : previous.uuid,
                    relationship        : '04',
                  }
                : {}),
            };
          await tx.insert('document', document);
          await tx.replace('receipt', receipt, next(receipt, { repDocumentCode: document.code }));
          await records.audit(tx, actor, 'document', document.code, 'rep-draft-created');
          return document;
        },
      );
      return present('document', result);
    },
  };
}
module.exports = { receiptsService };
