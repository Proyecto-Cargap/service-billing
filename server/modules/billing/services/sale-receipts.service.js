/** @file Cobros comerciales parciales y reversión sobre una venta; no requieren factura ni PAC. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { billingAccess }       = require('../policies/billing-access.policy');
const { present }             = require('../presenters/billing.presenter');
const { amount }              = require('./amounts.service');
const { validateBillingDate } = require('./billing-date.service');
/** @param {Object} dependencies Puertos y libro comercial. @returns {Object} Cobros atómicos con identidad persistente. */
function saleReceipts({ store, records, references, context, clock, hash, ledger }) {
  /** @param {Object} value Registro. @param {Object} changes Cambios. @returns {Object} Revisión siguiente. */
  function next(value, changes) {
    return {
      ...value,
      ...changes,
      revision   : value.revision + 1,
      updateDate : clock(),
    };
  }
  return {
    /** @param {Object} data Pago y aplicación única. @returns {Promise<Object>} Cobro confirmado sin duplicar el libro fiscal. */
    async create(data) {
      const actor = context();
      billingAccess(actor, 'receipt', 'create');
      validateBillingDate(data.date);
      if (
        data.allocations.length !== 1 ||
        !data.allocations[0].saleCode ||
        data.allocations[0].documentCode ||
        data.paymentForm === '99' ||
        !data.idempotencyKey.trim()
      )
        throw new ApplicationError(400, 'BILLING_INVALID_RECEIPT');
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
      const digest = hash(data);
      return store.transaction(
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Cobro y saldo confirmados juntos. */ async (
          tx,
        ) => {
          const existing = await tx.get('receipt', {
            workspace      : actor.workspace,
            idempotencyKey : data.idempotencyKey,
          });
          if (existing) {
            await records.get('receipt', existing.code, 'view', actor, tx);
            if (existing.digest !== digest || existing.userCreate !== actor.user.userCode)
              throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
            return present('receipt', existing);
          }
          const input = data.allocations[0];
          const sale  = await records.get('sale', input.saleCode, 'update', actor, tx);
          await records.historicalIssuer(sale, actor, tx);
          await ledger.assertPaymentMutable(tx, sale);
          if (
            sale.status !== 'confirmed' ||
            sale.issuerCode !== data.issuerCode ||
            sale.customerCode !== data.customerCode
          )
            throw new ApplicationError(409, 'BILLING_INVALID_RECEIPT_TARGET');
          const paid    = amount(input.amount, true),
            balance     = amount(sale.balance),
            equivalence = amount(input.equivalence, true);
          if (
            paid.gt(balance) ||
            amount(sale.creditReserved || '0').gt(0) ||
            !paid.eq(paid.toDecimalPlaces(sale.currencyDecimals))
          )
            throw new ApplicationError(409, 'BILLING_RECEIPT_EXCEEDS_BALANCE');
          if (
            (sale.currency === data.currency && !equivalence.eq(1)) ||
            !paid.div(equivalence).toDecimalPlaces(currency.decimals).eq(data.amount)
          )
            throw new ApplicationError(400, 'BILLING_RECEIPT_ALLOCATION_MISMATCH');
          const taxes            = (sale.remainingTaxes || sale.taxes).map(
            /** @param {Object} tax Impuesto pendiente. @returns {Object} Prorrateo con residuo final exacto. */ (
              tax,
            ) => ({
              ...tax,
              base   : paid.eq(balance)
                ? tax.base
                : amount(tax.base).mul(paid).div(balance).toFixed(6),
              amount : paid.eq(balance)
                ? tax.amount
                : amount(tax.amount).mul(paid).div(balance).toFixed(6),
            }),
          );
          const remainingTaxes   = (sale.remainingTaxes || sale.taxes).map(
            /** @param {Object} tax Impuesto. @param {number} i Índice. @returns {Object} Saldo fiscal restante. */ (
              tax,
              i,
            ) => ({
              ...tax,
              base   : amount(tax.base).minus(taxes[i].base).toFixed(6),
              amount : amount(tax.amount).minus(taxes[i].amount).toFixed(6),
            }),
          );
          const remainingBalance = balance.minus(paid).toFixed(sale.currencyDecimals);
          const partiality       = (sale.partiality || 0) + 1;
          const updated          = next(sale, {
            paid          : amount(sale.paid).plus(paid).toFixed(sale.currencyDecimals),
            balance       : remainingBalance,
            partiality,
            remainingTaxes,
            paymentStatus : amount(remainingBalance).eq(0) ? 'paid' : 'partial',
          });
          await tx.replace('sale', sale, updated);
          const document = await ledger.sync(tx, updated);
          const receipt  = {
            ...data,
            ...records.metadata('receipt', actor),
            digest,
            saleCode        : sale.code,
            status          : 'confirmed',
            allocations     : [
              {
                ...input,
                taxes,
                previousBalance : sale.balance,
                remainingBalance,
                partiality,
                currency        : sale.currency,
              },
            ],
            repDocumentCode : '',
            files           : {},
          };
          if (document) {
            receipt.fiscalDocumentCode = document.code;
            receipt.fiscalAllocations = ledger.allocations(document, receipt);
          }
          await tx.insert('receipt', receipt);
          await records.audit(tx, actor, 'receipt', receipt.code, 'confirmed');
          return present('receipt', receipt);
        },
      );
    },
    /** @param {Object} data Cobro, revisión y motivo. @returns {Promise<Object>} Reversión exacta en orden inverso. */
    async reverse(data) {
      const actor = context();
      billingAccess(actor, 'receipt', 'delete');
      if (!data.reason.trim()) throw new ApplicationError(400, 'BILLING_REVERSAL_REASON_REQUIRED');
      return store.transaction(
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Restitución integral. */ async (
          tx,
        ) => {
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
          const entry = receipt.allocations[0];
          const sale  = await records.get('sale', receipt.saleCode, 'update', actor, tx);
          await ledger.assertPaymentMutable(tx, sale);
          if (sale.partiality !== entry.partiality || amount(sale.creditReserved || '0').gt(0))
            throw new ApplicationError(409, 'BILLING_REVERSE_LATEST_RECEIPT_FIRST');
          const paid    = amount(sale.paid).minus(entry.amount).toFixed(sale.currencyDecimals);
          const updated = next(sale, {
            paid,
            balance        : amount(sale.balance).plus(entry.amount).toFixed(sale.currencyDecimals),
            partiality     : sale.partiality - 1,
            remainingTaxes : sale.remainingTaxes.map(
              /** @param {Object} tax Impuesto pendiente. @param {number} i Índice. @returns {Object} Restituye exactamente el importe aplicado. */ (
                tax,
                i,
              ) => ({
                ...tax,
                base   : amount(tax.base).plus(entry.taxes[i].base).toFixed(6),
                amount : amount(tax.amount).plus(entry.taxes[i].amount).toFixed(6),
              }),
            ),
            paymentStatus  : amount(paid).eq(0) ? 'pending' : 'partial',
          });
          await tx.replace('sale', sale, updated);
          await ledger.sync(tx, updated);
          const reversed = next(receipt, {
            status         : 'reversed',
            reversalReason : data.reason,
          });
          await tx.replace('receipt', receipt, reversed);
          await records.audit(tx, actor, 'receipt', receipt.code, 'reversed', data.reason);
          return present('receipt', reversed);
        },
      );
    },
  };
}
module.exports = { saleReceipts };
