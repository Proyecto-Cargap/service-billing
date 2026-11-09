/** @file Referencias de Product nuevas e históricas sin alterar importes ni invocar PAC. */
'use strict';
const test             = require('node:test');
const assert           = require('node:assert/strict');
const { productLines } = require('../server/modules/billing/services/product-lines.service');
test('referencias nuevas se acreditan; históricos no dependen del estado actual de Product' /** @returns {Promise<void>} Conserva referencias previas y detecta revisión cambiada. */, async () => {
  const reference = {
    itemCode      : 'PRO-test',
    skuCode       : 'VAR-test',
    priceListCode : 'LPR-test',
    itemRevision  : 1,
    skuRevision   : 1,
    priceCode     : 'PRE-test',
    priceRevision : 1,
  };
  let calls       = 0;
  const validate  = productLines({
    /** @param {Object} input Resolución solicitada. @returns {Promise<Object>} Precio actual independiente de la edición manual. */
    async product(input) {
      calls++;
      assert.equal(input.currency, 'MXN');
      return {
        catalogReference : { ...reference },
        unitPrice        : '100',
      };
    },
  });
  const input     = {
    currency : 'MXN',
    lines    : [
      {
        description      : 'Precio negociado',
        quantity         : '2',
        unitPrice        : '80',
        catalogReference : reference,
      },
    ],
  };
  await validate(input, null);
  assert.equal(calls, 1);
  assert.equal(input.lines[0].unitPrice, '80');
  await validate(input, structuredClone(input));
  assert.equal(calls, 1);
  await assert.rejects(
    validate(
      {
        ...input,
        lines : [
          {
            ...input.lines[0],
            catalogReference : {
              ...reference,
              priceRevision : 2,
            },
          },
        ],
      },
      null,
    ),
    { descriptionCode: 'BILLING_PRODUCT_CHANGED' },
  );
  await validate(
    {
      currency : 'MXN',
      lines    : [{ description: 'Captura manual' }],
    },
    null,
  );
});
