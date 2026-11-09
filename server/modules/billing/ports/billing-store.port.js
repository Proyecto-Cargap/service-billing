/** @file Contrato de persistencia: transacciones locales, revisión optimista y ausencia explícita. */
'use strict';
/** @param {Object} store Puerto inyectado. @returns {Object} Capacidades mínimas verificadas sin abrir conexiones. */
function billingStore(store) {
  for (const key of [
    'get',
    'list',
    'insert',
    'replace',
    'transaction',
    'receiptRead',
    'receiptInsert',
    'folio',
    'claim',
    'nextOperationAt',
    'nextExternalRefresh',
    'claimExpenseCleanup',
    'guardIssuer',
    'guardExpenseReference',
    'expenseTotals',
  ])
    if (typeof store?.[key] !== 'function') throw new TypeError('BILLING_STORE_REQUIRED:' + key);
  return store;
}
module.exports = { billingStore };
