/** @file Aceptación comercial y fiscal con casos de uso reales y proveedores aislados. */
'use strict';
const test                             = require('node:test');
const assert                           = require('node:assert/strict');
const { randomUUID }                   = require('node:crypto');
const { fixture, issuer, line, issue } = require('./fixture.cjs');
const dtos                             = require('../server/contracts/registry');
/** @param {Object} app Aplicación. @param {Object} sender Emisor. @param {Object} changes Variaciones. @returns {Promise<Object>} Venta comercial de 1160. */
async function sale(app, sender, changes = {}) {
  const input = {
    issuerCode       : sender.code,
    customerCode     : 'CUS1',
    currency         : 'MXN',
    exchangeRate     : '1',
    date             : '2026-10-22T06:00:00',
    lines            : [
      {
        ...line,
        unitPrice : '1000',
      },
    ],
    notes            : '',
    invoiceRequested : false,
    idempotencyKey   : randomUUID(),
    ...changes,
  };
  dtos['billing-sale-create'].input(input);
  const created = await app.sales.create(input);
  dtos['billing-sale-create'].output({
    statusCode      : 201,
    descriptionCode : 'OK',
    data            : created,
  });
  return app.sales.confirm({
    code           : created.code,
    revision       : created.revision,
    idempotencyKey : randomUUID(),
  });
}
/** @param {Object} value Venta. @param {string} total Pago. @returns {Object} Captura de cobro. */
function payment(value, total) {
  return {
    issuerCode     : value.issuerCode,
    customerCode   : value.customerCode,
    currency       : 'MXN',
    exchangeRate   : '1',
    amount         : total,
    date           : value.date,
    paymentForm    : '03',
    reference      : 'Banco',
    allocations    : [
      {
        saleCode    : value.code,
        amount      : total,
        equivalence : '1',
      },
    ],
    idempotencyKey : randomUUID(),
  };
}
/** @param {Object} value Venta. @returns {Object} Solicitud de factura individual. */
function invoiceInput(value) {
  return {
    code           : value.code,
    revision       : value.revision,
    date           : value.date,
    paymentMethod  : 'PPD',
    paymentForm    : '99',
    cfdiUse        : 'G03',
    idempotencyKey : randomUUID(),
  };
}
test('cliente sin datos fiscales registra venta y dos pagos sin PAC ni deuda duplicada al facturar', /** @returns {Promise<void>} Comprueba invariantes comerciales y fiscales sin PAC externo. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.customer.fiscal = {};
  const value = await sale(app, sender);
  const input = payment(value, '400');
  const first = await app.receipts.create(input);
  assert.equal((await app.receipts.create(input)).code, first.code);
  dtos['billing-receipt-create'].output({
    statusCode      : 201,
    descriptionCode : 'OK',
    data            : first,
  });
  await app.receipts.create(payment(value, '760'));
  const paid = await app.records.getOne('sale', { code: value.code });
  assert.equal(paid.balance, '0.00');
  assert.equal(paid.paid, '1160.00');
  assert.equal(app.calls.length, 0);
  await assert.rejects(app.sales.createInvoice(invoiceInput(paid)), {
    descriptionCode : 'BILLING_CUSTOMER_FISCAL_DATA_INCOMPLETE',
  });
  app.customer.fiscal = {
    taxId     : 'AAA010101AAA',
    legalName : 'CLIENTE',
    taxRegime : '601',
    address   : {
      country    : 'México',
      postalCode : '01000',
    },
  };
  await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'test',
  });
  const draft    = await app.sales.createInvoice(invoiceInput(paid));
  const document = await issue(app, draft);
  assert.equal(document.balance, '0.00');
  assert.equal(document.paid, '1160.00');
  assert.equal((await app.records.getList('receipt', {})).pagination.total, 2);
  const current = await app.records.getOne('receipt', { code: first.code });
  const rep     = await app.receipts.createRep({
    code     : current.code,
    revision : current.revision,
    date     : value.date,
  });
  assert.equal((await issue(app, rep)).status, 'issued');
});
test('confirmación con pago es atómica y un sobrepago concurrente no modifica el saldo', /** @returns {Promise<void>} Comprueba invariantes comerciales y fiscales sin PAC externo. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    value   = await sale(app, sender);
  const results = await Promise.allSettled([
    app.receipts.create(payment(value, '760')),
    app.receipts.create(payment(value, '760')),
  ]);
  assert.equal(
    results.filter(
      /** @param {Object} result Resultado concurrente. @returns {boolean} Cobro confirmado. */ (
        result,
      ) => result.status === 'fulfilled',
    ).length,
    1,
  );
  assert.equal((await app.records.getOne('sale', { code: value.code })).balance, '400.00');
  await assert.rejects(
    app.sales.cancel({
      code           : value.code,
      revision       : 3,
      reason         : 'Cancelar',
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_REVERSE_DEPENDENCIES_FIRST' },
  );
});
test('global deriva ventas pagadas, reserva en exclusiva y su cancelación conserva el efectivo', /** @returns {Promise<void>} Comprueba invariantes comerciales y fiscales sin PAC externo. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'test',
  });
  const value = await sale(app, sender);
  const input = {
    saleCodes      : [value.code],
    date           : value.date,
    paymentForm    : '03',
    globalInfo     : {
      periodicity : '04',
      month       : '10',
      year        : 2026,
    },
    idempotencyKey : randomUUID(),
  };
  await assert.rejects(app.sales.createGlobal(input), {
    descriptionCode : 'BILLING_GLOBAL_SALE_INELIGIBLE',
  });
  await app.receipts.create(payment(value, '1160'));
  const draft   = await app.sales.createGlobal(input);
  const current = await app.records.getOne('sale', { code: value.code });
  await assert.rejects(app.sales.createInvoice(invoiceInput(current)), {
    descriptionCode : 'BILLING_SALE_RESERVED',
  });
  const document = await issue(app, draft);
  assert.equal(document.balance, '0.00');
  await app.commands.enqueue('cancel', {
    code           : document.code,
    revision       : document.revision,
    reason         : '04',
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('reconcile', {
    code           : document.code,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  const released = await app.records.getOne('sale', { code: value.code });
  assert.equal(released.paid, '1160.00');
  assert.equal(released.fiscalStatus, 'unbilled');
});
test('timbrado de pruebas no acredita cobertura fiscal de producción', /** @returns {Promise<void>} Comprueba invariantes comerciales y fiscales sin PAC externo. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    value   = await sale(app, sender);
  const document = await issue(app, await app.sales.createInvoice(invoiceInput(value)));
  assert.equal(document.status, 'issued');
  assert.equal((await app.records.getOne('sale', { code: value.code })).fiscalStatus, 'unbilled');
});
/** @param {Object} app Aplicación. @param {Object} process Proceso actual. @returns {Promise<Object>} Un único avance explícito con reintento acreditado. */
async function advance(app, process) {
  const input  = {
    code           : process.code,
    revision       : process.revision,
    idempotencyKey : randomUUID(),
  };
  const result = await app.extraction.advance(input);
  assert.deepEqual(await app.extraction.advance(input), result);
  return result;
}
test('extracción recuperable conserva dos ventas y sus cobros al sustituir la global', /** @returns {Promise<void>} Recorre cancelación, reexpedición e individual con reintentos entre cada paso. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'test',
  });
  const first = await sale(app, sender),
    second    = await sale(app, sender);
  for (const value of [first, second]) await app.receipts.create(payment(value, '1160'));
  const global = await issue(
    app,
    await app.sales.createGlobal({
      saleCodes      : [first.code, second.code],
      date           : first.date,
      paymentForm    : '03',
      globalInfo     : {
        periodicity : '04',
        month       : '10',
        year        : 2026,
      },
      idempotencyKey : randomUUID(),
    }),
  );
  let current  = await app.records.getOne('sale', { code: first.code });
  let process  = await app.extraction.create(invoiceInput(current));
  assert.equal(app.calls.length, 1);
  process = await advance(app, process);
  assert.equal(process.stage, 'wait-cancellation');
  await app.effects.tick();
  assert.equal((await advance(app, process)).stage, 'wait-cancellation');
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('reconcile', {
    code           : global.code,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  process = await advance(app, process);
  assert.equal(process.stage, 'prepare-global');
  process = await advance(app, process);
  assert.equal(process.stage, 'issue-global');
  const replacement = await app.records.getOne('document', { code: process.replacementCode });
  assert.deepEqual(replacement.saleCodes, [second.code]);
  assert.equal(replacement.total, '1160.00');
  process = await advance(app, process);
  await app.effects.tick();
  process = await advance(app, process);
  assert.equal(process.stage, 'prepare-individual');
  process = await advance(app, process);
  assert.equal(process.stage, 'issue-individual');
  process = await advance(app, process);
  await app.effects.tick();
  process = await advance(app, process);
  assert.equal(process.stage, 'complete');
  for (const value of [first, second]) {
    current = await app.records.getOne('sale', { code: value.code });
    assert.equal(current.paid, '1160.00');
    assert.equal(current.balance, '0.00');
    assert.equal(current.extractionCode, '');
  }
  assert.equal((await app.records.getList('receipt', {})).pagination.total, 2);
  assert.equal(
    (await app.records.getOne('document', { code: process.individualCode })).balance,
    '0.00',
  );
});
test('reservar una global bloquea reversión y descartar libera la venta sin tocar cobros', /** @returns {Promise<void>} Impide un cambio del saldo después de elegir ventas para global. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    value   = await sale(app, sender);
  const receipt = await app.receipts.create(payment(value, '1160'));
  const draft   = await app.sales.createGlobal({
    saleCodes      : [value.code],
    date           : value.date,
    paymentForm    : '03',
    globalInfo     : {
      periodicity : '04',
      month       : '10',
      year        : 2026,
    },
    idempotencyKey : randomUUID(),
  });
  await assert.rejects(
    app.receipts.reverse({
      code     : receipt.code,
      revision : receipt.revision,
      reason   : 'Corrección',
    }),
    { descriptionCode: 'BILLING_CANCEL_GLOBAL_FIRST' },
  );
  await app.records.discard({
    code     : draft.code,
    revision : draft.revision,
    reason   : 'Corregir selección',
  });
  await app.receipts.reverse({
    code     : receipt.code,
    revision : receipt.revision,
    reason   : 'Corrección',
  });
  assert.equal((await app.records.getOne('sale', { code: value.code })).balance, '1160.00');
});
test('confirmar y cobrar revierte integralmente si falla el pago y acepta el mismo intento una sola vez', /** @returns {Promise<void>} Prueba atomicidad del atajo comercial, no sólo de cobros separados. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.customer.fiscal = {};
  app.customer.personProfile = {
    name : {
      firstName        : 'Ana',
      lastNamePaternal : 'López',
      lastNameMaternal : 'Ruiz',
    },
  };
  const draft = await app.sales.create({
    issuerCode       : sender.code,
    customerCode     : 'CUS1',
    currency         : 'MXN',
    exchangeRate     : '1',
    date             : '2026-10-22T06:00:00',
    lines            : [
      {
        ...line,
        unitPrice : '1000',
      },
    ],
    notes            : '',
    invoiceRequested : false,
    idempotencyKey   : randomUUID(),
  });
  assert.equal(draft.customerSnapshot.name, 'Ana López Ruiz');
  const input = {
    code           : draft.code,
    revision       : draft.revision,
    idempotencyKey : randomUUID(),
    payment        : {
      amount      : '1161',
      date        : draft.date,
      paymentForm : '03',
      reference   : 'Primero',
    },
  };
  await assert.rejects(app.sales.confirm(input), {
    descriptionCode : 'BILLING_RECEIPT_EXCEEDS_BALANCE',
  });
  assert.equal((await app.records.getOne('sale', { code: draft.code })).status, 'draft');
  assert.equal((await app.records.getList('receipt', {})).pagination.total, 0);
  input.payment.amount = '400';
  const result = await app.sales.confirm(input);
  assert.deepEqual(await app.sales.confirm(input), result);
  assert.equal(result.balance, '760.00');
  assert.equal(app.calls.length, 0);
});
test('nota comercial recupera fallo documental sin alterar dinero y revoca acceso al cambiar workspace', /** @returns {Promise<void>} Verifica reserva, reintento y aislamiento sin emitir CFDI. */ async () => {
  let attempts  = 0;
  const fileIds = [];
  const app     = fixture({
    files : {
      /** @param {Object} value Registro. @param {Object} origin Venta. @param {string} kind Clase. @param {string} id Archivo reservado. @returns {Promise<string>} Falla antes de confirmar la primera generación. */ async generateCommercial(
        value,
        origin,
        kind,
        id,
      ) {
        fileIds.push(id);
        if (++attempts === 1) throw new Error('DOCUMENTS_OFFLINE');
        return id;
      },
    },
  });
  const sender = await issuer(app),
    value      = await sale(app, sender);
  await assert.rejects(app.commercialPdf.file('sale', { code: value.code }), /DOCUMENTS_OFFLINE/);
  await app.commercialPdf.file('sale', { code: value.code });
  assert.equal(fileIds[0], fileIds[1]);
  await app.commercialPdf.file('sale', { code: value.code });
  assert.equal(attempts, 2);
  assert.equal((await app.records.getOne('sale', { code: value.code })).balance, '1160.00');
  app.actor.workspace = 'W2';
  await assert.rejects(app.commercialPdf.file('sale', { code: value.code }), {
    descriptionCode : 'BILLING_NOT_FOUND',
  });
});
test(
  'Mongo serializa ventas, confirmación con pago, reservas fiscales y outbox',
  { skip: !process.env.BILLING_TEST_MONGO },
  /** @returns {Promise<void>} Replica set local y base efímera con índices reales. */ async () => {
    const { MongoClient } = require('mongoose').mongo;
    const {
      createBillingStore,
    } = require('../server/modules/billing/repositories/billing-store.repository');
    const uri = process.env.BILLING_TEST_MONGO;
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('billing_sales_' + randomUUID().replaceAll('-', ''));
    try {
      for (const [name, indexes] of Object.entries(
        require('../server/mongodb-indexes.json').collections,
      ))
        for (const { key, ...options } of indexes)
          await db.collection(name).createIndex(key, options);
      const store = createBillingStore({
        db,
        client,
        /** @param {string} name Evento. @param {Object} data Aviso. @param {Object} options Sesión Mongo. @returns {Promise<Object>} Outbox en la misma transacción. */ publish :
          (name, data, options) =>
            db.collection('acceptance_outbox').insertOne(
              {
                name,
                data,
              },
              options,
            ),
      });
      const app = fixture({ store }),
        sender  = await issuer(app),
        value   = await sale(app, sender);
      const input   = payment(value, '760');
      const results = await Promise.allSettled([
        app.receipts.create(input),
        app.receipts.create(input),
        app.receipts.create(payment(value, '760')),
      ]);
      assert.ok(
        results.some(
          /** @param {Object} result Intento. @returns {boolean} Un cobro confirmado. */ (result) =>
            result.status === 'fulfilled',
        ),
      );
      assert.equal((await app.records.getOne('sale', { code: value.code })).paid, '760.00');
      assert.equal((await app.records.getList('receipt', {})).pagination.total, 1);
      await app.receipts.create(payment(value, '400'));
      const global   = {
        saleCodes      : [value.code],
        date           : value.date,
        paymentForm    : '03',
        globalInfo     : {
          periodicity : '04',
          month       : '10',
          year        : 2026,
        },
        idempotencyKey : randomUUID(),
      };
      const reserved = await Promise.allSettled([
        app.sales.createGlobal(global),
        app.sales.createInvoice(
          invoiceInput(await app.records.getOne('sale', { code: value.code })),
        ),
      ]);
      assert.equal(
        reserved.filter(
          /** @param {Object} result Intento. @returns {boolean} Reserva exclusiva ganadora. */ (
            result,
          ) => result.status === 'fulfilled',
        ).length,
        1,
      );
      assert.ok(
        await db.collection('acceptance_outbox').countDocuments({ name: 'billing.sale.changed' }),
      );
      assert.equal(
        await db
          .collection('acceptance_outbox')
          .countDocuments({ name: 'billing.receipt.changed' }),
        2,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
test('venta y pago funcionan sin configurar PAC ni cargar CSD', /** @returns {Promise<void>} El emisor sólo requiere su identidad comercial existente. */ async () => {
  const app    = fixture();
  const sender = await app.records.create('issuer', {
    workspace  : 'W1',
    name       : 'Emisor',
    taxId      : 'BBB010101BBB',
    legalName  : 'EMISOR',
    taxRegime  : '601',
    postalCode : '01000',
    series     : {
      I : 'F',
      E : 'NC',
      P : 'P',
    },
    active     : true,
  });
  app.customer.fiscal = {};
  const value = await sale(app, sender);
  await app.receipts.create(payment(value, '1160'));
  assert.equal((await app.records.getOne('sale', { code: value.code })).balance, '0.00');
  assert.equal(app.calls.length, 0);
  assert.equal(
    await app.store.get('pac', {
      workspace : 'allWorkspaces',
      code      : 'global',
    }),
    null,
  );
});
test('extracción de la única venta valida receptor antes de cancelar y recupera rechazo de emisión', /** @returns {Promise<void>} Conserva dinero y reserva ante reintentos, omitiendo una global vacía. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'test',
  });
  const value = await sale(app, sender);
  await app.receipts.create(payment(value, '1160'));
  const original = await issue(
    app,
    await app.sales.createGlobal({
      saleCodes      : [value.code],
      date           : value.date,
      paymentForm    : '03',
      globalInfo     : {
        periodicity : '04',
        month       : '10',
        year        : 2026,
      },
      idempotencyKey : randomUUID(),
    }),
  );
  const current  = await app.records.getOne('sale', { code: value.code });
  const fiscal   = app.customer.fiscal;
  app.customer.fiscal = {};
  await assert.rejects(app.extraction.create(invoiceInput(current)), {
    descriptionCode : 'BILLING_CUSTOMER_FISCAL_DATA_INCOMPLETE',
  });
  assert.equal((await app.records.getOne('sale', { code: value.code })).extractionCode || '', '');
  assert.equal((await app.records.getList('sale-extraction', {})).pagination.total, 0);
  app.customer.fiscal = fiscal;
  let process = await app.extraction.create({
    ...invoiceInput(current),
    paymentMethod : 'PUE',
    paymentForm   : '03',
  });
  process = await advance(app, process);
  app.state.sat = 'Cancelado';
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: original.code })).status, 'cancelled');
  process = await advance(app, process);
  process = await advance(app, process);
  assert.equal(process.stage, 'prepare-individual');
  assert.equal(process.replacementCode, '');
  process = await app.extraction.advance({
    code           : process.code,
    revision       : process.revision,
    date           : '2026-10-23T09:00:00',
    idempotencyKey : randomUUID(),
  });
  assert.equal(
    (await app.records.getOne('document', { code: process.individualCode })).date,
    '2026-10-23T09:00:00',
  );
  app.state.pacResponse = {
    code    : '701',
    message : 'Créditos insuficientes.',
    data    : '',
  };
  process = await advance(app, process);
  await app.effects.tick();
  process = await advance(app, process);
  assert.equal(process.stage, 'prepare-individual');
  app.state.pacResponse = null;
  process = await advance(app, process);
  process = await advance(app, process);
  await app.effects.tick();
  process = await advance(app, process);
  assert.equal(process.stage, 'complete');
  assert.equal((await app.records.getList('receipt', {})).pagination.total, 1);
  assert.equal((await app.records.getOne('sale', { code: value.code })).balance, '0.00');
});
test('crédito fiscal y cancelación actualizan una sola vez el saldo de la venta', /** @returns {Promise<void>} Reservas y créditos de un ingreso derivado no duplican cuentas por cobrar. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'test',
  });
  const value = await sale(app, sender);
  await app.receipts.create(payment(value, '400'));
  const invoice = await issue(
    app,
    await app.sales.createInvoice(
      invoiceInput(await app.records.getOne('sale', { code: value.code })),
    ),
  );
  const credit  = await app.records.create('document', {
    type                : 'E',
    issuerCode          : sender.code,
    customerCode        : 'CUS1',
    currency            : 'MXN',
    exchangeRate        : '1',
    paymentMethod       : 'PUE',
    paymentForm         : '03',
    cfdiUse             : 'G02',
    date                : value.date,
    lines               : [line],
    notes               : 'Crédito',
    relatedDocumentCode : invoice.code,
    relationship        : '01',
  });
  const issued  = await issue(app, credit);
  assert.equal(issued.status, 'issued');
  let current = await app.records.getOne('sale', { code: value.code });
  assert.equal(current.balance, '644.00');
  assert.equal(current.credited, '116.00');
  assert.equal(current.paid, '400.00');
  await app.commands.enqueue('cancel', {
    code           : issued.code,
    revision       : issued.revision,
    reason         : '02',
    idempotencyKey : randomUUID(),
  });
  app.state.sat = 'Cancelado';
  await app.effects.tick();
  current = await app.records.getOne('sale', { code: value.code });
  assert.equal(current.balance, '760.00');
  assert.equal(current.credited, '0.00');
  assert.equal((await app.records.getList('receipt', {})).pagination.total, 1);
});
test('permisos revocados bloquean reintentos comerciales y scopes delegados impiden timbrado implícito', /** @returns {Promise<void>} El consentimiento de ventas no concede efectos fiscales. */ async () => {
  const app = fixture(),
    sender  = await issuer(app),
    value   = await sale(app, sender);
  const input = payment(value, '400');
  await app.receipts.create(input);
  const original = app.actor.policies;
  app.actor.policies = original.filter(
    /** @param {string} policy Permiso. @returns {boolean} Revoca creación de cobros. */ (policy) =>
      policy !== 'billing.receipt.create.workspace',
  );
  await assert.rejects(app.receipts.create(input), { statusCode: 403 });
  app.actor.policies = original;
  const draft = await app.sales.createInvoice(
    invoiceInput(await app.records.getOne('sale', { code: value.code })),
  );
  app.actor.delegation = { grantCode: 'synthetic' };
  app.actor.scopes = ['billing:read', 'billing:write'];
  await assert.rejects(
    app.commands.enqueue('issue', {
      code           : draft.code,
      revision       : draft.revision,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'MCP_SCOPE_REQUIRED' },
  );
  assert.equal(app.calls.length, 0);
});

test('global diaria no mezcla fechas aunque pertenezcan al mismo mes', /** @returns {Promise<void>} La periodicidad delimita también las ventas originales. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  const first = await sale(app, sender),
    second    = await sale(app, sender, { date: '2026-10-23T06:00:00' });
  for (const value of [first, second]) await app.receipts.create(payment(value, '1160'));
  await assert.rejects(
    app.sales.createGlobal({
      saleCodes      : [first.code, second.code],
      date           : second.date,
      paymentForm    : '03',
      globalInfo     : {
        periodicity : '01',
        month       : '10',
        year        : 2026,
      },
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_GLOBAL_PERIOD_MISMATCH' },
  );
  assert.deepEqual((await app.records.getOne('sale', { code: first.code })).fiscalDocuments, {});
});
