/** @file Verifica límites de autorización, exactitud decimal, custodia y protocolo SOAP sin llamadas externas. */
'use strict';
const test                        = require('node:test');
const assert                      = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const {
  calculate,
  validateTaxObject,
  paymentTaxObject,
} = require('../server/modules/billing/services/amounts.service');
const {
  billingAccess,
  billingPermit,
} = require('../server/modules/billing/policies/billing-access.policy');
const { billingSecrets }                      = require('../server/adapters/crypto/billing-secrets');
const { facturaloplus, parseXml }             = require('../server/adapters/pac/facturaloplus');
const { validateBillingDate }                 = require('../server/modules/billing/services/billing-date.service');
const { fixture, issuer, draft, line, issue } = require('./fixture.cjs');
const { validate }                            = require('../server/contracts/action-dto');
const manifest                                = require('../server/contracts/service.json');
test('decimales y objetos fiscales vigentes se validan sin aritmética binaria' /** @returns {void} Verifica redondeo y restricciones de objetos 06, 07 y 08. */, () => {
  assert.equal(
    calculate(
      [
        {
          ...line,
          quantity  : '3',
          unitPrice : '0.1',
        },
      ],
      2,
    ).total,
    '0.35',
  );
  for (const code of ['06', '08']) {
    validateTaxObject(code, [
      {
        kind : 'withheld',
        code : '001',
      },
    ]);
    assert.throws(
      /** @returns {void} IVA no se admite en estos objetos. */
      () => validateTaxObject(code, line.taxes),
      /BILLING_TAX_OBJECT_CONFLICT/,
    );
  }
  validateTaxObject('07', [
    {
      kind : 'transferred',
      code : '003',
    },
  ]);
  assert.throws(
    /** @returns {void} IEPS trasladado es obligatorio para 07. */
    () => validateTaxObject('07', []),
    /BILLING_TAX_OBJECT_CONFLICT/,
  );
  assert.equal(paymentTaxObject([{ taxObject: '03' }]), '03');
  assert.throws(
    /** @returns {void} Rechaza un día inexistente sin normalizarlo. */
    () => validateBillingDate('2026-02-30T12:00:00'),
    /BILLING_INVALID_DATE/,
  );
});
test('owner y assigned se unen y limitan la intención fiscal al registro autorizado' /** @returns {void} La existencia de un permiso no autoriza todos los objetivos. */, () => {
  const actor = {
    workspace : 'W1',
    user      : { userCode: 'U1' },
    policies  : ['billing.issuance.create.owner', 'billing.issuance.create.assigned'],
  };
  assert.deepEqual(billingAccess(actor, 'issuance', 'create'), {
    workspace : 'W1',
    $or       : [{ userCreate: 'U1' }, { userAssigned: 'U1' }],
  });
  billingPermit(actor, 'issuance', 'create', {
    workspace    : 'W1',
    userCreate   : 'U2',
    userAssigned : 'U1',
  });
  assert.throws(
    /** @returns {void} Rechaza un objetivo ajeno. */
    () =>
      billingPermit(actor, 'issuance', 'create', {
        workspace    : 'W1',
        userCreate   : 'U2',
        userAssigned : 'U2',
      }),
    /FORBIDDEN/,
  );
  assert.throws(
    /** @returns {void} Rechaza otro workspace aunque coincida el propietario. */
    () =>
      billingPermit(actor, 'issuance', 'create', {
        workspace  : 'W2',
        userCreate : 'U1',
      }),
    /FORBIDDEN/,
  );
});
test('AES-GCM impide trasladar credenciales de pruebas a producción' /** @returns {void} El cifrado autentica contenido y propietario. */, () => {
  const secrets = billingSecrets(randomBytes(32).toString('base64')),
    binding     = 'billing:W1:I1:development',
    input       = {
      apiKey : 'TEST',
      keyPEM : 'PRIVATE-TEST',
    },
    envelope    = secrets.seal(input, binding);
  assert.ok(!envelope.includes('PRIVATE-TEST'));
  assert.deepEqual(secrets.open(envelope, binding), input);
  assert.throws(
    /** @returns {Object} Otro ambiente no puede abrir el sobre. */
    () => secrets.open(envelope, binding.replace('development', 'production')),
    /BILLING_INVALID_CREDENTIAL_ENVELOPE/,
  );
});
test('SOAP conserva WSDL, escapes y referencias locales y nunca reintenta una respuesta perdida' /** @returns {Promise<void>} Acredita el adaptador con respuestas controladas. */, async () => {
  const calls = [];
  const soap  = facturaloplus({
    timeoutMs : 1000,
    /** @param {string} url Destino. @param {Object} options Solicitud. @returns {Promise<Response>} Respuesta RPC encoded de prueba. */
    fetch     : async (url, options) => {
      calls.push({
        url,
        options,
      });
      return new Response(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><consultarCFDIResponse><return href="#id1"/></consultarCFDIResponse><multiRef id="id1"><code>200</code><message>OK</message><data>&lt;xml/&gt;</data></multiRef></s:Body></s:Envelope>',
      );
    },
  });
  assert.equal(
    (
      await soap.call('development', 'consultarCFDI', {
        apikey : 'a&<b',
        uuid   : randomUUID(),
      })
    ).data,
    '<xml/>',
  );
  assert.equal(calls[0].url, 'https://dev.facturaloplus.com/ws/servicio.do');
  assert.match(calls[0].options.body, /a&amp;&lt;b/);
  assert.equal(calls[0].options.headers.SOAPAction, '"urn:ServicioTimbradoWS#consultarCFDI"');
  const empty = facturaloplus({
    timeoutMs : 1000,
    /** @returns {Promise<Response>} Rechazo real del PAC con cadena vacía tipada. */
    fetch     : async () =>
      new Response(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Body><consultarCFDIResponse><return><code xsi:type="xsd:string">404</code><message xsi:type="xsd:string">No se ha encontrado el CFDI consultado.</message><data xsi:type="xsd:string"></data></return></consultarCFDIResponse></s:Body></s:Envelope>',
      ),
  });
  assert.deepEqual(
    await empty.call('development', 'consultarCFDI', {
      apikey : 'test',
      uuid   : randomUUID(),
    }),
    {
      code    : '404',
      message : 'No se ha encontrado el CFDI consultado.',
      data    : '',
    },
  );
  let count     = 0;
  const failing = facturaloplus({
    timeoutMs : 1000,
    /** @returns {Promise<Response>} Fallo de red después del envío. */
    fetch     : async () => {
      count++;
      throw new Error('socket closed');
    },
  });
  await assert.rejects(
    /** @returns {Promise<Object>} Solicitud única sin reintentos. */
    () =>
      failing.call('production', 'consultarCFDI', {
        apikey : 'test',
        uuid   : randomUUID(),
      }),
    /** @param {Error} error Resultado. @returns {boolean} Incertidumbre explícita sin exponer la excepción externa. */
    (error) => error.uncertain === true && error.descriptionCode === 'BILLING_PAC_OUTCOME_UNKNOWN',
  );
  assert.equal(count, 1);
  assert.throws(
    /** @returns {Object} Nunca expande entidades externas. */
    () => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///tmp/private">]><a>&x;</a>'),
    /BILLING_INVALID_PAC_RESPONSE/,
  );
});
test('la resolución exige ausencia de timbrado y las salidas reales cumplen el contrato público' /** @returns {Promise<void>} Comprueba proyecciones de aplicación sin secretos y recuperación auditada. */, async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await draft(app, sender);
  app.state.pacError = true;
  const op = await app.commands.enqueue('issue', {
    code           : document.code,
    revision       : document.revision,
    idempotencyKey : 'unknown',
  });
  await app.effects.tick();
  const pending = await app.records.getOne('operation', { code: op.code });
  await app.resolution.resolve({
    code     : op.code,
    revision : pending.revision,
    outcome  : 'not-issued',
    evidence : 'PAC confirmó no emisión, ticket TEST-123',
  });
  app.state.pacError = false;
  const issued = await issue(app, await app.records.getOne('document', { code: document.code }));
  for (const [action, data] of [
    ['billing-issuer-get-one', sender],
    ['billing-document-get-one', issued],
  ]) {
    const schema = manifest.endpoints.find(
      /** @param {Object} endpoint Contrato. @returns {boolean} Acción requerida. */
      (endpoint) => endpoint.name === action,
    ).successData;
    assert.equal(validate(data, schema, false), true, action);
  }
  assert.equal('secretEnvelope' in sender, false);
  assert.equal('expectedLayout' in issued, false);
  assert.equal(app.calls.length, 2);
});
