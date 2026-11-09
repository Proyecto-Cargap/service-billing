/** @file Comprueba agendas PAC y limpieza con MongoDB real, sin recorrer periódicamente pendientes. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const { refreshDeadline } = require('../server/modules/billing/policies/external-refresh.policy');
test(
  'agenda externa respeta configuración vigente y limpieza conserva exclusión y revisión',
  {
    skip    : !process.env.TEST_MONGOD_BINARY,
    timeout : 60000,
  },
  /** @returns {Promise<void>} Usa exclusivamente una base temporal. */ async () => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    try {
      const db       = mongo.connection.db;
      const store    = createBillingStore({
        db,
        client : mongo.connection.getClient(),
        /** @returns {Promise<void>} Este caso sólo modifica trabajos privados. */ async publish() {},
      });
      const document = {
        code            : 'D1',
        workspace       : 'W1',
        status          : 'cancel-requested',
        activeOperation : '',
        issuerSnapshot  : { environment: 'development' },
        creationDate    : 1000,
        sat             : { checkedAt: 2000 },
      };
      await db.collection('BILLING_DOCUMENT').insertOne({
        ...document,
        nextStatusAt : 1,
      });
      const preferences = {
        development : {
          enabled         : false,
          intervalSeconds : 60,
          changedAt       : 3000,
        },
        production  : {
          enabled         : false,
          intervalSeconds : 60,
        },
      };
      assert.equal(await store.nextExternalRefresh(preferences), null);
      preferences.development.enabled = true;
      assert.equal(
        (await store.nextExternalRefresh(preferences)).deadline,
        refreshDeadline(document, preferences.development),
      );
      assert.equal((await store.nextExternalRefresh(preferences)).deadline, 63000);
      preferences.development.intervalSeconds = 120;
      assert.equal((await store.nextExternalRefresh(preferences)).deadline, 123000);
      await db
        .collection('BILLING_DOCUMENT')
        .updateOne({ code: 'D1' }, { $set: { externalRefreshRetryAt: 180000 } });
      assert.equal((await store.nextExternalRefresh(preferences)).deadline, 180000);
      await db
        .collection('BILLING_DOCUMENT')
        .updateOne({ code: 'D1' }, { $set: { activeOperation: 'O1' } });
      assert.equal(await store.nextExternalRefresh(preferences), null);
      await db.collection('BILLING_DOCUMENT').updateOne(
        { code: 'D1' },
        {
          $set : {
            activeOperation : '',
            status          : 'cancelled',
          },
        },
      );
      assert.equal(await store.nextExternalRefresh(preferences), null);
      assert.equal(await store.nextOperationAt(), undefined);
      await db.collection('BILLING_OPERATION').insertMany([
        {
          code       : 'O1',
          status     : 'running',
          leaseUntil : 5000,
        },
        {
          code        : 'O2',
          status      : 'queued',
          availableAt : 6000,
        },
        {
          code        : 'O3',
          status      : 'uncertain',
          availableAt : 1,
        },
      ]);
      assert.equal(await store.nextOperationAt(), 5000);
      await db.collection('BILLING_EXPENSE_FILE_JOB').insertOne({
        code       : 'J1',
        workspace  : 'W1',
        revision   : 1,
        status     : 'pending',
        updateDate : 1000,
        leaseUntil : 0,
      });
      const due = 86401000;
      assert.equal(await store.nextExpenseCleanupAt(), due);
      assert.equal(await store.claimExpenseCleanup(due - 1, 'early'), null);
      const claims = await Promise.all([
        store.claimExpenseCleanup(due, 'one'),
        store.claimExpenseCleanup(due, 'two'),
      ]);
      const owned  = claims.filter(Boolean);
      assert.equal(owned.length, 1);
      assert.equal(await store.nextExpenseCleanupAt(), due + 360000);
      const recovered = await store.claimExpenseCleanup(due + 360000, 'restart');
      assert.equal(recovered.revision, owned[0].revision + 1);
      await assert.rejects(
        store.replace('expense-file-job', owned[0], {
          ...owned[0],
          status : 'cleaned',
        }),
        { statusCode: 409 },
      );
      await store.replace('expense-file-job', recovered, {
        ...recovered,
        revision : recovered.revision + 1,
        status   : 'cleaned',
      });
      assert.equal(await store.nextExpenseCleanupAt(), undefined);
    } finally {
      await mongo.stop();
    }
  },
);
