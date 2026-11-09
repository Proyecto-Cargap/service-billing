/** @file Aceptación del diagnóstico de transición con varias cuentas y ambientes, sin secretos ni selección arbitraria. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { randomBytes }                     = require('node:crypto');
const { billingSecrets }                  = require('../server/adapters/crypto/billing-secrets');
const { binding, pacBinding, billingPac } = require('../server/adapters/pac/billing-pac');
const { prepareMigration }                = require('../ops/migrate-pac-global.cjs');
/** @param {Object} secrets Custodia real. @param {string} code Emisor. @param {string} environment Ambiente. @param {string} apiKey Cuenta sintética. @returns {Object} Emisor con formato antiguo cifrado. */
function legacyIssuer(secrets, code, environment, apiKey) {
  return {
    code,
    workspace      : 'W1',
    revision       : 1,
    environment,
    template       : 'obsolete',
    configured     : true,
    taxId          : code,
    secretEnvelope : secrets.seal(
      {
        apiKey,
        keyPEM : 'KEY',
        cerPEM : 'CERT',
      },
      `billing:W1:${code}:${environment}`,
    ),
  };
}
test('transición exige decisiones explícitas, conserva originales y no mezcla ni fusiona cuentas', /** @returns {void} Verifica cifrado separado y retirada completa de los campos obsoletos. */ () => {
  const secrets   = billingSecrets(randomBytes(32).toString('base64'));
  const issuers   = [
    legacyIssuer(secrets, 'I1', 'development', 'A'.repeat(32)),
    legacyIssuer(secrets, 'I2', 'production', 'B'.repeat(32)),
    legacyIssuer(secrets, 'I3', 'production', 'C'.repeat(32)),
  ];
  const data      = {
    issuers,
    documents  : [
      {
        code           : 'D1',
        workspace      : 'W1',
        issuerCode     : 'I2',
        revision       : 1,
        uuid           : 'old-uuid',
        issuerSnapshot : { environment: 'production' },
        files          : {
          xml : 'original-xml',
          pdf : 'original-pdf',
        },
      },
    ],
    operations : [
      {
        code       : 'O1',
        workspace  : 'W1',
        issuerCode : 'I3',
        revision   : 1,
        kind       : 'issue',
        status     : 'queued',
      },
    ],
  };
  const diagnosis = prepareMigration(data, { secrets }).report;
  assert.equal(diagnosis.ready, false);
  assert.equal(JSON.stringify(diagnosis).includes('BBBB'), false);
  const plan = prepareMigration(data, {
    secrets,
    activeEnvironment : 'production',
    selections        : { production: 'I2' },
  });
  assert.equal(plan.report.ready, true);
  assert.equal(plan.issuers.length, 3);
  assert.equal(plan.pac.configCode, plan.revisions[1].code);
  assert.equal(plan.operations[0].pacRevision, plan.revisions[2].code);
  assert.equal(plan.documents[0].originalPacRevision, plan.revisions[1].code);
  assert.deepEqual(plan.documents[0].files, data.documents[0].files);
  for (const issuer of plan.issuers) {
    for (const key of ['template', 'environment', 'secretEnvelope', 'configured'])
      assert.equal(Object.hasOwn(issuer, key), false);
    assert.deepEqual(secrets.open(issuer.csdEnvelope, binding(issuer)), {
      keyPEM : 'KEY',
      cerPEM : 'CERT',
    });
  }
  assert.equal(
    secrets.open(plan.revisions[1].secretEnvelope, pacBinding(plan.revisions[1])).apiKey,
    'B'.repeat(32),
  );
  const repeated = prepareMigration(
    {
      issuers    : plan.issuers,
      documents  : plan.documents,
      operations : plan.operations,
      pac        : plan.pac,
    },
    { secrets },
  );
  assert.equal(repeated.report.ready, true);
  assert.equal(repeated.issuers.length + repeated.documents.length + repeated.operations.length, 0);
  const conflict = prepareMigration(
    {
      ...data,
      issuers : [
        ...issuers,
        {
          ...issuers[0],
          code : 'DUPLICATE',
        },
      ],
    },
    { secrets },
  );
  assert.ok(
    conflict.report.errors.some(
      /** @param {string} error Diagnóstico. @returns {boolean} El conflicto requiere intervención, nunca una fusión automática. */
      (error) => error.includes('RFC duplicado'),
    ),
  );
});
test('adaptador usa timbrarJSON con CSD separado y retira cualquier PDF de la respuesta persistible', /** @returns {Promise<void>} Custodia auténtica AES-GCM y parámetros exactos sin plantilla. */ async () => {
  const secrets = billingSecrets(randomBytes(32).toString('base64'));
  const config  = {
    code        : 'REV1',
    environment : 'development',
  };
  config.secretEnvelope = secrets.seal({ apiKey: 'A'.repeat(32) }, pacBinding(config));
  const issuer = {
    code      : 'I1',
    workspace : 'W1',
    pacConfig : config,
  };
  issuer.csdEnvelope = secrets.seal(
    {
      keyPEM : 'KEY',
      cerPEM : 'CERT',
    },
    binding(issuer),
  );
  const calls = [],
    adapter   = billingPac({
      secrets,
      soap : {
        /** @param {string} environment Destino. @param {string} method Contrato. @param {Object} input Parámetros. @returns {Promise<Object>} Respuesta fiscal simulada. */
        async call(environment, method, input) {
          calls.push({
            environment,
            method,
            input,
          });
          return {
            code : '200',
            data : JSON.stringify({
              xml : '<xml/>',
              PDF : 'INVALID',
              pdf : 'ALSO-IGNORED',
            }),
          };
        },
      },
    });
  const response = await adapter.issue(issuer, { Comprobante: {} });
  assert.equal(calls[0].method, 'timbrarJSON');
  assert.deepEqual(Object.keys(calls[0].input).sort(), ['apikey', 'cerPEM', 'jsonB64', 'keyPEM']);
  assert.deepEqual(JSON.parse(response.data), { xml: '<xml/>' });
  await adapter.credits(config);
  assert.deepEqual(Object.keys(calls[1].input), ['apikey']);
  assert.throws(
    /** @returns {Object} No permite abrir un CSD en otro workspace. */
    () =>
      secrets.open(
        issuer.csdEnvelope,
        binding({
          ...issuer,
          workspace : 'W2',
        }),
      ),
    /BILLING_INVALID_CREDENTIAL_ENVELOPE/,
  );
});
module.exports = { legacyIssuer };
