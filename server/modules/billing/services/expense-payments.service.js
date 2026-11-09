/** @file Pagos a proveedores con aplicaciones atómicas, saldos exactos y reversión histórica. */
'use strict';
const { ApplicationError }    = require('../../../shared/application-error');
const { amount }              = require('./amounts.service');
const { billingAccess }       = require('../policies/billing-access.policy');
const { validateBillingDate } = require('./billing-date.service');
/** @param {Object} dependencies Puertos y reglas de gastos. @returns {Object} Registro y reversión de pagos sin banca ni PAC. */
function expensePayments({ records, expenses, references, context }) {
  /** @param {Object} tx Transacción. @param {Object} value Gasto. @param {Object} paid Importe acumulado. @returns {Promise<void>} Actualiza saldo y estado dentro del pago. */
  async function balance(tx, value, paid) {
    if (paid.lt(0) || paid.gt(value.total))
      throw new ApplicationError(409, 'BILLING_EXPENSE_PAYMENT_EXCEEDS_BALANCE');
    const remaining = amount(value.total).minus(paid);
    await tx.replace(
      'expense',
      value,
      expenses.next(value, {
        paid          : paid.toFixed(value.currencyDecimals),
        balance       : remaining.toFixed(value.currencyDecimals),
        paymentStatus : remaining.eq(0) ? 'paid' : paid.eq(0) ? 'pending' : 'partial',
      }),
    );
  }
  return {
    /** @param {Object} data Pago y aplicaciones. @returns {Promise<Object>} Pago confirmado y saldos actualizados exactamente una vez. */
    async create(data) {
      billingAccess(context(), 'expense-payment', 'create');
      validateBillingDate(data.date);
      if (data.paymentForm === '99')
        throw new ApplicationError(400, 'BILLING_INVALID_PAYMENT_FORM');
      await references.values([
        {
          kind : 'payment-form',
          code : data.paymentForm,
        },
      ]);
      const expected = amount(data.amount, true);
      return expenses.once(
        'expense-payment',
        'create',
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Pago con todas sus aplicaciones o rollback íntegro. */
        async (tx, actor) => {
          let sum = amount('0');
          const allocations = [],
            seen            = new Set();
          for (const allocation of data.allocations) {
            if (seen.has(allocation.expenseCode))
              throw new ApplicationError(400, 'BILLING_DUPLICATE_ALLOCATION');
            seen.add(allocation.expenseCode);
            const value = await records.get('expense', allocation.expenseCode, 'update', actor, tx);
            if (
              value.status !== 'confirmed' ||
              value.issuerCode !== data.issuerCode ||
              value.supplierCode !== data.supplierCode ||
              value.currency !== data.currency
            )
              throw new ApplicationError(409, 'BILLING_INVALID_EXPENSE_PAYMENT_TARGET');
            const applied = amount(allocation.amount, true);
            if (!applied.eq(applied.toDecimalPlaces(value.currencyDecimals)))
              throw new ApplicationError(400, 'BILLING_CURRENCY_PRECISION');
            await balance(tx, value, amount(value.paid).plus(applied));
            allocations.push({
              expenseCode      : value.code,
              amount           : applied.toFixed(value.currencyDecimals),
              previousBalance  : value.balance,
              remainingBalance : amount(value.balance)
                .minus(applied)
                .toFixed(value.currencyDecimals),
            });
            sum = sum.plus(applied);
          }
          if (!allocations.length || !sum.eq(expected))
            throw new ApplicationError(400, 'BILLING_PAYMENT_ALLOCATION_MISMATCH');
          const first = await records.get('expense', allocations[0].expenseCode, 'view', actor, tx);
          const value = {
            ...data,
            ...records.metadata('expense-payment', actor),
            allocations,
            amount           : sum.toFixed(first.currencyDecimals),
            supplierSnapshot : first.supplierSnapshot,
            issuerSnapshot   : first.issuerSnapshot,
            status           : 'confirmed',
            files            : [],
          };
          await tx.insert('expense-payment', value);
          await records.audit(tx, actor, 'expense-payment', value.code, 'confirmed');
          return value;
        },
      );
    },
    /** @param {Object} data Pago, revisión y motivo. @returns {Promise<Object>} Reversión integral que conserva sus aplicaciones originales. */
    async reverse(data) {
      if (!data.reason?.trim()) throw new ApplicationError(400, 'BILLING_REVERSAL_REASON_REQUIRED');
      return expenses.once(
        'expense-payment',
        'reverse',
        data,
        /** @param {Object} tx Transacción. @param {Object} actor Actor. @returns {Promise<Object>} Reversión y restitución de todos los saldos. */
        async (tx, actor) => {
          const payment = await records.get('expense-payment', data.code, 'delete', actor, tx);
          records.match(payment, data.revision);
          if (payment.status !== 'confirmed')
            throw new ApplicationError(409, 'BILLING_PAYMENT_ALREADY_REVERSED');
          for (const allocation of payment.allocations) {
            const value = await records.get('expense', allocation.expenseCode, 'update', actor, tx);
            if (value.status !== 'confirmed')
              throw new ApplicationError(409, 'BILLING_EXPENSE_INVALID_STATE');
            await balance(tx, value, amount(value.paid).minus(allocation.amount));
          }
          const updated = expenses.next(payment, {
            status         : 'reversed',
            reversalReason : data.reason,
          });
          await tx.replace('expense-payment', payment, updated);
          await records.audit(tx, actor, 'expense-payment', payment.code, 'reversed', data.reason);
          return updated;
        },
      );
    },
  };
}
module.exports = { expensePayments };
