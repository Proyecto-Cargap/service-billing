/** @file Verifica asignación de emisores, permisos sin propietario, continuidad histórica y custodia independiente de los documentos. */
'use strict';
const test                                    = require('node:test');
const assert                                  = require('node:assert/strict');
const { randomBytes }                         = require('node:crypto');
const { fixture, issuer, draft, issue, line } = require('./fixture.cjs');
const {
  billingAccess,
  billingPermit,
} = require('../server/modules/billing/policies/billing-access.policy');
const { billingPac, binding } = require('../server/adapters/pac/billing-pac');
const { billingSecrets }      = require('../server/adapters/crypto/billing-secrets');
const { editable }            = require('../server/modules/billing/presenters/billing.presenter');
const { prepareMigration }    = require('../ops/migrate-issuer-workspaces.cjs');
const { validate }            = require('../server/contracts/action-dto');
const manifest                = require('../server/contracts/service.json');
/** @param {Object} app Aplicación. @param {Object} sender Emisor observado. @param {string} workspace Destino. @returns {Promise<Object>} Reasignación con revisión y datos editables reales. */
function move(app, sender, workspace) {
  return app.records.update('issuer', {
    ...editable('issuer', sender),
    code     : sender.code,
    revision : sender.revision,
    workspace,
  });
}
test('emisores ignoran owner/assigned y admiten únicamente global/workspace' /** @returns {void} Comprueba sesiones antiguas y registros con autores diferentes. */, () => {
  for (const action of ['view', 'create', 'update']) {
    for (const scope of ['owner', 'assigned']) {
      assert.throws(
        /** @returns {Object} Los permisos retirados nunca autorizan. */
        () =>
          billingAccess(
            {
              workspace : 'W1',
              user      : { userCode: 'U1' },
              policies  : [`billing.issuer.${action}.${scope}`],
            },
            'issuer',
            action,
          ),
        /FORBIDDEN/,
      );
    }
    const actor = {
      workspace : 'W1',
      user      : { userCode: 'U1' },
      policies  : [`billing.issuer.${action}.workspace`],
    };
    for (const workspace of ['W1', 'allWorkspaces'])
      billingPermit(actor, 'issuer', action, {
        workspace,
        userCreate   : 'OTHER',
        userAssigned : 'OTHER',
      });
    assert.throws(
      /** @returns {void} Un emisor de otro espacio conserva su aislamiento. */
      () =>
        billingPermit(actor, 'issuer', action, {
          workspace  : 'W2',
          userCreate : 'U1',
        }),
      /FORBIDDEN/,
    );
  }
  assert.ok(
    !require('../config/policies.json').some(
      /** @param {Object} policy Política publicada. @returns Permiso retirado todavía publicado. */
      (policy) => /^billing\.issuer\..*\.(owner|assigned)$/.test(policy.identifier),
    ),
  );
});
test('la asignación es obligatoria, se acredita en Security y se limita al destino permitido' /** @returns {Promise<void>} Contratos y aplicación rechazan omisiones, destinos ajenos e inexistentes. */, async () => {
  const app = fixture(),
    sender  = await issuer(app);
  const input = editable('issuer', sender);
  for (const name of ['billing-issuer-create', 'billing-issuer-update']) {
    const schema = manifest.endpoints.find(
      /** @param {Object} endpoint Acción. @returns Contrato objetivo. */
      (endpoint) => endpoint.name === name,
    ).request;
    const value  = name.endsWith('update')
      ? {
          ...input,
          code     : sender.code,
          revision : sender.revision,
        }
      : { ...input };
    assert.equal(validate(value, schema, false), true);
    delete value.workspace;
    assert.equal(validate(value, schema, false), false);
  }
  await assert.rejects(move(app, sender, 'W2'), /FORBIDDEN/);
  app.actor.policies.push('billing.issuer.update.global');
  await assert.rejects(move(app, sender, 'missing'), /BILLING_WORKSPACE_UNAVAILABLE/);
  await assert.rejects(move(app, sender, ''), /BILLING_WORKSPACE_REQUIRED/);
  assert.equal((await app.records.getOne('issuer', { code: sender.code })).workspace, 'W1');
});
test('compartir y restringir conserva borradores, notas de crédito, cobros y REP en su workspace original' /** @returns {Promise<void>} Ejercita los casos de uso reales y prohíbe facturas independientes desde el espacio anterior. */, async () => {
  const app     = fixture();
  let sender    = await issuer(app);
  const pending = await draft(app, sender);
  sender = await move(app, sender, 'allWorkspaces');
  assert.equal(sender.csdConfigured, true);
  app.actor.workspace = 'W2';
  assert.equal((await app.records.getList('issuer', {})).items[0].code, sender.code);
  const second = await issue(app, await draft(app, sender));
  assert.equal(second.workspace, 'W2');
  sender = await move(app, sender, 'W2');
  app.actor.workspace = 'W1';
  assert.equal((await app.records.getList('issuer', {})).items.length, 0);
  await assert.rejects(app.records.getOne('issuer', { code: sender.code }), /BILLING_NOT_FOUND/);
  await assert.rejects(draft(app, sender), /BILLING_NOT_FOUND/);
  const invoice = await issue(app, pending);
  assert.equal(invoice.status, 'issued');
  assert.equal(invoice.workspace, 'W1');
  const credit = await issue(
    app,
    await draft(app, sender, {
      type                : 'E',
      relatedDocumentCode : invoice.code,
      relationship        : '01',
      paymentMethod       : 'PUE',
      paymentForm         : '15',
      lines               : [
        {
          ...line,
          unitPrice : '10',
        },
      ],
    }),
  );
  assert.equal(credit.status, 'issued');
  const receipt = await app.receipts.create({
    issuerCode     : sender.code,
    customerCode   : 'CUS1',
    currency       : 'MXN',
    exchangeRate   : '1',
    amount         : '10',
    date           : '2026-10-22T07:00:00',
    paymentForm    : '03',
    reference      : 'Prueba',
    allocations    : [
      {
        documentCode : invoice.code,
        amount       : '10',
        equivalence  : '1',
      },
    ],
    idempotencyKey : 'historic-payment',
  });
  const rep     = await app.receipts.createRep({
    code     : receipt.code,
    revision : receipt.revision,
    date     : '2026-10-22T07:00:00',
  });
  assert.equal((await issue(app, rep)).status, 'issued');
  await app.commands.enqueue('cancel', {
    code           : credit.code,
    revision       : credit.revision,
    reason         : '02',
    idempotencyKey : 'historic-cancel',
  });
  await app.effects.tick();
  assert.equal(
    (await app.records.getOne('document', { code: credit.code })).status,
    'cancel-requested',
  );
  const audits = await app.records.getList('audit', {});
  assert.ok(
    audits.items.some(
      /** @param {Object} item Evidencia. @returns Reasignación con ambos destinos. */
      (item) =>
        item.action === 'workspace-changed' && JSON.parse(item.reason).previousWorkspace === 'W1',
    ),
  );
});
test('una operación encolada sigue autorizada por su documento tras mover el emisor' /** @returns {Promise<void>} Conserva la intención sin permitir referencias históricas falsificadas. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender);
  await app.commands.enqueue('issue', {
    code           : document.code,
    revision       : document.revision,
    idempotencyKey : 'before-move',
  });
  app.actor.policies.push('billing.issuer.update.global');
  await move(app, sender, 'W2');
  await app.effects.tick();
  assert.equal((await app.records.getOne('document', { code: document.code })).status, 'issued');
  app.actor.workspace = 'W2';
  await assert.rejects(app.records.historicalIssuer(document), /BILLING_NOT_FOUND/);
  app.actor.workspace = 'W1';
  app.actor.policies = ['billing.document.view.workspace', 'billing.issuer.view.owner'];
  await assert.rejects(app.records.historicalIssuer(document), /FORBIDDEN/);
});
test('fallos de recifrado y revisiones obsoletas conservan asignación y custodia' /** @returns {Promise<void>} La transacción no deja asignaciones parciales. */, async () => {
  const app = fixture(),
    sender  = await issuer(app);
  app.state.rebindError = true;
  await assert.rejects(move(app, sender, 'allWorkspaces'), /REBIND_FAILED/);
  assert.equal((await app.records.getOne('issuer', { code: sender.code })).workspace, 'W1');
  app.state.rebindError = false;
  await move(app, sender, 'allWorkspaces');
  await assert.rejects(move(app, sender, 'W1'), /BILLING_REVISION_CONFLICT/);
  const secrets = billingSecrets(randomBytes(32).toString('base64'));
  const previous = {
      code      : 'I1',
      workspace : 'W1',
    },
    next         = {
      code      : 'I1',
      workspace : 'allWorkspaces',
    };
  previous.csdEnvelope = secrets.seal({ keyPEM: 'synthetic' }, binding(previous));
  const envelope = billingPac({
    secrets,
    soap : {},
  }).rebindCsd(previous, next);
  assert.deepEqual(secrets.open(envelope, binding(next)), { keyPEM: 'synthetic' });
  assert.throws(
    /** @returns {Object} El sobre nuevo no se puede abrir con la asignación anterior. */
    () => secrets.open(envelope, binding(previous)),
    /BILLING_INVALID_CREDENTIAL_ENVELOPE/,
  );
});
test('la transición conserva máximos reservados y detecta identidades ambiguas' /** @returns {void} Consolida contadores sin reutilizar reservas documentales ni fusionar emisores. */, () => {
  const source = {
    issuerCode  : 'I1',
    environment : 'production',
    type        : 'I',
    series      : 'F',
  };
  const data   = {
    issuers   : [
      {
        code      : 'I1',
        workspace : 'W1',
        taxId     : 'RFC',
      },
    ],
    folios    : [
      {
        ...source,
        workspace : 'W1',
        value     : 12,
      },
      {
        ...source,
        workspace : 'W2',
        value     : 9,
      },
    ],
    documents : [
      {
        ...source,
        folio          : '14',
        issuerSnapshot : { environment: 'production' },
      },
    ],
  };
  const plan   = prepareMigration(data);
  assert.equal(plan.report.ready, true);
  assert.deepEqual(plan.folios, [
    {
      ...source,
      value : 14,
    },
  ]);
  assert.deepEqual(
    prepareMigration({
      ...data,
      folios : plan.folios,
    }).folios,
    plan.folios,
  );
  data.issuers.push({
    code      : 'I1',
    workspace : 'W2',
    taxId     : 'RFC',
  });
  assert.equal(prepareMigration(data).report.ready, false);
});

