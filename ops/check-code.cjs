/** @file Verificación reproducible de sintaxis, JSDoc, formato e integridad de bibliotecas del servicio. */
'use strict';

const fs                          = require('node:fs');
const path                        = require('node:path');
const { createHash }              = require('node:crypto');
const acorn                       = require('acorn');
const { formatSource, codeFiles } = require('./format-code.cjs');
const { checkConventions }        = require('./code-conventions.cjs');

/**
 * Enumera los archivos JavaScript propios sin recorrer dependencias ni metadatos de Git.
 * @param {string} directory Directorio del servicio o uno de sus componentes.
 * @returns {string[]} Archivos JavaScript y CommonJS presentes en el directorio.
 */
function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(
    /**
     * Proyecta y reúne los elementos en una sola colección.
     * @param {*} entry Valor de entry utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(filename);
      return /\.(?:js|cjs)$/.test(entry.name) ? [filename] : [];
    },
  );
}

/**
 * Recorre nodos del árbol de sintaxis y conserva su padre para documentar métodos y propiedades.
 * @param {Object} node Nodo de sintaxis que se visita.
 * @param {Function} visitor Operación aplicada a cada nodo.
 * @param {Object|null} [parent=null] Nodo padre de la visita.
 * @returns {void} Finaliza después de visitar todos los descendientes.
 */
function visit(node, visitor, parent = null, grandparent = null) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node, parent, grandparent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach(
        /**
         * Aplica la operación indicada a cada elemento de la colección.
         * @param {*} child Valor de child utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (child) => visit(child, visitor, node, parent),
      );
    else if (value && typeof value === 'object') visit(value, visitor, node, parent);
  }
}

/**
 * Reúne incumplimientos de documentación y formato; el parser comprueba también la sintaxis.
 * @param {string} filename Archivo JavaScript que se valida.
 * @returns {Promise<{functions: number, errors: string[]}>} Funciones revisadas e incumplimientos.
 */
async function checkFile(filename) {
  const source   = fs.readFileSync(filename, 'utf8');
  const comments = [];
  const ast      = acorn.parse(source, {
    ecmaVersion : 'latest',
    sourceType  : 'commonjs',
    locations   : true,
    onComment   : comments,
  });
  const errors   = checkConventions(ast, filename);
  let functions  = 0;
  if (
    !comments.some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {*} comment Valor de comment utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (comment) =>
        comment.type === 'Block' && comment.value.startsWith('*') && /@file\b/.test(comment.value),
    )
  )
    errors.push(`${filename}: falta JSDoc @file.`);
  visit(
    ast,

    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @param {*} parent Valor de parent utilizado por esta operación.
     * @param {*} grandparent Valor de grandparent utilizado por esta operación.
     * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (node, parent, grandparent) => {
      if (
        !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
          node.type,
        )
      )
        return;
      functions++;
      let start =
        parent && ['MethodDefinition', 'Property'].includes(parent.type) && parent.value === node
          ? parent.start
          : node.start;
      if (parent?.type === 'AssignmentPattern' && parent.right === node) start = parent.start;
      if (parent?.type === 'ReturnStatement' || parent?.type === 'ThrowStatement')
        start = parent.start;
      if (
        parent?.type === 'VariableDeclarator' &&
        parent.init === node &&
        grandparent?.declarations.length === 1
      )
        start = grandparent.start;
      if (
        parent?.type === 'AssignmentExpression' &&
        parent.right === node &&
        grandparent?.type === 'ExpressionStatement'
      )
        start = grandparent.start;
      const comment = comments.findLast(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {*} item Valor de item utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (item) =>
          item.end <= start &&
          item.type === 'Block' &&
          item.value.startsWith('*') &&
          /^[\s,]*$/.test(source.slice(item.end, start)),
      );
      if (!comment) errors.push(`${filename}:${node.loc.start.line}: función sin JSDoc.`);
      else {
        if (node.params.length && !/@param\b/.test(comment.value))
          errors.push(`${filename}:${node.loc.start.line}: faltan parámetros JSDoc.`);
        if (parent?.kind !== 'constructor' && !/@returns?\b/.test(comment.value))
          errors.push(`${filename}:${node.loc.start.line}: falta retorno JSDoc.`);
      }
    },
  );
  if ((await formatSource(source, filename)) !== source)
    errors.push(`${filename}: indentación o alineación distinta del estándar.`);
  return {
    functions,
    errors,
  };
}

/**
 * Comprueba que los manifiestos de las bibliotecas portables correspondan a sus archivos locales.
 * @param {string} root Directorio raíz del servicio.
 * @returns {string[]} Rutas cuya suma no corresponde al manifiesto de la biblioteca.
 */
function checkManifests(root) {
  const errors = [];
  for (const library of ['messaging', 'telemetry']) {
    const directory = path.join(root, 'server/library', library);
    const manifest  = JSON.parse(
      fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8'),
    );
    for (const [filename, expected] of Object.entries(manifest.files || manifest.sha256)) {
      const actual = createHash('sha256')
        .update(fs.readFileSync(path.join(directory, filename)))
        .digest('hex');
      if (actual !== expected)
        errors.push(`${library}/${filename}: integridad distinta del manifiesto.`);
    }
  }
  return errors;
}

/**
 * Ejecuta todas las comprobaciones y devuelve un código distinto de cero si existe algún fallo.
 * @returns {Promise<void>} Finaliza tras publicar el resultado verificable en la salida del proceso.
 */
async function main() {
  const root  = path.resolve(__dirname, '..');
  const files = ['server', 'test', 'ops'].flatMap(
    /**
     * Proyecta y reúne los elementos en una sola colección.
     * @param {string} directory Valor de directory utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (directory) => sourceFiles(path.join(root, directory)),
  );
  files.push(
    ...fs
      .readdirSync(root)
      .filter(
        /**
         * Determina si el elemento cumple el criterio de selección.
         * @param {string} name Nombre del componente o recurso.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (name) => /\.cjs$/.test(name),
      )
      .map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {string} name Nombre del componente o recurso.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (name) => path.join(root, name),
      ),
  );
  const results    = await Promise.all(files.map(checkFile));
  const jsonErrors = [];
  for (const filename of codeFiles(root).filter(
    /**
     * Aplica la operación local y devuelve su resultado al flujo que la invoca.
     * @param {*} file Valor utilizado por la operación.
     * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
     */
    (file) => file.endsWith('.json'),
  )) {
    const source = fs.readFileSync(filename, 'utf8');
    if ((await formatSource(source, filename)) !== source)
      jsonErrors.push(`${filename}: estructura o alineación JSON distinta del estándar.`);
  }
  const errors = results
    .flatMap(
      /**
       * Proyecta y reúne los elementos en una sola colección.
       * @param {*} result Valor de result utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (result) => result.errors,
    )
    .concat(jsonErrors, checkManifests(root));
  if (errors.length) {
    process.stderr.write(errors.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  console.log(
    `${files.length} archivos y ${results.reduce(
      /**
       * Acumula el resultado de los elementos recorridos.
       * @param {*} total Valor de total utilizado por esta operación.
       * @param {*} result Valor de result utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (total, result) => total + result.functions,
      0,
    )} funciones: JSDoc, sintaxis, formato e integridad correctos.`,
  );
}

main().catch(
  /**
   * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
   * @param {Error} error Fallo recibido por la continuación.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
