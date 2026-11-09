/** @file Proyecciones públicas por lista explícita; excluyen credenciales, cargas PAC e intentos internos. */
'use strict';
const schemas = require('../contracts/public.schema.json');
/** @param {string} resource Recurso canónico. @param {Object} value Registro privado. @returns {Object} Datos públicos separados del objeto persistido. */
function present(resource, value) {
  return project(schemas[resource], value);
}
/** @param {Object} schema Esquema público cerrado. @param {*} value Valor privado. @returns {*} Proyección recursiva sin propiedades técnicas anidadas. */
function project(schema, value) {
  if (schema.type === 'array')
    return value.map(
      /** @param {*} item Elemento privado. @returns {*} Elemento público. */
      (item) => project(schema.items, item),
    );
  if (schema.type !== 'object') return structuredClone(value);
  const result = {};
  for (const [key, child] of Object.entries(schema.properties))
    if (value[key] !== undefined) result[key] = project(child, value[key]);
  return result;
}
/** @param {string} resource Recurso editable. @param {Object} value Entrada validada. @returns {Object} Sólo campos editables del contrato de dominio. */
function editable(resource, value) {
  const schemas = {
      issuer   : require('../contracts/issuer.schema.json'),
      sale     : require('../contracts/sale.schema.json'),
      expense  : require('../contracts/expense.schema.json'),
      document : require('../contracts/document.schema.json'),
    },
    output      = {};
  for (const key of Object.keys(schemas[resource].properties))
    if (value[key] !== undefined)
      output[key] =
        resource === 'expense'
          ? project(schemas[resource].properties[key], value[key])
          : structuredClone(value[key]);
  return output;
}
module.exports = {
  present,
  editable,
};
