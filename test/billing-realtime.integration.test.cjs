/** @file Consistencia de ventanas y avisos de operaciones con transacciones MongoDB reales. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { fixture } = require('./fixture.cjs');
test(
  'página y total comparten snapshot; reclamar operaciones confirma el aviso atómicamente',
  {
    skip    : !process.env.TEST_MONGOD_BINARY,
    timeout : 60000,
  },
  /** @returns {Promise<void>} Inserta durante el conteo y compite con dos reclamaciones reales. */ async () => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    try {
      const db   = mongo.connection.db;
      const base = {
        code           : 'O1',
        workspace      : 'W1',
        revision       : 1,
        userCreate     : 'U1',
        userAssigned   : 'U1',
        creationDate   : 1,
        updateDate     : 1,
        kind           : 'issue',
        targetCode     : 'D1',
        status         : 'queued',
        availableAt    : 1,
        leaseUntil     : 0,
        error          : '',
        providerCode   : '',
        idempotencyKey : 'K1',
      };
      await db.collection('BILLING_OPERATION').insertOne({ ...base });
      await db.createCollection('TEST_BILLING_EVENTS');
      let inserted  = false;
      const wrapped = {
        /** @param {string} name Colección. @returns {Object} Colección real con barrera en el conteo de la ventana. */
        collection(name) {
          const collection = db.collection(name);
          if (name !== 'BILLING_OPERATION') return collection;
          return new Proxy(collection, {
            /** @param {Object} target Colección real. @param {string} key Método solicitado. @returns {*} Conserva el SDK y sólo intercala una escritura externa durante countDocuments. */
            get(target, key) {
              if (key === 'countDocuments') {
                /** @param {Object} filter Filtros. @param {Object} options Sesión. @returns {Promise<number>} Cuenta bajo snapshot tras una escritura concurrente. */
                const count = async (filter, options) => {
                  if (!inserted) {
                    inserted = true;
                    await db.collection(name).insertOne({
                      ...base,
                      code           : 'O2',
                      idempotencyKey : 'K2',
                      creationDate   : 2,
                    });
                  }
                  return target.countDocuments(filter, options);
                };
                return count;
              }
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
      const store   = createBillingStore({
        db      : wrapped,
        client  : mongo.connection.getClient(),
        /** @param {string} name Evento. @param {Object} data Cambio. @param {Object} options Sesión del cambio. @returns {Promise<Object>} Outbox de prueba dentro del mismo commit. */
        publish : (name, data, options) =>
          db.collection('TEST_BILLING_EVENTS').insertOne(
            {
              name,
              data,
            },
            options,
          ),
      });
      const app     = fixture({ store });
      const page    = await app.records.getList('operation', {
        page    : 1,
        perPage : 20,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.pagination.total, 1);
      assert.equal(await db.collection('BILLING_OPERATION').countDocuments(), 2);
      await db.collection('BILLING_OPERATION').deleteOne({ code: 'O2' });
      const second  = createBillingStore({
        db,
        client  : mongo.connection.getClient(),
        /** @param {string} name Evento. @param {Object} data Cambio. @param {Object} options Sesión de la segunda instancia. @returns {Promise<Object>} Outbox atómico de la instancia competidora. */
        publish : (name, data, options) =>
          db.collection('TEST_BILLING_EVENTS').insertOne(
            {
              name,
              data,
            },
            options,
          ),
      });
      const results = await Promise.all([store.claim(10, 'first'), second.claim(10, 'second')]);
      assert.equal(results.filter(Boolean).length, 1);
      const operation = await db.collection('BILLING_OPERATION').findOne({ code: 'O1' });
      const events    = await db
        .collection('TEST_BILLING_EVENTS')
        .find({ name: 'billing.operation.changed' })
        .toArray();
      assert.equal(operation.status, 'running');
      assert.equal(events.length, 1);
      assert.equal(events[0].data.item.revision, operation.revision);
      assert.equal(events[0].data.item.code, operation.code);
    } finally {
      await mongo.stop();
    }
  },
);
