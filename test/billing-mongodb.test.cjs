/** @file Aceptación con MongoDB local: índices reales, concurrencia contable, ámbitos y recuperación tras interrupción. */
'use strict';
const test            = require('node:test');
const assert          = require('node:assert/strict');
const { randomUUID }  = require('node:crypto');
const { MongoClient } = require('mongoose').mongo;
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { verifyIndexes }                 = require('../server/library/messaging/indexes');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
const uri                               = process.env.BILLING_TEST_MONGO;
test(
  'Mongo serializa saldos y recupera una intención vencida sin volver a enviarla',
  { skip: !uri },
  /** @returns {Promise<void>} Usa exclusivamente una base efímera en el replica set local indicado. */
  async () => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('billing_acceptance_' + randomUUID().replaceAll('-', ''));
    try {
      for (const [name, indexes] of Object.entries(
        require('../server/mongodb-indexes.json').collections,
      ))
        for (const definition of indexes) {
          const { key, ...options } = definition;
          await db.collection(name).createIndex(key, options);
        }
      await verifyIndexes(db, require('../server/mongodb-indexes.json').collections);
      const store = createBillingStore({
          db,
          client,
          /** @param {string} name Evento. @param {Object} data Aviso. @param {Object} options Sesión de la escritura. @returns {Promise<Object>} Outbox de aceptación con la misma sesión Mongo real. */
          publish : (name, data, options) =>
            db.collection('acceptance_outbox').insertOne(
              {
                name,
                data,
              },
              options,
            ),
        }),
        app       = fixture({ store }),
        sender    = await issuer(app),
        invoice   = await issue(app, await draft(app, sender));
      const notices = await db
        .collection('acceptance_outbox')
        .find({ 'data.item.code': invoice.code })
        .toArray();
      assert.ok(notices.length >= 3);
      assert.equal(notices.at(-1).data.item.revision, invoice.revision);
      const countBeforeRollback = await db.collection('acceptance_outbox').countDocuments();
      await assert.rejects(
        store.transaction(
          /** @param {Object} tx Unidad real Mongo. @returns {Promise<void>} Revierte el alta y el aviso juntos. */
          async (tx) => {
            await tx.insert('document', {
              ...invoice,
              code : 'rollback-document',
              uuid : randomUUID(),
            });
            throw new Error('rollback-event');
          },
        ),
        /rollback-event/,
      );
      assert.equal(await db.collection('acceptance_outbox').countDocuments(), countBeforeRollback);
      assert.equal(await store.get('document', { code: 'rollback-document' }), null);
      assert.equal(invoice.status, 'issued');
      assert.equal(invoice.folio, '1');
      const receipt = {
        issuerCode   : sender.code,
        customerCode : 'CUS1',
        currency     : 'MXN',
        exchangeRate : '1',
        amount       : '80',
        date         : '2026-10-22T07:00:00',
        paymentForm  : '03',
        reference    : 'Banco',
        allocations  : [
          {
            documentCode : invoice.code,
            amount       : '80',
            equivalence  : '1',
          },
        ],
      };
      const results = await Promise.allSettled([
        app.receipts.create({
          ...receipt,
          idempotencyKey : 'mongo-a',
        }),
        app.receipts.create({
          ...receipt,
          idempotencyKey : 'mongo-b',
        }),
      ]);
      assert.equal(
        results.filter(
          /** @param {Object} result Cobro concurrente. @returns {boolean} Sólo uno puede consumir el saldo. */
          (result) => result.status === 'fulfilled',
        ).length,
        1,
      );
      assert.equal((await app.records.getOne('document', { code: invoice.code })).balance, '36.00');
      const second = await draft(app, sender),
        operation  = await app.commands.enqueue('issue', {
          code           : second.code,
          revision       : second.revision,
          idempotencyKey : 'interrupted',
        });
      assert.equal((await store.claim(Date.now(), 'worker-interrupted')).code, operation.code);
      await store.claim(Date.now() + 1900000, 'next-worker');
      assert.equal(
        (await app.records.getOne('document', { code: second.code })).status,
        'uncertain',
      );
      assert.equal(app.calls.length, 1);
      const unresolved = await app.records.getOne('operation', { code: operation.code });
      await app.resolution.resolve({
        code     : operation.code,
        revision : unresolved.revision,
        outcome  : 'not-issued',
        evidence : 'PAC TEST confirma ausencia de emisión; soporte 0001',
      });
      await issue(app, await app.records.getOne('document', { code: second.code }));
      assert.equal(app.calls.length, 2);
      app.actor.policies = ['billing.document.view.owner', 'billing.document.view.assigned'];
      const other = {
        ...(await store.get('document', {
          code      : invoice.code,
          workspace : 'W1',
        })),
        code         : 'other-owner',
        uuid         : randomUUID(),
        userCreate   : 'OTHER',
        userAssigned : 'OTHER',
      };
      await store.insert('document', other);
      const own = await app.records.getList('document', { search: 'F' });
      assert.ok(
        !own.items.some(
          /** @param {Object} item Registro. @returns {boolean} La búsqueda conserva el alcance de propiedad. */
          (item) => item.code === 'other-owner',
        ),
      );
      app.actor.workspace = 'W2';
      await assert.rejects(
        /** @returns {Promise<Object>} Otro workspace no puede leer el documento. */
        () => app.records.getOne('document', { code: invoice.code }),
        /BILLING_NOT_FOUND/,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
