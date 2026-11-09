/** @file Aceptación del flujo fiscal y de cobranza con puertos aislados y fallos reproducibles. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { randomUUID }                    = require('node:crypto');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
const dtos                              = require('../server/contracts/registry');
/** @param {Object} document Factura. @param {string} amount Importe aplicado. @returns {Object} Cobro manual con clave idempotente. */
function payment(document, amount = '58') {
  return {
    issuerCode     : document.issuerCode,
    customerCode   : document.customerCode,
    currency       : 'MXN',
    exchangeRate   : '1',
    amount,
    date           : '2026-10-22T07:00:00',
    paymentForm    : '03',
    reference      : 'Transferencia',
    allocations    : [
      {
        documentCode : document.code,
        amount,
        equivalence  : '1',
      },
    ],
    idempotencyKey : randomUUID(),
  };
}
test('el borrador distingue estado comercial de datos fiscales incompletos' /** @returns {Promise<void>} Rechaza prospectos sin atribuir el bloqueo al domicilio y acepta al cliente fiscalmente completo. */, async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.customer.state = 'prospect';
  await assert.rejects(draft(app, sender), {
    statusCode      : 409,
    descriptionCode : 'BILLING_CUSTOMER_STATE_INVALID',
  });
  assert.equal((await app.store.list('document', {})).items.length, 0);
  app.customer.state = 'customer';
  app.customer.fiscal.address.postalCode = '';
  await assert.rejects(draft(app, sender), {
    statusCode      : 409,
    descriptionCode : 'BILLING_CUSTOMER_FISCAL_DATA_INCOMPLETE',
  });
  app.customer.fiscal.address.postalCode = '01000';
  assert.equal((await draft(app, sender)).status, 'draft');
  assert.equal(app.calls.length, 0);
});
test('el timbrado revalida el estado comercial antes de encolar una operación' /** @returns {Promise<void>} Conserva el borrador y evita cualquier efecto PAC si el receptor deja de ser cliente. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender);
  app.customer.state = 'prospect';
  await assert.rejects(
    app.commands.enqueue('issue', {
      code           : document.code,
      revision       : document.revision,
      idempotencyKey : randomUUID(),
    }),
    {
      statusCode      : 409,
      descriptionCode : 'BILLING_CUSTOMER_STATE_INVALID',
    },
  );
  assert.equal((await app.records.getOne('document', { code: document.code })).status, 'draft');
  assert.equal((await app.store.list('operation', {})).items.length, 0);
  assert.equal(app.calls.length, 0);
});
test('factura, pago parcial, REP y cancelación conservan estados y saldos independientes' /** @returns {Promise<void>} Comprueba efectos transaccionales y contratos de salida. */, async () => {
  const app = fixture(),
    sender  = await issuer(app),
    invoice = await issue(app, await draft(app, sender));
  assert.equal(invoice.status, 'issued');
  assert.equal(invoice.balance, '116.00');
  assert.equal(invoice.customerSnapshot.fiscal.postalCode, '01000');
  assert.equal(sender.secretEnvelope, undefined);
  dtos['billing-document-get-one'].output({
    statusCode      : 200,
    descriptionCode : 'OK',
    data            : invoice,
  });
  const input = payment(invoice),
    receipt   = await app.receipts.create(input),
    duplicate = await app.receipts.create(input);
  assert.equal(receipt.code, duplicate.code);
  assert.equal((await app.records.getOne('document', { code: invoice.code })).balance, '58.00');
  const rep    = await issue(
    app,
    await app.receipts.createRep({
      code     : receipt.code,
      revision : receipt.revision,
      date     : '2026-10-22T08:00:00',
    }),
  );
  const layout = app.calls[1].Comprobante.Complemento[0].Pagos20;
  assert.equal(layout.Totales.MontoTotalPagos, '58.00');
  assert.equal(layout.Totales.TotalTrasladosBaseIVA16, '50.00');
  assert.equal(layout.Totales.TotalTrasladosImpuestoIVA16, '8.00');
  await app.commands.enqueue('cancel', {
    code           : rep.code,
    revision       : rep.revision,
    idempotencyKey : randomUUID(),
    reason         : '02',
  });
  await app.effects.tick();
  assert.equal(
    (await app.records.getOne('document', { code: rep.code })).status,
    'cancel-requested',
  );
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('reconcile', {
    code           : rep.code,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: rep.code })).status, 'cancelled');
  assert.equal((await app.records.getOne('document', { code: invoice.code })).paid, '58.00');
  const currentReceipt = await app.records.getOne('receipt', { code: receipt.code });
  await app.receipts.reverse({
    code     : receipt.code,
    revision : currentReceipt.revision,
    reason   : 'Pago duplicado en captura',
  });
  assert.equal((await app.records.getOne('document', { code: invoice.code })).balance, '116.00');
});
test('un timeout no repite el timbrado y se recupera por UUID sin volver a emitir' /** @returns {Promise<void>} Verifica incertidumbre e idempotencia del efecto. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender),
    input    = {
      code           : document.code,
      revision       : document.revision,
      idempotencyKey : randomUUID(),
    };
  app.state.pacError = true;
  const operation = await app.commands.enqueue('issue', input);
  await app.effects.tick();
  await app.effects.tick();
  assert.equal(app.calls.length, 1);
  assert.equal((await app.records.getOne('document', { code: document.code })).status, 'uncertain');
  assert.equal((await app.commands.enqueue('issue', input)).code, operation.code);
  await assert.rejects(
    app.commands.enqueue('issue', {
      ...input,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_DOCUMENT_NOT_DRAFT' },
  );
  const recoveredUuid = randomUUID().toUpperCase();
  await app.commands.enqueue('reconcile', {
    code           : document.code,
    uuid           : recoveredUuid,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: document.code })).uuid, recoveredUuid);
  assert.equal(app.calls.length, 1);
});
test('un fallo documental conserva el timbrado y permite recuperar archivos sin duplicar saldos' /** @returns {Promise<void>} Separa aceptación fiscal de disponibilidad de Documents. */, async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.state.uploadError = true;
  const document = await issue(app, await draft(app, sender));
  assert.equal(document.status, 'issued');
  assert.equal(document.balance, '116.00');
  assert.deepEqual(document.files, {});
  app.state.uploadError = false;
  await app.commands.enqueue('reconcile', {
    code           : document.code,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  const recovered = await app.records.getOne('document', { code: document.code });
  assert.ok(recovered.files.pdf);
  assert.equal(recovered.balance, '116.00');
  assert.equal(app.calls.length, 1);
});
test('dos cobros concurrentes no pueden exceder el saldo y un cambio fiscal exige refrescar el borrador' /** @returns {Promise<void>} Verifica el límite de saldo y la propiedad de datos fiscales en Customer. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await issue(app, await draft(app, sender));
  const results = await Promise.allSettled([
    app.receipts.create(payment(document, '100')),
    app.receipts.create(payment(document, '100')),
  ]);
  assert.equal(
    results.filter(
      /** @param {Object} result Resultado concurrente. @returns {boolean} Cobro confirmado. */
      (result) => result.status === 'fulfilled',
    ).length,
    1,
  );
  assert.equal((await app.records.getOne('document', { code: document.code })).balance, '16.00');
  const fresh = await draft(app, sender);
  app.customer.fiscal.address.postalCode = '02000';
  await assert.rejects(
    app.commands.enqueue('issue', {
      code           : fresh.code,
      revision       : fresh.revision,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_CUSTOMER_SNAPSHOT_CHANGED' },
  );
  const updated = await app.records.refreshCustomer({
    code     : fresh.code,
    revision : fresh.revision,
  });
  assert.equal(updated.customerSnapshot.fiscal.postalCode, '02000');
});
test('descartar un REP sin timbrar permite corregir o revertir el cobro sin borrar evidencia', /** @returns {Promise<void>} Sólo el borrador se descarta y el dinero cambia mediante reversión explícita. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    invoice = await issue(app, await draft(app, sender));
  const receipt = await app.receipts.create(payment(invoice));
  let rep       = await app.receipts.createRep({
    code     : receipt.code,
    revision : receipt.revision,
    date     : '2026-10-22T08:00:00',
  });
  let current   = await app.records.getOne('receipt', { code: receipt.code });
  await assert.rejects(
    app.receipts.reverse({
      code     : current.code,
      revision : current.revision,
      reason   : 'Corrección',
    }),
    { descriptionCode: 'BILLING_CANCEL_REP_FIRST' },
  );
  await app.records.discard({
    code     : rep.code,
    revision : rep.revision,
    reason   : 'Fecha equivocada',
  });
  assert.equal((await app.records.getOne('document', { code: invoice.code })).paid, '58.00');
  current = await app.records.getOne('receipt', { code: receipt.code });
  rep = await app.receipts.createRep({
    code     : current.code,
    revision : current.revision,
    date     : '2026-10-22T09:00:00',
  });
  assert.equal(rep.relatedDocumentCode, undefined);
  await app.records.discard({
    code     : rep.code,
    revision : rep.revision,
    reason   : 'Cobro duplicado',
  });
  current = await app.records.getOne('receipt', { code: receipt.code });
  await app.receipts.reverse({
    code     : current.code,
    revision : current.revision,
    reason   : 'Cobro duplicado',
  });
  assert.equal((await app.records.getOne('document', { code: invoice.code })).balance, '116.00');
  await assert.rejects(
    app.records.discard({
      code     : invoice.code,
      revision : invoice.revision,
      reason   : 'No permitido',
    }),
    { descriptionCode: 'BILLING_REVISION_CONFLICT' },
  );
  const latest = await app.records.getOne('document', { code: invoice.code });
  await assert.rejects(
    app.records.discard({
      code     : latest.code,
      revision : latest.revision,
      reason   : 'No permitido',
    }),
    { descriptionCode: 'BILLING_DOCUMENT_NOT_DRAFT' },
  );
});
test('la sustitución de REP mantiene el cobro y exige cancelar todos sus comprobantes activos', /** @returns {Promise<void>} La relación 04 se prepara antes de solicitar la cancelación 01 del original. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    invoice = await issue(app, await draft(app, sender));
  const receipt          = await app.receipts.create(payment(invoice));
  const original         = await issue(
    app,
    await app.receipts.createRep({
      code     : receipt.code,
      revision : receipt.revision,
      date     : '2026-10-22T08:00:00',
    }),
  );
  let current            = await app.records.getOne('receipt', { code: receipt.code });
  const replacementDraft = await app.receipts.createRep({
    code                : current.code,
    revision            : current.revision,
    date                : '2026-10-22T09:00:00',
    replaceDocumentCode : original.code,
  });
  await app.records.discard({
    code     : replacementDraft.code,
    revision : replacementDraft.revision,
    reason   : 'Corregir fecha del sustituto antes de timbrar',
  });
  current = await app.records.getOne('receipt', { code: receipt.code });
  assert.equal(current.repDocumentCode, original.code);
  const replacement = await issue(
    app,
    await app.receipts.createRep({
      code                : current.code,
      revision            : current.revision,
      date                : '2026-10-22T10:00:00',
      replaceDocumentCode : original.code,
    }),
  );
  assert.equal(replacement.relationship, '04');
  assert.equal(replacement.relatedUuid, original.uuid);
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('cancel', {
    code            : original.code,
    revision        : original.revision,
    reason          : '01',
    replacementCode : replacement.code,
    idempotencyKey  : randomUUID(),
  });
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: original.code })).status, 'cancelled');
  assert.equal((await app.records.getOne('document', { code: invoice.code })).paid, '58.00');
  current = await app.records.getOne('receipt', { code: receipt.code });
  await assert.rejects(
    app.receipts.reverse({
      code     : current.code,
      revision : current.revision,
      reason   : 'Corrección',
    }),
    { descriptionCode: 'BILLING_CANCEL_REP_FIRST' },
  );
});
test('una nota de crédito reserva saldo, lo aplica una vez y lo restituye al cancelar', /** @returns {Promise<void>} Las reservas evitan que un cobro concurrente consuma el saldo de una nota en trámite. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    invoice = await issue(app, await draft(app, sender));
  const credit = await draft(app, sender, {
    type                : 'E',
    relatedDocumentCode : invoice.code,
    relationship        : '01',
    paymentMethod       : 'PUE',
    paymentForm         : '03',
  });
  await app.commands.enqueue('issue', {
    code           : credit.code,
    revision       : credit.revision,
    idempotencyKey : randomUUID(),
  });
  await assert.rejects(app.receipts.create(payment(invoice, '1')), {
    descriptionCode : 'BILLING_RECEIPT_EXCEEDS_BALANCE',
  });
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: invoice.code })).balance, '0.00');
  const issuedCredit = await app.records.getOne('document', { code: credit.code });
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('cancel', {
    code           : credit.code,
    revision       : issuedCredit.revision,
    reason         : '02',
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  const restored = await app.records.getOne('document', { code: invoice.code });
  assert.equal(restored.balance, '116.00');
  assert.equal(restored.credited, '0.00');
});
test('un REP aplica varias monedas con equivalencias y totales de impuestos en MXN', /** @returns {Promise<void>} Comprueba prorrateo por documento y conversión agregada del cobro. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  const usd     = await issue(
    app,
    await draft(app, sender, {
      currency     : 'USD',
      exchangeRate : '20',
    }),
  );
  const mxn     = await issue(app, await draft(app, sender));
  const receipt = await app.receipts.create({
    ...payment(usd),
    currency     : 'USD',
    exchangeRate : '20',
    amount       : '63.8',
    allocations  : [
      {
        documentCode : usd.code,
        amount       : '58',
        equivalence  : '1',
      },
      {
        documentCode : mxn.code,
        amount       : '116',
        equivalence  : '20',
      },
    ],
  });
  await issue(
    app,
    await app.receipts.createRep({
      code     : receipt.code,
      revision : receipt.revision,
      date     : '2026-10-22T09:00:00',
    }),
  );
  const payments = app.calls.at(-1).Comprobante.Complemento[0].Pagos20;
  assert.equal(payments.Pago[0].DoctoRelacionado.length, 2);
  assert.equal(payments.Totales.MontoTotalPagos, '1276.00');
  assert.equal(payments.Totales.TotalTrasladosBaseIVA16, '1100.00');
  assert.equal(payments.Totales.TotalTrasladosImpuestoIVA16, '176.00');
  assert.equal((await app.records.getOne('document', { code: usd.code })).balance, '58.00');
  assert.equal((await app.records.getOne('document', { code: mxn.code })).balance, '0.00');
});
test('la factura global usa receptor genérico y acredita periodo y operaciones originales', /** @returns {Promise<void>} Conserva las referencias comerciales y rechaza periodos incompatibles. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  const changes = {
    customerCode  : '',
    cfdiUse       : 'S01',
    paymentMethod : 'PUE',
    paymentForm   : '01',
    globalInfo    : {
      periodicity    : '04',
      month          : '10',
      year           : 2026,
      operationCodes : ['VENTA-1', 'VENTA-2'],
    },
  };
  await issue(app, await draft(app, sender, changes));
  assert.equal(app.calls[0].Comprobante.Receptor.Rfc, 'XAXX010101000');
  assert.equal(app.calls[0].Comprobante.Receptor.RegimenFiscalReceptor, '616');
  assert.equal(app.calls[0].Comprobante.InformacionGlobal.Meses, '10');
  await assert.rejects(
    draft(app, sender, {
      ...changes,
      globalInfo : {
        ...changes.globalInfo,
        periodicity : '05',
        month       : '10',
      },
    }),
    { descriptionCode: 'BILLING_INVALID_GLOBAL_PERIOD' },
  );
});

test('el rechazo 701 por créditos insuficientes libera el documento sin registrar un efecto fiscal' /** @returns {Promise<void>} Acredita el código observado en el sandbox real. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender);
  app.state.pacResponse = {
    code    : '701',
    message : 'Créditos insuficientes.',
    data    : '',
  };
  const operation = await app.commands.enqueue('issue', {
    code           : document.code,
    revision       : document.revision,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  assert.equal((await app.records.getOne('operation', { code: operation.code })).status, 'failed');
  assert.equal((await app.records.getOne('document', { code: document.code })).status, 'draft');
  assert.equal(app.calls.length, 1);
});
