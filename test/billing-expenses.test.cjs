/** @file Aceptación de gastos y pagos sin efectos fiscales. */
'use strict';
const test                          = require('node:test');
const assert                        = require('node:assert/strict');
const { randomUUID }                = require('node:crypto');
const dto                           = require('../server/contracts/registry');
const { setup, confirmed, payment } = require('./expense-fixture.cjs');
test('gasto sin CSD: contratos, pago a varios gastos, idempotencia y reversión histórica', /** @returns {Promise<void>} Comprueba atomicidad de los saldos y ausencia de PAC. */ async () => {
  const app = await setup();
  const first = await confirmed(app),
    second    = await confirmed(app);
  const input = payment([first, second], ['40', '116']);
  dto['billing-expense-payment-create'].input(input);
  const paid = await app.expensePayments.create(input);
  dto['billing-expense-payment-create'].output({
    statusCode      : 201,
    descriptionCode : 'OK',
    data            : paid,
  });
  assert.equal((await app.expensePayments.create(input)).code, paid.code);
  assert.equal((await app.records.getOne('expense', { code: first.code })).balance, '76.00');
  assert.equal((await app.records.getOne('expense', { code: second.code })).paymentStatus, 'paid');
  await app.expensePayments.reverse({
    code           : paid.code,
    revision       : paid.revision,
    reason         : 'Corrección',
    idempotencyKey : randomUUID(),
  });
  assert.equal((await app.records.getOne('expense', { code: second.code })).balance, '116.00');
  assert.equal(paid.allocations[1].remainingBalance, '0.00');
  assert.equal(app.calls.length, 0);
});
test('sobrepago, reparto incorrecto y monedas distintas revierten todas las aplicaciones', /** @returns {Promise<void>} Acredita rollback completo. */ async () => {
  const app = await setup(),
    first   = await confirmed(app),
    second  = await confirmed(app);
  await assert.rejects(app.expensePayments.create(payment([first, second], ['40', '117'])), {
    descriptionCode : 'BILLING_EXPENSE_PAYMENT_EXCEEDS_BALANCE',
  });
  await assert.rejects(
    app.expensePayments.create({
      ...payment([first], ['40']),
      amount : '41',
    }),
    { descriptionCode: 'BILLING_PAYMENT_ALLOCATION_MISMATCH' },
  );
  await assert.rejects(
    app.expensePayments.create({
      ...payment([first], ['40']),
      currency : 'USD',
    }),
    { descriptionCode: 'BILLING_INVALID_EXPENSE_PAYMENT_TARGET' },
  );
  assert.equal((await app.records.getOne('expense', { code: first.code })).paid, '0');
});
test('pagos concurrentes, cancelación, revisión y permisos mantienen saldos', /** @returns {Promise<void>} Sólo una aplicación puede consumir el saldo disponible. */ async () => {
  const app = await setup(),
    expense = await confirmed(app);
  const results = await Promise.allSettled([
    app.expensePayments.create(payment([expense], ['100'])),
    app.expensePayments.create(payment([expense], ['100'])),
  ]);
  assert.equal(
    results.filter(
      /** @param {Object} value Resultado. @returns {boolean} Confirmado. */ (value) =>
        value.status === 'fulfilled',
    ).length,
    1,
  );
  const current = await app.records.getOne('expense', { code: expense.code });
  await assert.rejects(
    app.expenses.transition('cancel', {
      code           : current.code,
      revision       : current.revision,
      reason         : 'Baja',
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_REVERSE_DEPENDENCIES_FIRST' },
  );
  app.actor.workspace = 'W2';
  await assert.rejects(app.records.getOne('expense', { code: expense.code }), {
    descriptionCode : 'BILLING_NOT_FOUND',
  });
  assert.equal(
    (await app.records.getOne('expense-category', { code: app.category.code })).workspace,
    'allWorkspaces',
  );
});
test('clasificación global inactiva y cambios monetarios confirmados son rechazados', /** @returns {Promise<void>} Conserva importes y proyecciones históricas al corregir notas. */ async () => {
  const app = await setup(),
    expense = await confirmed(app);
  await assert.rejects(
    app.expenses.update({
      code           : expense.code,
      revision       : expense.revision,
      currency       : 'USD',
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_EXPENSE_AMOUNTS_LOCKED' },
  );
  const updated = await app.expenses.update({
    code           : expense.code,
    revision       : expense.revision,
    notes          : 'Nota corregida',
    idempotencyKey : randomUUID(),
  });
  assert.deepEqual(updated.lines, expense.lines);
  await app.expenses.catalogSave('expense-category', {
    ...app.category,
    active         : false,
    idempotencyKey : randomUUID(),
  });
  await assert.rejects(
    app.expenses.create({
      ...app.input,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_CLASSIFICATION_INACTIVE' },
  );
});
test('MCP revalida conexión y permisos incluso al recuperar un recibo confirmado', /** @returns {Promise<void>} La idempotencia no conserva permisos revocados. */ async () => {
  const app = await setup();
  app.actor.delegation = {
    grantCode : 'G1',
    clientId  : 'C1',
  };
  app.actor.operation = { idempotencyKey: randomUUID() };
  /** @returns {Promise<Object>} Intención delegada mediante el ejecutor canónico. */
  const execute = () =>
    app.delegated.execute('billing-expense-create', app.input, app.expenses.create);
  const value   = await execute();
  assert.equal((await execute()).code, value.code);
  app.state.revoked = true;
  await assert.rejects(execute(), { descriptionCode: 'OAUTH_CONNECTION_REVOKED' });
  app.state.revoked = false;
  app.actor.policies = [];
  await assert.rejects(execute(), { descriptionCode: 'IDEMPOTENCY_PERMISSION_CHANGED' });
});
test('confirmación rechaza una empresa desactivada después de capturar el borrador', /** @returns {Promise<void>} No genera saldo cuando la referencia deja de estar disponible. */ async () => {
  const app = await setup(),
    draft   = await app.expenses.create(app.input);
  const issuer = await app.store.get('issuer', { code: draft.issuerCode });
  await app.store.replace('issuer', issuer, {
    ...issuer,
    active   : false,
    revision : issuer.revision + 1,
  });
  await assert.rejects(
    app.expenses.transition('confirm', {
      code           : draft.code,
      revision       : draft.revision,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_ISSUER_INACTIVE' },
  );
  assert.equal((await app.records.getOne('expense', { code: draft.code })).balance, '0');
});
