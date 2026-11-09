/** @file Aceptación de gastos, saldos, catálogos globales e importación con contratos canónicos. */
'use strict';
const assert                         = require('node:assert/strict');
const { randomUUID }                 = require('node:crypto');
const { fixture, memoryStore, line } = require('./fixture.cjs');
const dto                            = require('../server/contracts/registry');
/** @param {Object} options Puertos y workspace de aceptación. @returns {Promise<Object>} Aplicación sin PAC ni credenciales, con referencias controladas. */
async function setup(options = {}) {
  const store = options.store || memoryStore();
  const app   = fixture({
    ...options,
    store,
    references : {
      /** @returns {Promise<Object>} Proveedor sin exigencia de perfil fiscal para captura manual. */
      async supplier() {
        return {
          supplierCode : 'SUP1',
          revision     : 1,
          state        : 'supplier',
          tradeName    : 'Proveedor',
          fiscal       : { taxId: 'AAA010101AAA' },
        };
      },
      /** @returns {Promise<Object>} Proyecto visible. */
      async project() {
        return {
          name     : 'Proyecto',
          revision : 1,
          state    : 'active',
        };
      },
    },
  });
  if (options.workspace) app.actor.workspace = options.workspace;
  for (const resource of ['expense', 'expense-payment'])
    for (const action of ['view', 'create', 'update', 'delete'])
      app.actor.policies.push(`billing.${resource}.${action}.workspace`);
  for (const resource of ['expense-category', 'cost-center'])
    for (const action of ['view', 'create', 'update'])
      app.actor.policies.push(`billing.${resource}.${action}.global`);
  const category = await app.expenses.catalogSave('expense-category', {
    name           : 'Servicios',
    description    : '',
    active         : true,
    idempotencyKey : randomUUID(),
  });
  const center   = await app.expenses.catalogSave('cost-center', {
    name           : 'Operaciones',
    description    : '',
    active         : true,
    idempotencyKey : randomUUID(),
  });
  const issuer   = await app.records.create('issuer', {
    workspace  : app.actor.workspace,
    name       : 'Empresa',
    legalName  : 'Empresa',
    taxId      : 'BBB010101BBB',
    taxRegime  : '601',
    postalCode : '01000',
    series     : {
      I : 'F',
      E : 'NC',
      P : 'P',
    },
    active     : true,
  });
  const input    = {
    issuerCode     : issuer.code,
    supplierCode   : 'SUP1',
    categoryCode   : category.code,
    costCenterCode : center.code,
    projectCode    : '',
    description    : 'Servicio',
    date           : '2026-11-05T10:00:00',
    dueDate        : '2026-11-30',
    currency       : 'MXN',
    exchangeRate   : '1',
    lines          : [
      {
        description : 'Servicio',
        quantity    : '1',
        unitPrice   : '100',
        discount    : '0',
        taxes       : line.taxes,
      },
    ],
    notes          : '',
    idempotencyKey : randomUUID(),
  };
  return {
    ...app,
    input,
    category,
    center,
  };
}
/** @param {Object} app Aplicación. @returns {Promise<Object>} Gasto confirmado y validado contra DTO. */
async function confirmed(app) {
  const input = {
    ...app.input,
    idempotencyKey : randomUUID(),
  };
  dto['billing-expense-create'].input(input);
  const draft = await app.expenses.create(input);
  dto['billing-expense-create'].output({
    statusCode      : 201,
    descriptionCode : 'OK',
    data            : draft,
  });
  const result = await app.expenses.transition('confirm', {
    code           : draft.code,
    revision       : draft.revision,
    idempotencyKey : randomUUID(),
  });
  dto['billing-expense-confirm'].output({
    statusCode      : 200,
    descriptionCode : 'OK',
    data            : result,
  });
  return result;
}
/** @param {Object[]} expenses Gastos compatibles. @param {string[]} amounts Importes por gasto. @returns {Object} Pago distribuido. */
function payment(expenses, amounts) {
  return {
    issuerCode     : expenses[0].issuerCode,
    supplierCode   : expenses[0].supplierCode,
    currency       : expenses[0].currency,
    date           : '2026-11-05T11:00:00',
    paymentForm    : '03',
    reference      : 'Transferencia',
    amount         : String(
      amounts.reduce(
        /** @param {number} total Acumulado sintético entero. @param {string} value Abono entero. @returns {number} Suma de datos de prueba. */
        (total, value) => total + Number(value),
        0,
      ),
    ),
    allocations    : expenses.map(
      /** @param {Object} value Gasto. @param {number} index Posición. @returns {Object} Aplicación de prueba. */
      (value, index) => ({
        expenseCode : value.code,
        amount      : amounts[index],
      }),
    ),
    idempotencyKey : randomUUID(),
  };
}

module.exports = {
  setup,
  confirmed,
  payment,
};