test('global administra emisores desde allWorkspaces sin ofrecer emisores ajenos para facturas nuevas' /** @returns {Promise<void>} Contrasta catálogo agregado, selector concreto y creación explícita. */, async () => {
  const app = fixture(),
    first   = await issuer(app);
  app.actor.workspace = 'W2';
  const second = await issuer(app);
  app.actor.policies.push(
    'billing.issuer.view.global',
    'billing.issuer.create.global',
    'billing.issuer.update.global',
  );
  assert.equal((await app.records.getOne('issuer', { code: first.code })).code, first.code);
  assert.deepEqual(
    (await app.records.getList('issuer', {})).items.map(
      /** @param {Object} item Emisor. @returns Identidad ofrecida para el workspace activo. */
      (item) => item.code,
    ),
    [second.code],
  );
  await assert.rejects(draft(app, first), /BILLING_NOT_FOUND/);
  app.actor.workspace = 'allWorkspaces';
  assert.equal((await app.records.getList('issuer', {})).items.length, 2);
  const created = await app.records.create('issuer', {
    ...editable('issuer', first),
    taxId     : 'CCC010101CCC',
    workspace : 'allWorkspaces',
  });
  assert.equal(created.workspace, 'allWorkspaces');
  assert.equal(created.csdConfigured, false);
  await assert.rejects(draft(app, created), /BILLING_WORKSPACE_REQUIRED/);
});
test('una autorización de cancelación aceptada conserva sus permisos originales después de la reasignación' /** @returns {Promise<void>} No exige lectura de operaciones ni permisos por usuario para usar el emisor compartido. */, async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const app  = fixture({
    pac : {
      /** @returns {Promise<Object>} Solicitud sintética pendiente en el PAC de prueba. */
      async pending() {
        return {
          code : '100',
          data : uuid,
        };
      },
      /** @returns {Promise<Object>} Autorización sintética confirmada. */
      async authorize() {
        return { code: '200' };
      },
    },
  });
  let sender = await issuer(app);
  sender = await move(app, sender, 'allWorkspaces');
  const operation = await app.commands.enqueue('authorize', {
    code           : sender.code,
    uuid,
    accept         : true,
    idempotencyKey : 'authorization-before-move',
  });
  app.actor.policies.push('billing.issuer.update.global');
  await move(app, sender, 'W2');
  app.actor.policies = ['billing.issuer.view.workspace', 'billing.cancellation.create.workspace'];
  await app.effects.tick();
  assert.equal((await app.store.get('operation', { code: operation.code })).status, 'succeeded');
});
