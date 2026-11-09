/** @file Detecta módulos propios sin entrada operativa y referencias locales inválidas sin ejecutar el servicio. */
'use strict';
const fs    = require('node:fs');
const path  = require('node:path');
const acorn = require('acorn');

/** Recorre sintaxis CommonJS sin cargar código inspeccionado.
 * @param {Object} node Nodo actual del programa.
 * @param {Function} inspect Operación aplicada a cada nodo.
 * @returns {void} Finaliza después de visitar los descendientes.
 */
function visit(node, inspect) {
  if (!node?.type) return;
  inspect(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inspect);
    } else if (value && typeof value === 'object') visit(value, inspect);
  }
}

/** Enumera módulos, incluyendo bibliotecas para seguir sus referencias sin exigirles uso individual.
 * @param {string} directory Directorio de fuentes de ejecución.
 * @returns {string[]} Archivos JavaScript o CommonJS ordenados.
 */
function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(filename));
    else if (/\.(?:js|cjs)$/.test(entry.name)) result.push(filename);
  }
  return result.sort();
}

/** Resuelve referencias locales de CommonJS sin importar implementaciones.
 * @param {string} base Ruta absoluta del destino declarado.
 * @returns {string|null} Archivo existente o ausencia de referencia válida.
 */
function resolveFile(base) {
  for (const filename of [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
  ]) {
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) return filename;
  }
  return null;
}

/** Reconoce rutas de trabajadores declaradas como literales o mediante path.join/resolve con __dirname.
 * @param {Object} node Expresión de ruta del trabajador.
 * @param {string} filename Módulo que declara el trabajador.
 * @returns {string|null} Ruta estática absoluta o expresión que requiere corregir su declaración.
 */
function workerPath(node, filename) {
  if (typeof node?.value === 'string') return path.resolve(path.dirname(filename), node.value);
  if (
    node?.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    !['join', 'resolve'].includes(node.callee.property.name) ||
    node.arguments[0]?.name !== '__dirname' ||
    !node.arguments.slice(1).every(
      /** @param {Object} argument Segmento estático de la ruta.
       * @returns {boolean} No acepta expresiones calculadas durante ejecución.
       */
      (argument) => typeof argument.value === 'string',
    )
  )
    return null;
  return path.resolve(
    path.dirname(filename),
    ...node.arguments.slice(1).map(
      /** @param {Object} argument Segmento literal acreditado.
       * @returns {string} Segmento que compone la ruta del trabajador.
       */
      (argument) => argument.value,
    ),
  );
}

/** Analiza entradas, importaciones y trabajadores; las referencias desde pruebas no acreditan uso productivo.
 * @param {string} root Raíz del servicio que contiene package.json y server.
 * @returns {Object} Módulos alcanzables y hallazgos; los ciclos de dependencias los comprueba arquitectura.
 */
function analyzeUnused(root) {
  root = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry    = resolveFile(path.resolve(root, manifest.main || 'server/server.js'));
  const files    = sourceFiles(path.join(root, 'server'));
  const graph    = new Map();
  const findings = [];
  /** Registra una referencia no verificable sin ocultarla en una lista de excepciones.
   * @param {string} filename Módulo propio que requiere atención.
   * @param {number} line Línea que declara la referencia.
   * @param {string} rule Condición incumplida por las fuentes.
   * @param {string} detail Descripción del destino o expresión problemática.
   * @returns {void} Agrega un hallazgo reproducible al informe.
   */
  function report(filename, line, rule, detail) {
    findings.push({
      file      : path.relative(root, filename),
      line,
      principle : 'S',
      rule,
      detail,
    });
  }
  if (!entry)
    report(
      path.join(root, 'package.json'),
      1,
      'missing-runtime-entry',
      manifest.main || 'server/server.js',
    );
  for (const filename of files) {
    const portable     = path.relative(root, filename).split(path.sep).includes('library');
    const dependencies = [];
    const ast          = acorn.parse(fs.readFileSync(filename, 'utf8'), {
      ecmaVersion : 'latest',
      locations   : true,
    });
    visit(
      ast,
      /** Inspecciona require y Worker, incluidos los declarados dentro de fábricas o callbacks.
       * @param {Object} node Nodo de sintaxis que puede introducir un punto de carga.
       * @returns {void} Registra dependencias sin invocar el código inspeccionado.
       */
      (node) => {
        let request;
        if (
          node.type === 'CallExpression' &&
          (node.callee.name === 'require' ||
            (node.callee.object?.name === 'require' && node.callee.property?.name === 'resolve'))
        ) {
          const value = node.arguments[0]?.value;
          if (typeof value !== 'string') {
            if (!portable)
              report(
                filename,
                node.loc.start.line,
                'unresolved-runtime-import',
                'require debe declarar un módulo estático',
              );
            return;
          }
          if (!value.startsWith('.')) return;
          request = path.resolve(path.dirname(filename), value);
        } else if (
          node.type === 'NewExpression' &&
          (node.callee.name === 'Worker' || node.callee.property?.name === 'Worker')
        ) {
          request = workerPath(node.arguments[0], filename);
          if (!request) {
            if (!portable)
              report(
                filename,
                node.loc.start.line,
                'unresolved-worker-entry',
                'Worker debe declarar su archivo de entrada',
              );
            return;
          }
        } else return;
        const target = resolveFile(request);
        if (target) dependencies.push(target);
        else if (!portable)
          report(
            filename,
            node.loc.start.line,
            'missing-runtime-import',
            path.relative(root, request),
          );
      },
    );
    graph.set(filename, dependencies);
  }
  const reached = new Set();
  const pending = entry ? [entry] : [];
  while (pending.length) {
    const filename = pending.pop();
    if (reached.has(filename)) continue;
    reached.add(filename);
    pending.push(...(graph.get(filename) || []));
  }
  const modules = [];
  for (const filename of files) {
    if (path.relative(root, filename).split(path.sep).includes('library')) continue;
    modules.push(path.relative(root, filename));
    if (!reached.has(filename))
      report(
        filename,
        1,
        'unused-runtime-module',
        'Sin ruta desde la entrada del servicio o sus trabajadores',
      );
  }
  return {
    modules,
    findings,
    passed : findings.length === 0,
  };
}
module.exports = { analyzeUnused };
