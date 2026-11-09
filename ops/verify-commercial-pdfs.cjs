/** @file Renderiza comprobantes comerciales sintéticos con Documents real, sin PAC ni persistencia remota. */
'use strict';
const fs = require('node:fs'),
  path   = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync }          = require('node:child_process');
const { randomUUID }            = require('node:crypto');
const { createRequire }         = require('node:module');
const { fixture, issuer, line } = require('../test/fixture.cjs');
const { billingFiles }          = require('../server/adapters/documents/billing-files');
/** @returns {Promise<void>} Muestras privadas con comprobación de importes históricos. */
async function main() {
  const output = path.resolve(__dirname, '../tmp/commercial-pdf-acceptance'),
    temp       = path.join(output, 'temporary');
  fs.mkdirSync(temp, { recursive: true });
  const root         = path.resolve(__dirname, '../../service-documents'),
    requireDocuments = createRequire(path.join(root, 'package.json'));
  const assets = path.resolve(__dirname, '../../../../infrastructure/billing');
  const config = path.join(output, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(assets, 'pdf-config.example.json'), 'utf8')),
      assetRoot : assets,
    }),
  );
  const temporaryFiles = requireDocuments(
    './server/adapters/filesystem/temporary-files',
  ).createTemporaryFiles({
    root      : temp,
    readRoots : [assets],
  });
  const env            = {
    TEMP            : temp,
    PDF_CONFIG_FILE : config,
  };
  const logger         = {
    /** @param {Object} error Fallo saneado. @returns {void} Expone sólo el código del renderer. */ error(
      error,
    ) {
      console.error(error.code);
    },
  };
  const pdf            = new (requireDocuments('./server/modules/pdf/services/pdf.service')({
    env,
    temporaryFiles,
    logger,
    handlebars                                                                                                                 : requireDocuments('handlebars'),
    pdfRegistry                                                                                                                : {
      /** @returns {Object} Registro aprobado local. */ load : () =>
        requireDocuments('./server/adapters/rendering/pdf-registry').loadRegistry(env),
      asset                                                  : requireDocuments('./server/adapters/rendering/pdf-registry').approvedAsset,
    },
    /** @param {Object} options Dependencias del renderer. @returns {Object} Chromium local sin RPC externo. */ createRenderer :
      (options) =>
        requireDocuments('./server/adapters/rendering/pdf-renderer').createPdfRenderer({
          ...options,
          puppeteer : requireDocuments('puppeteer'),
          temporaryFiles,
          logger,
        }),
  }))();
  const views          = [];
  const files          = billingFiles({
    temporaryFiles,
    messaging : {
      /** @param {string} service Destino. @param {string} action Acción. @param {Object} data Entrada. @returns {Promise<Object>} Render real y almacenamiento local aislado. */ async request(
        service,
        action,
        data,
      ) {
        assert.equal(service, 'service-documents');
        if (action === 'files-storage-read') return { statusCode: 404 };
        if (action === 'pdf-billing-commercial-create') {
          requireDocuments('./server/contracts/registry')[action].input(data);
          views.push(data.document);
          return {
            statusCode : 200,
            data       : await pdf.commercialCreate(data),
          };
        }
        assert.equal(action, 'files-storage-upload');
        assert.equal(data.visibility, 'private');
        assert.match(data.resourceType, /^billing-(sale|receipt)$/);
        fs.copyFileSync(data.tempFilePath, path.join(output, data.resourceCode + '.pdf'));
        return {
          statusCode : 200,
          data       : {},
        };
      },
    },
  });
  const app = fixture(),
    sender  = await issuer(app);
  app.customer.fiscal = {};
  app.customer.tradeName = 'Cliente sin datos fiscales';
  const draft    = await app.sales.create({
    issuerCode       : sender.code,
    customerCode     : 'CUS1',
    currency         : 'MXN',
    exchangeRate     : '1',
    date             : '2026-10-22T07:00:00',
    lines            : [
      {
        ...line,
        description : 'Servicio comercial de aceptación',
        unitPrice   : '1000',
      },
    ],
    invoiceRequested : false,
    notes            : 'Sin factura individual solicitada',
    idempotencyKey   : randomUUID(),
  });
  const sale     = await app.sales.confirm({
    code           : draft.code,
    revision       : draft.revision,
    idempotencyKey : randomUUID(),
  });
  const receipts = [];
  for (const amount of ['400', '760'])
    receipts.push(
      await app.receipts.create({
        issuerCode     : sender.code,
        customerCode   : 'CUS1',
        currency       : 'MXN',
        exchangeRate   : '1',
        amount,
        date           : sale.date,
        paymentForm    : '03',
        reference      : 'Pago ' + amount,
        allocations    : [
          {
            saleCode    : sale.code,
            amount,
            equivalence : '1',
          },
        ],
        idempotencyKey : randomUUID(),
      }),
    );
  const paid = await app.records.getOne('sale', { code: sale.code });
  await files.generateCommercial(
    {
      ...paid,
      resourceType : 'billing-sale',
    },
    paid,
    'sale',
    randomUUID(),
  );
  for (const receipt of receipts)
    await files.generateCommercial(
      {
        ...receipt,
        resourceType : 'billing-receipt',
      },
      paid,
      'receipt',
      randomUUID(),
    );
  assert.equal(views[0].total, '1160.00');
  assert.equal(views[1].paid, '400');
  assert.equal(views[1].balance, '760.00');
  assert.equal(views[2].balance, '0.00');
  for (const [index, record] of [paid, ...receipts].entries()) {
    const printed = execFileSync('pdftotext', [path.join(output, record.code + '.pdf'), '-'], {
      encoding : 'utf8',
    });
    assert.match(printed, /COMPROBANTE NO FISCAL/i);
    assert.match(printed, /Cliente sin datos fiscales/);
    assert.ok(printed.includes(views[index].balance));
    assert.ok(printed.includes(views[index].total));
    assert.doesNotMatch(printed, /representación impresa de un CFDI|Sello digital|UUID|Código QR/i);
  }
  assert.equal(app.calls.length, 0);
  assert.deepEqual(fs.readdirSync(temp), []);
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(views, null, 2));
  console.log('Tres PDF comerciales verificados en ' + output);
}
main().catch(
  /** @param {Error} error Fallo de aceptación. @returns {void} Termina sin ocultar fallos del renderer. */ (
    error,
  ) => {
    console.error(error);
    process.exitCode = 1;
  },
);
