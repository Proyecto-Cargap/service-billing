/** @file Genera muestras fiscales sintéticas con Billing y el renderer real de Documents, sin PAC ni almacenamiento remoto. */
'use strict';
const fs = require('node:fs'),
  path   = require('node:path'),
  assert = require('node:assert/strict');
const { createRequire }                       = require('node:module');
const { fixture, issuer, draft, issue, line } = require('../test/fixture.cjs');
const { xmlFixture }                          = require('../test/cfdi-fixture.cjs');
const { billingPrintView }                    = require('../server/adapters/documents/billing-print-view');
const { verifyCfdi }                          = require('../server/adapters/pac/cfdi-result');
/** @returns {Promise<void>} Seis muestras con marca y fuente sin red, XML acreditado y temporales limpios. */
async function main() {
  const documentsRoot = path.resolve(__dirname, '../../service-documents');
  const fromDocuments = createRequire(path.join(documentsRoot, 'package.json'));
  const output        = path.resolve(__dirname, '../tmp/pdf-acceptance');
  const temp          = path.join(output, 'temporary');
  fs.mkdirSync(temp, { recursive: true });
  const assetRoot  = path.resolve(__dirname, '../../../../infrastructure/billing');
  const config     = {
    ...JSON.parse(fs.readFileSync(path.join(assetRoot, 'pdf-config.example.json'))),
    assetRoot,
  };
  const configFile = path.join(output, 'pdf-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env             = {
    TEMP            : temp,
    PDF_CONFIG_FILE : configFile,
  };
  const temporaryFiles  = fromDocuments(
    './server/adapters/filesystem/temporary-files',
  ).createTemporaryFiles({
    root      : temp,
    readRoots : [assetRoot],
  });
  const logger          = {
    /** @param {Object} data Error saneado. @returns {void} Publica únicamente el código técnico del renderer local. */
    error(data) {
      console.error(data.code);
    },
  };
  const browserEngine   = fromDocuments('puppeteer');
  const networkRequests = [];
  const renderEvidence  = [];
  const service         = fromDocuments('./server/modules/pdf/services/pdf.service')({
    env,
    temporaryFiles,
    logger,
    handlebars  : fromDocuments('handlebars'),
    qrProcessor : fromDocuments('./server/adapters/media/qr-processor').qrProcessor(
      fromDocuments('@loskir/styled-qr-code-node'),
    ),
    pdfRegistry : {
      /** @returns {Object} Configuración local validada con el registro productivo. */
      load  : () => fromDocuments('./server/adapters/rendering/pdf-registry').loadRegistry(env),
      asset : fromDocuments('./server/adapters/rendering/pdf-registry').approvedAsset,
    },
    /** @param {Object} options Códigos del renderer. @returns {Object} Chromium real y temporales confinados. */
    createRenderer(options) {
      return fromDocuments('./server/adapters/rendering/pdf-renderer').createPdfRenderer({
        ...options,
        puppeteer : {
          /** @param {Object} launchOptions Opciones productivas. @returns {Promise<Object>} Chromium real, con páginas sin red y evidencia de recursos incrustados. */
          async launch(launchOptions) {
            const browser = await browserEngine.launch(launchOptions);
            return {
              /** @returns {Promise<Object>} Página real con inspección previa al PDF. */
              async newPage() {
                const page = await browser.newPage();
                await page.setOfflineMode(true);
                await page.setRequestInterception(true);
                page.on(
                  'request',
                  /** @param {Object} request Solicitud de Chromium. @returns {Promise<void>} Permite únicamente datos incrustados. */
                  async (request) => {
                    if (/^(data:|about:)/.test(request.url())) await request.continue();
                    else {
                      networkRequests.push(request.url());
                      await request.abort();
                    }
                  },
                );
                const createPdf = page.pdf.bind(page);
                /** @param {Object} pdfOptions Opciones productivas. @returns {Promise<Uint8Array>} PDF real tras acreditar logo, Inter y contenido sin desbordamiento horizontal. */
                page.pdf = async (pdfOptions) => {
                  const evidence = await page.evaluate(
                    /** @returns {Promise<Object>} Recursos y medidas de la página imprimible. */
                    async () => {
                      await document.fonts.ready;
                      const logo = document.querySelector('.brand-logo');
                      return {
                        fontLoaded : document.fonts.check('11px Inter'),
                        logoLoaded : logo.complete && logo.naturalWidth > 0,
                        fontFamily : getComputedStyle(document.body).fontFamily,
                        cardRadius : getComputedStyle(document.querySelector('.card')).borderRadius,
                        overflow   : document.body.scrollWidth > document.body.clientWidth,
                      };
                    },
                  );
                  assert.equal(evidence.fontLoaded, true);
                  assert.equal(evidence.logoLoaded, true);
                  assert.equal(evidence.cardRadius, '12px');
                  assert.equal(evidence.overflow, false);
                  renderEvidence.push(evidence);
                  return createPdf(pdfOptions);
                };
                return page;
              },
              /** @returns {Promise<void>} Cierra Chromium incluso ante un fallo del renderer. */
              close : () => browser.close(),
            };
          },
        },
        temporaryFiles,
        logger,
      });
    },
  });
  const app = fixture(),
    sender  = await issuer(app),
    invoice = await issue(app, await draft(app, sender));
  const credit         = await issue(
    app,
    await draft(app, sender, {
      type                : 'E',
      relatedDocumentCode : invoice.code,
      relationship        : '01',
      paymentMethod       : 'PUE',
      paymentForm         : '03',
      lines               : [
        {
          ...line,
          unitPrice : '10',
        },
      ],
    }),
  );
  const receipt        = await app.receipts.create({
    issuerCode     : sender.code,
    customerCode   : invoice.customerCode,
    currency       : 'MXN',
    exchangeRate   : '1',
    amount         : '58',
    date           : '2026-10-22T07:00:00',
    paymentForm    : '03',
    reference      : 'Muestra',
    allocations    : [
      {
        documentCode : invoice.code,
        amount       : '58',
        equivalence  : '1',
      },
    ],
    idempotencyKey : 'pdf-payment',
  });
  const payment        = await issue(
    app,
    await app.receipts.createRep({
      code     : receipt.code,
      revision : receipt.revision,
      date     : '2026-10-22T08:00:00',
    }),
  );
  const multiple       = await issue(
    app,
    await draft(app, sender, {
      lines : Array.from(
        { length: 80 },
        /** @param {*} unused Valor vacío. @param {number} index Partida. @returns {Object} Concepto fiscal con texto para revisar saltos de página. */
        (unused, index) => ({
          ...line,
          description : `Servicio ${index + 1}: mantenimiento y revisión de instalaciones, equipos y accesorios.`,
        }),
      ),
    }),
  );
  const detailedApp    = fixture({
    references : {
      /** @param {Object} query Catálogo solicitado. @returns {Promise<Object>} Tasas sintéticas explícitas para traslado y retención de aceptación. */
      async catalog(query) {
        return {
          items      :
            query.kind === 'currency'
              ? [
                  {
                    code     : query.code,
                    decimals : 2,
                  },
                ]
              : [
                  {
                    tax         : '002',
                    factor      : 'Tasa',
                    kind        : 'fixed',
                    max         : '0.16',
                    transferred : true,
                  },
                  {
                    tax      : '001',
                    factor   : 'Tasa',
                    kind     : 'fixed',
                    max      : '0.10',
                    withheld : true,
                  },
                ],
          pagination : { total: 2 },
        };
      },
    },
  });
  const originalSender = await issuer(detailedApp);
  const detailedSender = await detailedApp.records.update('issuer', {
    ...originalSender,
    legalName : 'EMISORA DEMOSTRATIVA DE SOLUCIONES TECNOLÓGICAS E INGENIERÍA APLICADA DEL CENTRO',
  });
  detailedApp.customer.fiscal.legalName =
    'CLIENTE DEMOSTRATIVO DE ADMINISTRACIÓN DE PROYECTOS E INFRAESTRUCTURA INDUSTRIAL';
  const detailed         = await issue(
    detailedApp,
    await draft(detailedApp, detailedSender, {
      lines : [
        {
          ...line,
          description :
            'Servicio integral de diagnóstico, mantenimiento preventivo y documentación técnica de infraestructura. Incluye revisión de conectividad, validación de componentes, pruebas funcionales y entrega del informe de resultados con recomendaciones para la continuidad operativa.',
          quantity    : '3',
          unitPrice   : '12345.6789',
          discount    : '1000',
          taxes       : [
            ...line.taxes,
            {
              kind   : 'withheld',
              code   : '001',
              factor : 'Tasa',
              rate   : '0.10',
            },
          ],
        },
      ],
    }),
  );
  const secondInvoice    = await issue(app, await draft(app, sender));
  const allocatedReceipt = await app.receipts.create({
    issuerCode     : sender.code,
    customerCode   : invoice.customerCode,
    currency       : 'MXN',
    exchangeRate   : '1',
    amount         : '80',
    date           : '2026-10-22T09:00:00',
    paymentForm    : '03',
    reference      : 'Pago de dos documentos',
    allocations    : [
      {
        documentCode : invoice.code,
        amount       : '20',
        equivalence  : '1',
      },
      {
        documentCode : secondInvoice.code,
        amount       : '60',
        equivalence  : '1',
      },
    ],
    idempotencyKey : 'pdf-multiple-payment',
  });
  const multiplePayment  = await issue(
    app,
    await app.receipts.createRep({
      code     : allocatedReceipt.code,
      revision : allocatedReceipt.revision,
      date     : '2026-10-22T10:00:00',
    }),
  );
  const expected         = [];
  for (const [name, document, source] of [
    ['ingreso', invoice, app],
    ['egreso', credit, app],
    ['pago', payment, app],
    ['multipagina', multiple, app],
    ['detalle-fiscal', detailed, detailedApp],
    ['pagos-multiples', multiplePayment, app],
  ]) {
    const stored = await source.store.get('document', { code: document.code });
    const xml    = xmlFixture(stored.expectedLayout, stored.uuid)
      .replaceAll('SELLO-SINTETICO-12345678', 'A'.repeat(336) + '12345678')
      .replaceAll('SELLO-SAT-SINTETICO', 'B'.repeat(344));
    verifyCfdi(xml, stored.expectedLayout, stored.uuid);
    const view = billingPrintView(stored, xml);
    expected.push({
      name,
      view,
    });
    const generated   = await new service().billingCreate({ document: view });
    const destination = path.join(output, name + '.pdf');
    fs.copyFileSync(generated.tempFilePath, destination);
    await temporaryFiles.remove(generated.tempFilePath);
    assert.ok(fs.readFileSync(destination).subarray(0, 5).equals(Buffer.from('%PDF-')));
    console.log(destination);
  }
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.deepEqual(networkRequests, []);
  fs.writeFileSync(path.join(output, 'expected.json'), JSON.stringify(expected, null, 2));
  fs.writeFileSync(
    path.join(output, 'render-evidence.json'),
    JSON.stringify(renderEvidence, null, 2),
  );
}
if (require.main === module)
  void main().catch(
    /** @param {Error} error Fallo de aceptación local. @returns {void} Reporta el fallo sin datos reales. */
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
