/** @file Migración y configuración PAC contra Mongo efímero: atomicidad, concurrencia e idempotencia reales. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { MongoClient }             = require('mongoose').mongo;
const { billingSecrets }          = require('../server/adapters/crypto/billing-secrets');
const { migrate }                 = require('../ops/migrate-pac-global.cjs');
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { fixture } = require('./fixture.cjs');
const uri         = process.env.BILLING_TEST_MONGO;
test(
  'Mongo migra sin elegir cuentas y serializa la revisión global sin dejar claves huérfanas tras rollback',
  { skip: !uri },
  /** @returns {Promise<void>} Sólo crea y elimina bases efímeras en localhost. */ async () => {
    assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const client = await MongoClient.connect(uri),
      db         = client.db('billing_pac_' + randomUUID().replaceAll('-', ''));
    const secrets = billingSecrets(randomBytes(32).toString('base64'));
    try {
      for (const [code, environment] of [
        ['I1', 'development'],
        ['I2', 'production'],
      ])
        await db.collection('BILLING_ISSUER').insertOne({
          code,
          workspace      : 'W1',
          taxId          : code,
          revision       : 1,
          environment,
          template       : 'obsolete',
          configured     : true,
          secretEnvelope : secrets.seal(
            {
              apiKey : code[1].repeat(32),
              keyPEM : 'KEY',
              cerPEM : 'CERT',
            },
            `billing:W1:${code}:${environment}`,
          ),
        });
      await db.collection('BILLING_OPERATION').insertOne({
        code       : 'O1',
        workspace  : 'W1',
        issuerCode : 'I1',
        revision   : 1,
        kind       : 'issue',
        status     : 'queued',
      });
      const diagnosis = await migrate(db, client, {
        secrets,
        apply : true,
      });
      assert.equal(diagnosis.ready, false);
      assert.equal(await db.collection('BILLING_PAC').countDocuments(), 0);
      assert.equal(
        await db.collection('BILLING_ISSUER').countDocuments({ template: 'obsolete' }),
        2,
      );
      const result = await migrate(db, client, {
        secrets,
        apply             : true,
        activeEnvironment : 'production',
      });
      assert.equal(result.completed, true);
      assert.equal(
        await db.collection('BILLING_ISSUER').countDocuments({ template: { $exists: true } }),
        0,
      );
      assert.deepEqual(
        await migrate(db, client, {
          secrets,
          apply : true,
        }),
        {
          completed : true,
          changes   : 0,
        },
      );
      const original = await db.collection('BILLING_OPERATION').findOne({ code: 'O1' });
      assert.equal(
        (await db.collection('BILLING_PAC_REVISION').findOne({ code: original.pacRevision }))
          .environment,
        'development',
      );
      const store    = createBillingStore({
        db,
        client,
        /** @returns {Promise<void>} Esta prueba no modifica comprobantes ni publica fuera de la base efímera. */
        async publish() {},
      });
      const app      = fixture({ store });
      const outcomes = await Promise.allSettled([
        app.pacSettings.update({
          revision    : 1,
          environment : 'development',
        }),
        app.pacSettings.update({
          revision    : 1,
          environment : 'production',
        }),
      ]);
      assert.equal(
        outcomes.filter(
          /** @param {Object} result Resultado transaccional. @returns {boolean} Sólo un escritor confirma. */
          (result) => result.status === 'fulfilled',
        ).length,
        1,
      );
      assert.equal(await db.collection('BILLING_PAC_REVISION').countDocuments(), 3);
      const failingStore = {
        ...store,
        /** @param {Function} work Guardado PAC. @returns {Promise<Object>} Falla después de guardar la revisión y antes de confirmar la transacción. */
        transaction(work) {
          return store.transaction(
            /** @param {Object} tx Unidad real. @returns {Promise<Object>} Rollback provocado después del audit. */
            async (tx) => {
              await work(tx);
              throw new Error('ROLLBACK_PAC');
            },
          );
        },
      };
      const failing      = fixture({ store: failingStore });
      await assert.rejects(
        failing.pacSettings.update({
          revision    : 2,
          environment : 'production',
        }),
        /ROLLBACK_PAC/,
      );
      assert.equal(await db.collection('BILLING_PAC_REVISION').countDocuments(), 3);
      assert.equal((await app.pacSettings.getOne()).revision, 2);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
