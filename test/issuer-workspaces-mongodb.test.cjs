/** @file Comprueba migración, unicidad, folios y carreras de reasignación contra MongoDB local transaccional. */
'use strict';
const test                              = require('node:test');
const assert                            = require('node:assert/strict');
const { randomUUID }                    = require('node:crypto');
const { MongoClient }                   = require('mongoose').mongo;
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
const { migrate }                       = require('../ops/migrate-issuer-workspaces.cjs');
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { editable } = require('../server/modules/billing/presenters/billing.presenter');
const uri          = process.env.BILLING_TEST_MONGO;
test(
  'Mongo migra máximos una vez y conserva la secuencia al compartir y restringir un emisor',
  { skip: !uri },
  /** @returns {Promise<void>} Crea únicamente una base efímera y nunca conecta a ambientes externos. */
  async () => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = await MongoClient.connect(uri),
      db         = client.db('issuer_scope_' + randomUUID().replaceAll('-', ''));
    try {
      const store = createBillingStore({
        db,
        client,
        /** @param {string} event Evento. @param {Object} data Datos. @param {Object} options Transacción. @returns {Promise<Object>} Outbox de aceptación. */
        publish : (event, data, options) =>
          db.collection('test_outbox').insertOne(
            {
              event,
              data,
            },
            options,
          ),
      });
      const app   = fixture({ store });
      let sender  = await issuer(app);
      await db.collection('BILLING_ISSUER').createIndex(
        {
          workspace : 1,
          code      : 1,
        },
        { unique: true },
      );
      await db.collection('BILLING_FOLIO').createIndex(
        {
          workspace   : 1,
          issuerCode  : 1,
          environment : 1,
          type        : 1,
          series      : 1,
        },
        { unique: true },
      );
      const counter          = {
        issuerCode  : sender.code,
        environment : 'development',
        type        : 'I',
        series      : 'F',
      };
      const insertedCounters = await db.collection('BILLING_FOLIO').insertMany([
        {
          ...counter,
          workspace : 'W1',
          value     : 8,
        },
        {
          ...counter,
          workspace : 'W2',
          value     : 12,
        },
      ]);
      assert.equal((await migrate(db, client)).ready, true);
      assert.equal(await db.collection('BILLING_FOLIO').countDocuments(), 2);
      await assert.rejects(migrate(db, client, { apply: true }), /BILLING_MUST_BE_STOPPED/);
      const interrupted = {
        /** @param {string} name Colección. @returns {Object} Interrumpe sólo la fase de índices, conservando Mongo real para los datos. */
        collection(name) {
          const collection = db.collection(name);
          if (name !== 'BILLING_ISSUER') return collection;
          return {
            /** @param {Object} filter Selector. @param {Object} options Sesión. @returns {Object} Cursor real. */
            find : (filter, options) => collection.find(filter, options),
            /** @returns {Promise<void>} Falla después de confirmar los datos. */
            async createIndex() {
              throw new Error('INDEX_INTERRUPTED');
            },
          };
        },
      };
      await assert.rejects(
        migrate(interrupted, client, {
          apply   : true,
          stopped : true,
        }),
        /INDEX_INTERRUPTED/,
      );
      assert.equal((await migrate(db, client)).completed, false);
      assert.equal((await migrate(db, client)).indexesPending, true);
      await migrate(db, client, {
        apply   : true,
        stopped : true,
      });
      assert.equal(await db.collection('BILLING_FOLIO').countDocuments(), 1);
      assert.equal(
        String((await db.collection('BILLING_FOLIO').findOne(counter))._id),
        String(insertedCounters.insertedIds[0]),
      );
      assert.equal((await issue(app, await draft(app, sender))).folio, '13');
      sender = await app.records.update('issuer', {
        ...editable('issuer', sender),
        code      : sender.code,
        revision  : sender.revision,
        workspace : 'allWorkspaces',
      });
      app.actor.workspace = 'W2';
      assert.equal((await issue(app, await draft(app, sender))).folio, '14');
      sender = await app.records.update('issuer', {
        ...editable('issuer', sender),
        code      : sender.code,
        revision  : sender.revision,
        workspace : 'W2',
      });
      await migrate(db, client, {
        apply   : true,
        stopped : true,
      });
      assert.equal((await issue(app, await draft(app, sender))).folio, '15');
      await assert.rejects(
        db.collection('BILLING_ISSUER').insertOne({
          ...sender,
          workspace : 'W1',
        }),
        { code: 11000 },
      );
      const original = await issuer({
        ...app,
        actor : Object.assign(app.actor, { workspace: 'W1' }),
      });
      app.actor.policies.push('billing.issuer.update.global');
      await assert.rejects(
        app.records.update('issuer', {
          ...editable('issuer', original),
          code      : original.code,
          revision  : original.revision,
          workspace : 'W2',
        }),
        /BILLING_DUPLICATE_OPERATION/,
      );
      assert.equal(
        (await db.collection('BILLING_ISSUER').findOne({ code: original.code })).workspace,
        'W1',
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
test(
  'Mongo rechaza una nueva factura cuando la reasignación gana la carrera antes de guardar su referencia',
  { skip: !uri },
  /** @returns {Promise<void>} Fuerza una lectura antigua y comprueba la revalidación tras el conflicto de escritura. */
  async () => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = await MongoClient.connect(uri),
      db         = client.db('issuer_race_' + randomUUID().replaceAll('-', ''));
    try {
      const store = createBillingStore({
        db,
        client,
        /** @returns {Promise<void>} La prueba no necesita consumir eventos. */
        publish : async () => {},
      });
      const app = fixture({ store }),
        sender  = await issuer(app);
      app.actor.policies.push('billing.issuer.update.global');
      let entered, release;
      const atGuard     = new Promise(
        /** @param {Function} resolve Señala que la lectura ocurrió. @returns {void} Conserva la barrera. */
        (resolve) => {
          entered = resolve;
        },
      );
      const gate        = new Promise(
        /** @param {Function} resolve Libera la escritura. @returns {void} Conserva la barrera. */
        (resolve) => {
          release = resolve;
        },
      );
      const transaction = store.transaction.bind(store);
      let waiting       = true;
      /** @param {Function} work Caso de uso. @returns {Promise<*>} Intercepta sólo la primera reserva documental. */
      store.transaction = (work) =>
        transaction(
          /** @param {Object} tx Unidad real. @returns {Promise<*>} Mantiene las garantías Mongo y añade una barrera reproducible. */
          (tx) =>
            work({
              ...tx,
              /** @param {Object} current Emisor leído. @returns {Promise<void>} Espera la reasignación antes del cerco. */
              async guardIssuer(current) {
                if (waiting) {
                  waiting = false;
                  entered();
                  await gate;
                }
                return tx.guardIssuer(current);
              },
            }),
        );
      const creating = draft(app, sender);
      const rejected = assert.rejects(creating, /BILLING_NOT_FOUND|BILLING_REVISION_CONFLICT/);
      await atGuard;
      try {
        await app.records.update('issuer', {
          ...editable('issuer', sender),
          code      : sender.code,
          revision  : sender.revision,
          workspace : 'W2',
        });
      } finally {
        release();
      }
      await rejected;
      assert.equal(await db.collection('BILLING_DOCUMENT').countDocuments(), 0);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
