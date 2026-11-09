/** @file Acredita XML del proveedor y representación imprimible usando el layout real, sin timbrado externo. */
'use strict';
const test = require('node:test'),
  assert   = require('node:assert/strict');
const { fixture, issuer, draft, issue, line } = require('./fixture.cjs');
const { decodeResult }                        = require('../server/adapters/pac/cfdi-result');
const { billingPrintView }                    = require('../server/adapters/documents/billing-print-view');
const { xmlFixture }                          = require('./cfdi-fixture.cjs');
test('un XML alterado no acredita timbrado; el PDF usa únicamente valores del XML verificado', /** @returns {Promise<void>} Acredita totales, sello, emisor, UUID, base64 y metadatos imprimibles. */ async () => {
  const app  = fixture(),
    sender   = await issuer(app),
    document = await issue(app, await draft(app, sender));
  const layout = app.calls[0],
    xml        = xmlFixture(layout, document.uuid);
  const decoded = decodeResult(
    { data: JSON.stringify({ XML: Buffer.from(xml).toString('base64') }) },
    layout,
  );
  assert.equal(decoded.uuid, document.uuid);
  for (const pdf of [undefined, 'JVBERi0=', '%%%INVALID%%%']) {
    const result = decodeResult(
      {
        data : JSON.stringify({
          XML : Buffer.from(xml).toString('base64'),
          pdf,
        }),
      },
      layout,
    );
    assert.equal(result.uuid, document.uuid);
    assert.equal(result.pdf, undefined);
  }
  const view = billingPrintView(document, decoded.xml);
  assert.equal(new URL(view.verificationUrl).searchParams.get('tt'), '116.000000');
  assert.equal(new URL(view.verificationUrl).searchParams.get('fe'), '12345678');
  assert.equal(view.title, 'CFDI DE PRUEBAS');
  assert.ok(JSON.stringify(view).includes('||1.1|' + document.uuid));
  for (const modified of [
    xml.replace('Total="116.00"', 'Total="117.00"'),
    xml.replace('Nombre="EMISOR"', 'Nombre="AJENO"'),
    xml.replace('SelloCFD="SELLO-SINTETICO-12345678"', 'SelloCFD="OTRO"'),
  ])
    assert.throws(
      /** @returns {Object} Un cambio en la evidencia no confirma el efecto fiscal. */ () =>
        decodeResult({ data: modified }, layout),
      /BILLING_PAC_DOCUMENT_MISMATCH/,
    );
});
test('la vista impresa identifica conceptos y conserva cada impuesto sin sumarlo ni redondearlo', /** @returns {Promise<void>} Correlaciona dos partidas con traslado y exención usando el XML acreditado. */ async () => {
  const app = fixture(),
    sender  = await issuer(app);
  const issued   = await issue(
    app,
    await draft(app, sender, {
      lines : [
        line,
        {
          ...line,
          description : 'Servicio exento',
          unitPrice   : '12.345678',
          taxes       : [
            {
              kind   : 'transferred',
              code   : '002',
              factor : 'Exento',
              rate   : '',
            },
          ],
        },
      ],
    }),
  );
  const document = await app.store.get('document', { code: issued.code });
  const xml      = xmlFixture(document.expectedLayout, document.uuid);
  const decoded  = decodeResult({ data: xml }, document.expectedLayout, document.uuid);
  const view     = billingPrintView(document, decoded.xml);
  const concepts = view.tables.find(
    /** @param {Object} table Tabla imprimible. @returns {boolean} Identifica los conceptos fiscales. */
    (table) => table.title === 'Conceptos',
  );
  assert.deepEqual(
    concepts.rows.map(
      /** @param {string[]} row Concepto. @returns {string} Número estable de partida. */
      (row) => row[0],
    ),
    ['1', '2'],
  );
  const taxes = view.tables.filter(
    /** @param {Object} table Tabla imprimible. @returns {boolean} Selecciona únicamente el desglose por partida. */
    (table) => table.title.startsWith('Impuestos por partida'),
  );
  assert.equal(taxes.length, 1);
  assert.deepEqual(taxes[0].rows, [
    ['1', 'Traslado', '002', '100.000000', 'Tasa', '0.160000', '16.000000'],
    ['2', 'Traslado', '002', '12.345678', 'Exento', '', ''],
  ]);
  assert.equal(concepts.rows[1][5], '12.345678');
});

test('más de 500 impuestos continúan en bloques compatibles con el contrato de Documents', /** @returns {Promise<void>} Conserva 600 impuestos de 300 partidas y todos sus números de origen sin ampliar el DTO. */ async () => {
  const app      = fixture({
    references : {
      /** @param {Object} query Catálogo. @returns {Promise<Object>} Moneda y tasas sintéticas para los conceptos de este límite. */
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
  const sender   = await issuer(app);
  const issued   = await issue(
    app,
    await draft(app, sender, {
      lines : Array.from(
        { length: 300 },
        /** @returns {Object} Partida con traslado y retención fiscal independientes. */
        () => ({
          ...line,
          taxes : [
            ...line.taxes,
            {
              kind   : 'withheld',
              code   : '001',
              factor : 'Tasa',
              rate   : '0.10',
            },
          ],
        }),
      ),
    }),
  );
  const document = await app.store.get('document', { code: issued.code });
  const decoded  = decodeResult(
    { data: xmlFixture(document.expectedLayout, document.uuid) },
    document.expectedLayout,
    document.uuid,
  );
  const view     = billingPrintView(document, decoded.xml);
  const tables   = view.tables.filter(
    /** @param {Object} table Tabla imprimible. @returns {boolean} Continúa el desglose de impuestos por concepto. */
    (table) => table.title === 'Impuestos por partida',
  );
  assert.deepEqual(
    tables.map(
      /** @param {Object} table Bloque fiscal. @returns {number} Filas admitidas por la interfaz existente. */
      (table) => table.rows.length,
    ),
    [500, 100],
  );
  assert.equal(tables[0].rows[499][0], '250');
  assert.equal(tables[1].rows[0][0], '251');
  assert.equal(tables[1].rows[99][0], '300');
});
