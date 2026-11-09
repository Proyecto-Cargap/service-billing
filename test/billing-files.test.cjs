/** @file Puerto documental real: generación exclusiva, almacenamiento privado, errores e idempotencia con limpieza de temporales. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const fs = require('node:fs'),
  os     = require('node:os'),
  path   = require('node:path');
const { randomUUID }                    = require('node:crypto');
const { fixture, issuer, draft, issue } = require('./fixture.cjs');
const { xmlFixture }                    = require('./cfdi-fixture.cjs');
const { billingFiles }                  = require('../server/adapters/documents/billing-files');
const { createTemporaryFiles }          = require('../server/adapters/filesystem/temporary-files');
test('Documents recibe exclusivamente el XML acreditado, conserva privacidad y limpia archivos incluso tras fallos', /** @returns {Promise<void>} RPC y almacenamiento simulados; adaptador, filesystem y acreditación XML reales. */ async () => {
  const root           = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-files-'));
  const temporaryFiles = createTemporaryFiles({ root });
  const app = fixture(),
    sender  = await issuer(app),
    issued  = await issue(app, await draft(app, sender));
  const document = await app.store.get('document', { code: issued.code }),
    xml          = xmlFixture(document.expectedLayout, document.uuid);
  const stored = new Map(),
    calls      = [];
  let failure = '',
    invalid   = false;
  const files = billingFiles({
    temporaryFiles,
    messaging : {
      /** @param {string} service Destino. @param {string} action Capacidad. @param {Object} input Contrato. @returns {Promise<Object>} PDF local o error reproducible sin llamadas externas. */
      async request(service, action, input) {
        assert.equal(service, 'service-documents');
        calls.push(action);
        if (action === failure)
          return {
            statusCode      : 503,
            descriptionCode : 'FILES_UNAVAILABLE',
          };
        if (action === 'files-storage-read') {
          if (!stored.has(input.fileId)) return { statusCode: 404 };
          const tempFilePath = temporaryFiles.uniquePath('stored.pdf');
          await fs.promises.writeFile(tempFilePath, stored.get(input.fileId));
          return {
            statusCode : 200,
            data       : { tempFilePath },
          };
        }
        if (action === 'pdf-billing-create') {
          assert.equal(
            new URL(input.document.verificationUrl).searchParams.get('id'),
            document.uuid,
          );
          const tempFilePath = temporaryFiles.uniquePath('rendered.pdf');
          await fs.promises.writeFile(tempFilePath, invalid ? 'INVALID' : '%PDF-1.7\nPLATFORM');
          return {
            statusCode : 200,
            data       : { tempFilePath },
          };
        }
        assert.equal(action, 'files-storage-upload');
        assert.equal(input.visibility, 'private');
        assert.equal(input.workspace, document.workspace);
        assert.equal(input.resourceCode, document.code);
        stored.set(input.fileId, await fs.promises.readFile(input.tempFilePath));
        return {
          statusCode : 200,
          data       : {},
        };
      },
    },
  });
  try {
    const id = randomUUID();
    for (const error of ['pdf-billing-create', 'files-storage-upload']) {
      failure = error;
      await assert.rejects(files.generatePdf(document, xml, id), /FILES_UNAVAILABLE/);
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(stored.size, 0);
    }
    failure = '';
    invalid = true;
    await assert.rejects(files.generatePdf(document, xml, id), /BILLING_INVALID_PDF/);
    assert.deepEqual(fs.readdirSync(root), []);
    invalid = false;
    await files.generatePdf(document, xml, id);
    assert.equal(stored.size, 1);
    const previous = calls.length;
    await files.generatePdf(document, xml, id);
    assert.deepEqual(calls.slice(previous), ['files-storage-read']);
    assert.deepEqual(fs.readdirSync(root), []);
    await assert.rejects(
      files.generatePdf(document, xml.replace('Total="116.00"', 'Total="1.00"'), randomUUID()),
      /BILLING_PAC_DOCUMENT_MISMATCH/,
    );
  } finally {
    fs.rmSync(root, {
      recursive : true,
      force     : true,
    });
  }
});
