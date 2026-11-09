/** @file Verifica cuenta global, aislamiento, revisiones aceptadas y PDF propios sin efectos fiscales repetidos. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { randomUUID }                    = require('node:crypto');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
/** @param {Object} app Aplicación. @param {Object} document Comprobante. @returns {Promise<Object>} Lectura privada para verificar metadatos que no se exponen. */
function privateDocument(app, document) {
  return app.store.get('document', {
    code      : document.code,
    workspace : 'W1',
  });
}
test('PAC global permite cambiar ambiente con actividad y operaciones pendientes, fijando cada revisión aceptada', /** @returns {Promise<void>} Acredita cambios de ambiente, rotación, históricos y ausencia de secretos públicos. */ async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender);
  const original = await app.pacSettings.resolve();
  await app.commands.enqueue('issue', {
    code           : document.code,
    revision       : document.revision,
    idempotencyKey : randomUUID(),
  });
  const production = await app.pacSettings.update({
    revision    : 1,
    environment : 'production',
    envelope    : 'production-secret',
  });
  assert.equal(production.environment, 'production');
  assert.equal(JSON.stringify(production).includes('secret'), false);
  await app.effects.tick();
  assert.equal(app.state.pacCalls[0].code, original.code);
  const historic = await privateDocument(app, document);
  assert.equal(historic.issuerSnapshot.environment, 'development');
  const fresh = await draft(app, sender);
  assert.equal(fresh.issuerSnapshot.environment, 'production');
  await app.pacSettings.update({
    revision    : 2,
    environment : 'development',
    envelope    : 'rotated-secret',
  });
  const rotated = await app.pacSettings.resolve('development');
  await app.pacSettings.update({
    revision    : 3,
    environment : 'production',
  });
  const recovery = await app.commands.enqueue('reconcile', {
    code           : document.code,
    idempotencyKey : randomUUID(),
  });
  assert.equal(
    (await app.store.get('operation', { code: recovery.code })).pacRevision,
    rotated.code,
  );
  assert.equal((await privateDocument(app, document)).uuid, historic.uuid);
  const results = await Promise.allSettled([
    app.pacSettings.update({
      revision    : 4,
      environment : 'development',
    }),
    app.pacSettings.update({
      revision    : 4,
      environment : 'production',
    }),
  ]);
  assert.equal(
    results.filter(
      /** @param {Object} result Resultado. @returns {boolean} Única revisión confirmada. */
      (result) => result.status === 'fulfilled',
    ).length,
    1,
  );
  assert.equal((await app.store.list('pac-revision', {})).pagination.total, 5);
});
test('permisos PAC son globales explícitos y no amplían el ámbito de emisores o comprobantes', /** @returns {Promise<void>} Prueba cuenta compartida incluso sin workspace concreto y aislamiento de los CSD. */ async () => {
  const app  = fixture(),
    first    = await issuer(app),
    document = await draft(app, first);
  const global = await app.pacSettings.getOne();
  app.actor.workspace = 'W2';
  app.actor.policies.push('billing.issuer.view.global', 'billing.document.view.global');
  const second = await issuer(app);
  assert.notEqual(first.code, second.code);
  assert.deepEqual(await app.pacSettings.getOne(), global);
  assert.equal((await app.records.getOne('issuer', { code: first.code })).code, first.code);
  app.actor.policies = app.actor.policies.filter(
    /** @param {string} policy Permiso. @returns Retira sólo la lectura global de emisores. */
    (policy) => policy !== 'billing.issuer.view.global',
  );
  await assert.rejects(app.records.getOne('issuer', { code: first.code }), {
    descriptionCode : 'BILLING_NOT_FOUND',
  });
  await assert.rejects(
    app.file({
      code : document.code,
      kind : 'pdf',
    }),
    { descriptionCode: 'BILLING_NOT_FOUND' },
  );
  app.actor.workspace = 'allWorkspaces';
  assert.deepEqual(await app.pacSettings.getOne(), global);
  app.actor.policies = ['billing.pac.view.workspace', 'billing.pac.update.workspace'];
  await assert.rejects(app.pacSettings.getOne(), { descriptionCode: 'FORBIDDEN' });
  await assert.rejects(
    app.pacSettings.update({
      revision    : 1,
      environment : 'production',
    }),
    { descriptionCode: 'FORBIDDEN' },
  );
});
test('fallo de PDF conserva XML y timbrado; descarga y envío reintentan sin usar PDF del PAC', /** @returns {Promise<void>} Acredita procedencia, referencia estable, reintento y conservación fiscal. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.state.pdfError = true;
  const document = await issue(app, await draft(app, sender));
  const pending  = await privateDocument(app, document);
  assert.equal(pending.status, 'issued');
  assert.equal(pending.error, 'BILLING_PDF_PENDING');
  assert.ok(pending.files.xml);
  assert.equal(pending.files.pdf, undefined);
  const reserved = pending.pdfGeneration.fileId;
  app.state.pdfError = false;
  await app.file({
    code : document.code,
    kind : 'pdf',
  });
  const ready = await privateDocument(app, document);
  assert.equal(ready.pdfOrigin, 'platform');
  assert.equal(ready.files.pdf, reserved);
  assert.equal(ready.uuid, pending.uuid);
  assert.equal(ready.balance, pending.balance);
  assert.equal(app.calls.length, 1);
  const legacy = {
    ...ready,
    files         : {
      ...ready.files,
      pdf : 'legacy-provider-file',
    },
    pdfOrigin     : 'pac',
    pdfGeneration : undefined,
    revision      : ready.revision + 1,
  };
  await app.store.replace('document', ready, legacy);
  await app.commands.enqueue('deliver', {
    code           : document.code,
    idempotencyKey : randomUUID(),
    email          : 'test@example.test',
  });
  await app.effects.tick();
  const regenerated = await privateDocument(app, document);
  assert.notEqual(regenerated.files.pdf, 'legacy-provider-file');
  assert.ok(regenerated.previousPdfFiles.includes('legacy-provider-file'));
  assert.equal(app.state.delivered[0].files.pdf, regenerated.files.pdf);
  assert.equal(app.calls.length, 1);
});
test('descargas concurrentes reservan una sola generación y liberan la reserva fallida', /** @returns {Promise<void>} No publica archivos históricos ni genera en paralelo una referencia compartida. */ async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await issue(app, await draft(app, sender));
  const previous = await privateDocument(app, document);
  await app.store.replace('document', previous, {
    ...previous,
    pdfOrigin : undefined,
    revision  : previous.revision + 1,
  });
  let release;
  app.state.pdfBarrier = new Promise(
    /** @param {Function} resolve Liberación del generador. @returns {void} Mantiene la reserva mientras llega otra descarga. */
    (resolve) => {
      release = resolve;
    },
  );
  const first = app.file({
    code : document.code,
    kind : 'pdf',
  });
  while (app.state.pdfCalls.length < 2)
    await new Promise(
      /** @param {Function} resolve Continuación. @returns {void} Cede el turno a la transacción. */
      (resolve) => setImmediate(resolve),
    );
  await assert.rejects(
    app.file({
      code : document.code,
      kind : 'pdf',
    }),
    { descriptionCode: 'BILLING_PDF_PENDING' },
  );
  release();
  await first;
  assert.equal(app.state.pdfCalls.length, 2);
  assert.notEqual((await privateDocument(app, document)).files.pdf, previous.files.pdf);
  await app.file({
    code : document.code,
    kind : 'pdf',
  });
  assert.equal(app.state.pdfCalls.length, 2);
});
