/** @file Verifica la excepción externa PAC: opt-in por ambiente, límites, exclusión y detención. */
'use strict';
const test                              = require('node:test');
const assert                            = require('node:assert/strict');
const { randomUUID }                    = require('node:crypto');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
test('la consulta automática está desactivada por defecto y no cruza ambientes', /** @returns {Promise<void>} Configuración pública sin secretos y validación del intervalo. */ async () => {
  const app = fixture();
  await issuer(app);
  assert.deepEqual((await app.pacSettings.getOne()).externalRefresh, {
    enabled         : false,
    intervalSeconds : 60,
  });
  await app.pacSettings.update({
    revision        : 1,
    environment     : 'development',
    externalRefresh : {
      enabled         : true,
      intervalSeconds : 120,
    },
  });
  assert.equal((await app.pacSettings.refresh('development')).enabled, true);
  assert.equal((await app.pacSettings.refresh('production')).enabled, false);
  for (const intervalSeconds of [0, 59, 86401, 60.5])
    await assert.rejects(
      app.pacSettings.update({
        revision        : 2,
        environment     : 'development',
        externalRefresh : {
          enabled : true,
          intervalSeconds,
        },
      }),
      { descriptionCode: 'BILLING_EXTERNAL_REFRESH_INVALID' },
    );
  assert.equal((await app.pacSettings.getOne()).revision, 2);
});
test('una opción desactivada impide nuevas consultas y también detiene una consulta ya encolada', /** @returns {Promise<void>} El vencimiento sólo habilita la cuenta y recurso seleccionados. */ async () => {
  let now   = Date.parse('2026-10-22T12:00:00Z');
  const app = fixture({ /** @returns {number} Reloj explícito de la prueba. */ clock: () => now });
  const sender = await issuer(app),
    document   = await issue(app, await draft(app, sender));
  await app.commands.enqueue('cancel', {
    code           : document.code,
    revision       : document.revision,
    reason         : '02',
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  const initial = app.state.statusCalls;
  now += 60001;
  await app.effects.tick();
  assert.equal(app.state.statusCalls, initial);
  await app.pacSettings.update({
    revision        : 1,
    environment     : 'development',
    externalRefresh : {
      enabled         : true,
      intervalSeconds : 120,
    },
  });
  now += 119999;
  await app.effects.tick();
  assert.equal((await app.store.list('operation', { externalRefresh: true })).items.length, 0);
  now++;
  await Promise.all([app.effects.tick(), app.effects.tick()]);
  assert.equal((await app.store.list('operation', { externalRefresh: true })).items.length, 1);
  await app.pacSettings.update({
    revision        : 2,
    environment     : 'development',
    externalRefresh : {
      enabled         : false,
      intervalSeconds : 120,
    },
  });
  await app.effects.tick();
  assert.equal(app.state.statusCalls, initial);
  assert.equal(
    (await app.store.list('operation', { externalRefresh: true })).items[0].error,
    'BILLING_EXTERNAL_REFRESH_DISABLED',
  );
  app.state.sat = 'Cancelado';
  await app.commands.enqueue('reconcile', {
    code           : document.code,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  assert.equal(
    app.state.statusCalls,
    initial + 1,
    'Consultar ahora sigue disponible con la opción desactivada.',
  );
  assert.equal((await app.records.getOne('document', { code: document.code })).status, 'cancelled');
});
