/** @file Aceptación de comprobantes recibidos, importación recuperable y privacidad documental. */
'use strict';
const test                              = require('node:test');
const assert                            = require('node:assert/strict');
const { randomUUID, createHash }        = require('node:crypto');
const { setup, confirmed }              = require('./expense-fixture.cjs');
const { expenseXml }                    = require('./expense-xml-fixture.cjs');
const { parseExpenseXml, expenseFiles } = require('../server/adapters/documents/expense-files');
const dto                               = require('../server/contracts/registry');
const { storage, input }                = require('./expense-files-fixture.cjs');
test('XML: vista previa, adopción confirmada, historial y acceso privado', /** @returns {Promise<void>} No altera saldo al adoptar el comprobante. */ async () => {
  const files = storage(),
    app       = await setup({ expenseFiles: files }),
    value     = await confirmed(app);
  const file    = await app.expenseAttachments.upload(input(value));
  const preview = await app.expenseXml.preview({
    code   : value.code,
    fileId : file.fileId,
  });
  dto['billing-expense-xml-preview'].output({
    statusCode      : 200,
    descriptionCode : 'OK',
    data            : preview,
  });
  const current = await app.records.getOne('expense', { code: value.code });
  const applied = await app.expenseXml.apply({
    code           : current.code,
    revision       : current.revision,
    fileId         : file.fileId,
    idempotencyKey : randomUUID(),
  });
  assert.equal(applied.balance, value.balance);
  assert.equal(applied.uuid, preview.uuid);
  assert.equal(applied.lines[0].unitPrice, '100.00');
  await assert.rejects(
    app.expenseXml.apply({
      code           : applied.code,
      revision       : applied.revision,
      fileId         : file.fileId,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_EXPENSE_XML_LOCKED' },
  );
  app.actor.workspace = 'W2';
  await assert.rejects(
    app.expenseAttachments.read({
      resource : 'expense',
      code     : applied.code,
      fileId   : file.fileId,
    }),
    { descriptionCode: 'BILLING_NOT_FOUND' },
  );
});
test('XML importado recupera respuesta perdida sin duplicar archivos ni registro', /** @returns {Promise<void>} Reutiliza la intención completa después de efectos parciales. */ async () => {
  const files = storage(),
    app       = await setup({ expenseFiles: files });
  const transfer                                           = input({
    code     : 'unused',
    revision : 1,
  });
  const { resource, code, revision, useXml, ...fileInput } = transfer;
  const { date, currency, exchangeRate, lines, ...header } = app.input;
  const request                                            = {
    ...header,
    ...fileInput,
  };
  files.fail = true;
  await assert.rejects(app.expenseXml.import(request), /response-lost/);
  files.fail = false;
  const value = await app.expenseXml.import(request),
    repeated  = await app.expenseXml.import(request);
  assert.equal(repeated.code, value.code);
  assert.equal(files.originals.size, 1);
  assert.equal(value.files.length, 1);
  assert.equal(value.total, '116.00');
  dto['billing-expense-import-upload'].output({
    statusCode      : 201,
    descriptionCode : 'OK',
    data            : value,
  });
  /** @returns {Promise<Object>} Otro comprobante intenta reutilizar la misma intención. */
  files.parseUpload = async () => parseExpenseXml(expenseXml(randomUUID()));
  await assert.rejects(
    app.expenseXml.import({
      ...request,
      sha256 : 'a'.repeat(64),
    }),
    {
      descriptionCode : 'BILLING_IDEMPOTENCY_CONFLICT',
    },
  );
  assert.equal((await app.store.list('expense', {}, {})).pagination.total, 1);
  assert.equal(files.originals.size, 1);
  const duplicate = await app.expenses.create({
    ...app.input,
    idempotencyKey : randomUUID(),
  });
  const file      = await app.expenseAttachments.upload(input(duplicate));
  await assert.rejects(
    app.expenseXml.apply({
      code           : duplicate.code,
      revision       : 2,
      fileId         : file.fileId,
      idempotencyKey : randomUUID(),
    }),
    { descriptionCode: 'BILLING_EXPENSE_XML_DUPLICATE' },
  );
});
test('XML incompatible, entidades externas, namespace falso e importes inválidos no crean gastos', /** @returns {Promise<void>} Falla antes de persistir referencias monetarias. */ async () => {
  for (const xml of [
    expenseXml().replace('AAA010101AAA', 'CCC010101CCC'),
    expenseXml().replace('Total="116.00"', 'Total="117.00"'),
    expenseXml().replace('ObjetoImp="02"', 'ObjetoImp="99"'),
  ]) {
    const app  = await setup({ expenseFiles: storage(xml) }),
      transfer = input({
        code     : '',
        revision : 1,
      });
    const { resource, code, revision, useXml, ...fileInput } = transfer;
    const { date, currency, exchangeRate, lines, ...header } = app.input;
    await assert.rejects(
      app.expenseXml.import({
        ...header,
        ...fileInput,
      }),
    );
    assert.equal((await app.store.list('expense', {}, {})).pagination.total, 0);
  }
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
    expenseXml().replace('http://www.sat.gob.mx/cfd/4', 'https://invalid.test'),
    expenseXml().replace('http://www.sat.gob.mx/TimbreFiscalDigital', 'https://invalid.test'),
    expenseXml().replace('<cfdi:Receptor ', '<cfdi:Receptor xmlns:cfdi="https://invalid.test" '),
    '<bad>',
  ])
    assert.throws(/** @returns {Object} XML inválido rechazado. */ () => parseExpenseXml(xml));
});
test('adaptador de archivos verifica huella y conserva documentos privados', /** @returns {Promise<void>} Ningún cuerpo declara visibilidad pública ni conoce otros propietarios. */ async () => {
  const bytes = Buffer.from(expenseXml()),
    calls     = [];
  const adapter = expenseFiles({
    temporaryFiles : {
      /** @param {string} p Ruta de prueba. @returns {Promise<string>} Ruta confinada por el doble. */
      validate : async (p) => p,
      promises : {
        /** @returns {Promise<Object>} Tamaño del original de prueba. */
        stat     : async () => ({
          /** @returns {boolean} Archivo regular sintético. */
          isFile : () => true,
          size   : bytes.length,
        }),
        /** @returns {Promise<Buffer>} Bytes originales. */
        readFile : async () => bytes,
      },
      /** @returns {Promise<void>} Temporal simulado sin archivo físico. */
      remove   : async () => {},
    },
    messaging      : {
      /** @param {Array} args Operación y contexto documental. @returns {Promise<Object>} Acuse del doble privado. */
      request : async (...args) => {
        calls.push(args);
        return {
          statusCode : 200,
          data       : {},
        };
      },
    },
  });
  const request = input({
    code     : 'e1',
    revision : 1,
  });
  const file    = await adapter.inspect(request);
  await adapter.upload(
    {
      code      : 'e1',
      workspace : 'W1',
    },
    'expense',
    {
      ...file,
      fileId : 'f1',
    },
    request.tempFilePath,
  );
  assert.equal(calls[0][2].visibility, 'private');
  assert.equal(calls[0][2].resourceType, 'billing-expense');
  await assert.rejects(
    adapter.inspect({
      ...request,
      sha256 : '0'.repeat(64),
    }),
    { descriptionCode: 'BILLING_FILE_DIGEST_MISMATCH' },
  );
});
test('MCP revocado durante carga no adopta un comprobante con permisos anteriores', /** @returns {Promise<void>} La reserva queda recuperable sin ampliar autorización. */ async () => {
  const files = storage(),
    app       = await setup({ expenseFiles: files }),
    value     = await app.expenses.create(app.input);
  app.actor.delegation = {
    grantCode : 'G1',
    clientId  : 'C1',
  };
  app.actor.operation = { idempotencyKey: randomUUID() };
  const upload = files.upload.bind(files);
  /** @param {Object} owner Propietario. @param {string} resource Tipo. @param {Object} file Referencia. @returns {Promise<void>} Simula revocación durante el efecto externo. */
  files.upload = async (owner, resource, file) => {
    await upload(owner, resource, file);
    app.state.revoked = true;
  };
  await assert.rejects(
    app.delegated.execute(
      'billing-expense-file-upload',
      input(value),
      app.expenseAttachments.upload,
    ),
    { descriptionCode: 'OAUTH_CONNECTION_REVOKED' },
  );
  assert.equal((await app.records.getOne('expense', { code: value.code })).files.length, 0);
});
