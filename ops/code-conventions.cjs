/** @file Reglas de nomenclatura y agrupación por dominio y responsabilidad técnica. */
'use strict';
const path = require('node:path');

/**
 * Visita los nodos del árbol para comprobar declaraciones y usos de constructores.
 * @param {Object} node Nodo de sintaxis que se recorre.
 * @param {Function} visitor Operación aplicada a cada nodo.
 * @returns {void} Finaliza después de recorrer el árbol.
 */
function visit(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach(
        /**
         * Aplica la operación indicada a cada elemento de la colección.
         * @param {*} child Valor de child utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (child) => visit(child, visitor),
      );
    else if (value && typeof value === 'object') visit(value, visitor);
  }
}

/**
 * Reconoce constructores importados sin renombrar los símbolos públicos de bibliotecas externas.
 * @param {Object} node Inicializador de una declaración de variable.
 * @returns {boolean} Indica si la declaración procede de un módulo requerido.
 */
function imported(node) {
  if (!node) return false;
  if (node.type === 'CallExpression')
    return node.callee.name === 'require' || imported(node.callee);
  return node.type === 'MemberExpression' && imported(node.object);
}

/**
 * Comprueba archivos kebab-case, funciones y variables camelCase, clases PascalCase y constantes
 * UPPER_SNAKE_CASE. Los constructores y claves de protocolos externos conservan su nombre público.
 * El runtime portable conserva el prefijo privado _ seguido de camelCase.
 * @param {Object} ast Árbol de sintaxis válido con posiciones de línea.
 * @param {string} filename Ruta del archivo propio del servicio.
 * @returns {string[]} Incumplimientos de nombres y ubicación de las declaraciones.
 */
function checkConventions(ast, filename) {
  const errors       = [];
  const camel        = /^[a-z][a-zA-Z0-9]*$/;
  const pascal       = /^[A-Z][a-zA-Z0-9]*$/;
  const constant     = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
  const constructors = new Set();
  visit(
    ast,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    (node) => {
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier')
        constructors.add(node.callee.name);
      if (
        node.type === 'BinaryExpression' &&
        node.operator === 'instanceof' &&
        node.right.type === 'Identifier'
      )
        constructors.add(node.right.name);
    },
  );
  const root  = path.resolve(__dirname, '..');
  const parts = path.relative(root, filename).split(path.sep);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.(?:js|cjs)$/.test(path.basename(filename)))
    errors.push(`${filename}: el archivo debe usar kebab-case y sufijo de responsabilidad.`);
  if (
    parts.slice(0, -1).some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {*} part Valor de part utilizado por esta operación.
       * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (part) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part),
    )
  )
    errors.push(`${filename}: los directorios deben usar kebab-case.`);
  if (
    parts[0] === 'server' &&
    parts[1] === 'modules' &&
    parts.length === 3 &&
    parts[2] !== 'catalog.js'
  )
    errors.push(`${filename}: la implementación debe agruparse dentro de su dominio.`);
  if (parts[0] === 'server' && parts[1] === 'adapters' && parts.length < 4)
    errors.push(`${filename}: el adaptador debe agruparse por tecnología o protocolo.`);

  const roles = [
    ['read-model', 'read-models'],
    ['controller', 'controllers'],
    ['service', 'services'],
    ['repository', 'repositories'],
    ['model', 'models'],
    ['policy', 'policies'],
    ['contract', 'contracts'],
    ['dto', 'dtos'],
    ['presenter', 'presenters'],
    ['projection', 'presenters'],
    ['handler', 'handlers'],
    ['composition', 'compositions'],
    ['worker', 'workers'],
  ];
  if (parts[0] === 'server' && parts[1] === 'modules' && parts.length > 3) {
    const expected = roles.find(
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {Array<*>} options1 Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      ([suffix]) => parts.at(-1).endsWith('.' + suffix + '.js'),
    )?.[1];
    if (parts.length < 5 || (expected && parts[3] !== expected))
      errors.push(`${filename}: el contenido del dominio debe agruparse en carpetas por tipo.`);
  }

  /**
   * Comprueba cada identificador declarado, incluidos los patrones desestructurados.
   * @param {Object} pattern Declaración o patrón de parámetros.
   * @param {string} kind Clase de declaración: función, clase, parámetro o variable.
   * @param {boolean} [external=false] Permite conservar nombres de tipos importados.
   * @returns {void} Agrega los incumplimientos a la colección del archivo.
   */
  function binding(pattern, kind, external = false) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      const allowed =
        kind === 'clase'
          ? pascal.test(pattern.name)
          : camel.test(pattern.name) ||
            (kind !== 'función' &&
              (constant.test(pattern.name) ||
                ((external || constructors.has(pattern.name)) && pascal.test(pattern.name)))) ||
            pattern.name === '_';
      if (!allowed)
        errors.push(
          `${filename}:${pattern.loc.start.line}: nombre de ${kind} fuera del estándar: ${pattern.name}.`,
        );
    } else if (pattern.type === 'ObjectPattern')
      pattern.properties.forEach(
        /**
         * Aplica la operación indicada a cada elemento de la colección.
         * @param {*} property Valor de property utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (property) => binding(property.value || property.argument, kind, external),
      );
    else if (pattern.type === 'ArrayPattern')
      pattern.elements.forEach(
        /**
         * Aplica la operación indicada a cada elemento de la colección.
         * @param {*} element Valor de element utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (element) => binding(element, kind, external),
      );
    else if (pattern.type === 'AssignmentPattern') binding(pattern.left, kind, external);
    else if (pattern.type === 'RestElement') binding(pattern.argument, kind, external);
  }
  visit(
    ast,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    (node) => {
      if (node.type === 'VariableDeclarator') binding(node.id, 'variable', imported(node.init));
      if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) binding(node.id, 'clase');
      if (
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
      ) {
        if (node.id) binding(node.id, 'función');
        node.params.forEach(
          /**
           * Aplica la operación indicada a cada elemento de la colección.
           * @param {*} parameter Valor de parameter utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (parameter) => binding(parameter, 'parámetro'),
        );
      }
      const callable              =
        node.type === 'MethodDefinition' ||
        (node.type === 'Property' &&
          (node.method ||
            ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value?.type)));
      const portable              = parts[0] === 'server' && parts[1] === 'library';
      const externalProtocolKey   = portable && node.type === 'Property' && !node.method;
      const privatePortableMethod = portable && /^_[a-z][a-zA-Z0-9]*$/.test(node.key?.name || '');
      if (
        callable &&
        !node.computed &&
        ['Identifier', 'PrivateIdentifier'].includes(node.key?.type) &&
        node.key.name !== 'constructor' &&
        !externalProtocolKey &&
        !privatePortableMethod &&
        !camel.test(node.key.name)
      )
        errors.push(
          `${filename}:${node.loc.start.line}: nombre de método fuera del estándar: ${node.key.name}.`,
        );
      if (node.type === 'CatchClause') binding(node.param, 'parámetro');
    },
  );
  return errors;
}
module.exports = { checkConventions };
