/** @file Concurrencia real de UUID, pagos y outbox sobre bases efímeras aisladas. */
'use strict';
const test            = require('node:test');
const assert          = require('node:assert/strict');
const { randomUUID }  = require('node:crypto');
const { MongoClient } = require('mongoose').mongo;
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { setup, confirmed, payment } = require('./expense-fixture.cjs');
const { storage, input }            = require('./expense-files-fixture.cjs');
const uri                           = process.env.BILLING_TEST_MONGO;
test(
  'Mongo: pagos concurrentes, rollback de saldos/outbox y UUID único entre workspaces',
  { skip: !uri },
  /** @returns {Promise<void>} Usa una base propia y la elimina después de verificar índices y transacciones. */ async () => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = await new MongoClient(uri).connect(),
      db         = client.db('expense_' + randomUUID().replaceAll('-', ''));
    let fail = false;
    try {
      for (const [name, indexes] of Object.entries(
        require('../server/mongodb-indexes.json').collections,
      ))
        for (const { key, ...options } of indexes)
          await db.collection(name).createIndex(key, options);
      const store = createBillingStore({
        db,
        client,
        /** @param {string} name Evento. @param {Object} data Invalidación. @param {Object} options Sesión transaccional. @returns {Promise<Object>} Outbox de aceptación. */
        publish : async (name, data, options) => {
          if (fail) throw new Error('outbox-unavailable');
          return db.collection('outbox').insertOne(
            {
              name,
              data,
            },
            options,
          );
        },
      });
      const files = storage(),
        app       = await setup({
          store,
          expenseFiles : files,
        }),
        first     = await confirmed(app),
        second    = await confirmed(app);
      const results = await Promise.allSettled([
        app.expensePayments.create(payment([first, second], ['100', '16'])),
        app.expensePayments.create(payment([first], ['100'])),
      ]);
      assert.equal(
        results.filter(
          /** @param {Object} r Resultado. @returns {boolean} Confirmado. */ (r) =>
            r.status === 'fulfilled',
        ).length,
        1,
      );
      const before = await app.records.getOne('expense', { code: second.code }),
        count      = await db.collection('outbox').countDocuments();
      fail = true;
      await assert.rejects(
        app.expensePayments.create(payment([second], ['1'])),
        /outbox-unavailable/,
      );
      fail = false;
      assert.deepEqual(await app.records.getOne('expense', { code: second.code }), before);
      assert.equal(await db.collection('outbox').countDocuments(), count);
      const query = await app.records.getList('expense', {
        page    : 1,
        perPage : 1,
      });
      assert.equal(query.items.length, 1);
      assert.equal(query.totals[0].total, '232.00');
      const other = await setup({
        store,
        expenseFiles : files,
        workspace    : 'W2',
      });
      const draftA = await app.expenses.create({
          ...app.input,
          idempotencyKey : randomUUID(),
        }),
        draftB     = await other.expenses.create({
          ...other.input,
          idempotencyKey : randomUUID(),
        });
      const fileA = await app.expenseAttachments.upload(input(draftA)),
        fileB     = await other.expenseAttachments.upload(input(draftB));
      const outcomes = await Promise.allSettled([
        app.expenseXml.apply({
          code           : draftA.code,
          revision       : 2,
          fileId         : fileA.fileId,
          idempotencyKey : randomUUID(),
        }),
        other.expenseXml.apply({
          code           : draftB.code,
          revision       : 2,
          fileId         : fileB.fileId,
          idempotencyKey : randomUUID(),
        }),
      ]);
      assert.equal(
        outcomes.filter(
          /** @param {Object} r Resultado. @returns {boolean} Confirmado. */ (r) =>
            r.status === 'fulfilled',
        ).length,
        1,
      );
      assert.equal(
        outcomes.find(
          /** @param {Object} r Resultado. @returns {boolean} Rechazado. */ (r) =>
            r.status === 'rejected',
        ).reason.descriptionCode,
        'BILLING_EXPENSE_XML_DUPLICATE',
      );
      assert.equal(await db.collection('BILLING_EXPENSE').countDocuments({ uuidActive: true }), 1);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
