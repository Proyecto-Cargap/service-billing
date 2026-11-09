/** @file Delegación fiscal: recibos atómicos, reintentos y revocación antes de efectos externos simulados. */
'use strict';
const test                              = require('node:test');
const assert                            = require('node:assert/strict');
const { randomUUID }                    = require('node:crypto');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
const { startIsolatedMongo }            = require('./helpers/isolated-mongo.cjs');
/** @param {Object} app Fixture. @param {string} name Acción canónica. @param {Object} data Entrada cerrada. @returns {Promise<Object>} Escritura acreditada. */
function createDocument(app, name, data) {
  return app.delegated.execute(
    name,
    data,
    /** @param {Object} input Cuerpo acreditado. @returns {Promise<Object>} Creación real del dominio. */ (
      input,
    ) => app.records.create('document', input),
  );
}
test('revocar mientras se prepara el PDF evita el envío sin marcar una entrega incierta', /** @returns {Promise<void>} Ningún correo real ni proveedor fiscal real. */ async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await issue(app, await draft(app, sender));
  app.actor.delegation = {
    grantCode : 'G1',
    clientId  : 'C1',
  };
  app.actor.operation = { idempotencyKey: randomUUID() };
  const queued = await app.delegated.execute(
    'billing-document-deliver',
    {
      code           : document.code,
      revision       : document.revision,
      idempotencyKey : app.actor.operation.idempotencyKey,
      email          : 'fixture@example.test',
    },
    /** @param {Object} input Intención. @returns {Promise<Object>} Encolado durable. */ (input) =>
      app.commands.enqueue('deliver', input),
  );
  assert.equal(
    (await app.store.get('operation', { code: queued.code })).delegation.grantCode,
    'G1',
  );
  const current = await app.store.get('document', {
    code      : document.code,
    workspace : 'W1',
  });
  await app.store.replace('document', current, {
    ...current,
    files         : {
      ...current.files,
      pdf : 'legacy-pdf',
    },
    pdfOrigin     : 'pac',
    pdfGeneration : undefined,
    revision      : current.revision + 1,
  });
  let releasePdf;
  app.state.pdfBarrier = new Promise(
    /** @param {Function} resolve Finalización controlada. @returns {void} Captura la continuación. */ (
      resolve,
    ) => {
      releasePdf = resolve;
    },
  );
  const baseline = app.state.pdfCalls.length;
  const pending  = app.effects.tick();
  for (let attempt = 0; app.state.pdfCalls.length === baseline && attempt < 100; attempt++)
    await new Promise(
      /** @param {Function} resolve Siguiente turno. @returns {void} Cede ejecución a la preparación. */ (
        resolve,
      ) => setImmediate(resolve),
    );
  assert.equal(app.state.pdfCalls.length, baseline + 1);
  app.state.revoked = true;
  releasePdf();
  await pending;
  assert.equal(app.state.delivered, undefined);
  assert.equal((await app.store.get('operation', { code: queued.code })).status, 'failed');
  await assert.rejects(
    app.delegated.execute(
      'billing-operation-resolve',
      {},
      /** @returns {void} Nunca puede ejecutarse desde MCP. */ () => {
        throw new Error('UNREACHABLE');
      },
    ),
    { descriptionCode: 'BILLING_HUMAN_REQUIRED' },
  );
});
test(
  'Mongo conserva documento, outbox y recibo en un único commit recuperable',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Prueba aislada. @returns {Promise<void>} Concurrencia, pérdida de respuesta y rollback. */ async (
    t,
  ) => {
    const database = await startIsolatedMongo({
      binary   : process.env.TEST_MONGOD_BINARY,
      mongoose : require('mongoose'),
    });
    t.after(database.stop);
    const db = database.connection.db;
    for (const [name, indexes] of Object.entries(
      require('../server/mongodb-indexes.json').collections,
    )) {
      await db.createCollection(name);
      for (const { key, ...options } of indexes)
        await db.collection(name).createIndex(key, options);
    }
    let failEvent = false;
    const store   =
      require('../server/modules/billing/repositories/billing-store.repository').createBillingStore(
        {
          db,
          client : database.connection.getClient(),
          /** @param {string} name Evento. @param {Object} data Proyección. @param {Object} options Sesión. @returns {Promise<void>} Outbox real con fallo inyectable. */ async publish(
            name,
            data,
            options,
          ) {
            await db.collection('TEST_OUTBOX').insertOne(
              {
                name,
                data,
              },
              options,
            );
            if (failEvent) throw new Error('OUTBOX_FAILED');
          },
        },
      );
    const app = fixture({ store }),
      sender  = await issuer(app);
    const sample  = await draft(app, sender);
    const request = {
      type          : sample.type,
      issuerCode    : sample.issuerCode,
      customerCode  : sample.customerCode,
      currency      : sample.currency,
      exchangeRate  : sample.exchangeRate,
      paymentMethod : sample.paymentMethod,
      paymentForm   : sample.paymentForm,
      cfdiUse       : sample.cfdiUse,
      date          : sample.date,
      lines         : sample.lines,
      notes         : '',
    };
    app.actor.delegation = {
      grantCode : 'G1',
      clientId  : 'C1',
    };
    app.actor.operation = { idempotencyKey: randomUUID() };
    const baseline = await db.collection('BILLING_DOCUMENT').countDocuments({});
    const results  = await Promise.all(
      Array.from(
        { length: 6 },
        /** @returns {Promise<Object>} Reintento simultáneo. */ () =>
          createDocument(app, 'billing-document-create', request),
      ),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(await db.collection('BILLING_DOCUMENT').countDocuments({}), baseline + 1);
    assert.equal(await db.collection('BILLING_OPERATION_RECEIPTS').countDocuments({}), 1);
    await assert.rejects(
      createDocument(app, 'billing-document-create', {
        ...request,
        notes : 'Diferente',
      }),
      { descriptionCode: 'IDEMPOTENCY_KEY_CONFLICT' },
    );
    const transaction = store.transaction.bind(store);
    const nesting     = new (require('node:async_hooks').AsyncLocalStorage)();
    let loseReply     = true;
    /** @param {Function} work Transacción. @returns {Promise<Object>} Simula respuesta perdida después del commit. */
    store.transaction = async (work) => {
      if (nesting.getStore()) return transaction(work);
      const result = await nesting.run(
        true,
        /** @returns {Promise<Object>} Commit exterior. */ () => transaction(work),
      );
      if (loseReply) {
        loseReply = false;
        throw new Error('RESPONSE_LOST');
      }
      return result;
    };
    app.actor.operation = { idempotencyKey: randomUUID() };
    const recovered = await createDocument(app, 'billing-document-create', request);
    assert.equal(recovered.status, 'draft');
    store.transaction = transaction;
    app.actor.operation = { idempotencyKey: randomUUID() };
    failEvent = true;
    await assert.rejects(createDocument(app, 'billing-document-create', request), /OUTBOX_FAILED/);
    assert.equal(await db.collection('BILLING_DOCUMENT').countDocuments({}), baseline + 2);
    assert.equal(await db.collection('BILLING_OPERATION_RECEIPTS').countDocuments({}), 2);
    app.state.revoked = true;
    await assert.rejects(createDocument(app, 'billing-document-create', request), {
      statusCode : 401,
    });
  },
);
