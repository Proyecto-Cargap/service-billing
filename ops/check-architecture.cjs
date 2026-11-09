/** @file Analiza dependencias del código propio sin cargar módulos ni abrir conexiones. */
'use strict';
const fs    = require('node:fs');
const path  = require('node:path');
const acorn = require('acorn');

/** Recorre nodos sintácticos sin ejecutar el código analizado.
 * @param {Object} node Nodo actual.
 * @param {Function} visitor Operación de inspección.
 * @returns {void} Finaliza al recorrer los descendientes.
 */
function visit(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, visitor);
    } else if (value && typeof value === 'object') visit(value, visitor);
  }
}

/** Enumera fuentes propias, excluyendo dependencias y bibliotecas portables.
 * @param {string} directory Directorio de origen.
 * @returns {string[]} Rutas absolutas ordenadas.
 */
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['library', 'node_modules', '.git'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(filename));
    else if (/\.(js|cjs)$/.test(entry.name)) result.push(filename);
  }
  return result.sort();
}

/** Resuelve únicamente archivos locales; nunca importa módulos del servicio.
 * @param {string} filename Fuente que declara la dependencia.
 * @param {string} request Identificador requerido.
 * @returns {string|null} Archivo resuelto o ausencia de destino local.
 */
function resolveLocal(filename, request) {
  if (!request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(filename), request);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Identifica ciclos mediante componentes fuertemente conexos, sin duplicar recorridos.
 * @param {Map<string, string[]>} graph Dependencias locales entre fuentes.
 * @returns {string[][]} Componentes con dependencia circular, incluidos ciclos propios.
 */
function cycles(graph) {
  let sequence  = 0;
  const indexes = new Map();
  const lows    = new Map();
  const active  = new Set();
  const stack   = [];
  const result  = [];
  /** Explora un componente del grafo con el algoritmo de Tarjan.
   * @param {string} vertex Archivo que se visita.
   * @returns {void} Actualiza los componentes detectados.
   */
  function connect(vertex) {
    indexes.set(vertex, sequence);
    lows.set(vertex, sequence++);
    stack.push(vertex);
    active.add(vertex);
    for (const target of graph.get(vertex) || []) {
      if (!graph.has(target)) continue;
      if (!indexes.has(target)) {
        connect(target);
        lows.set(vertex, Math.min(lows.get(vertex), lows.get(target)));
      } else if (active.has(target))
        lows.set(vertex, Math.min(lows.get(vertex), indexes.get(target)));
    }
    if (lows.get(vertex) !== indexes.get(vertex)) return;
    const component = [];
    let item;
    do {
      item = stack.pop();
      active.delete(item);
      component.push(item);
    } while (item !== vertex);
    if (component.length > 1 || graph.get(vertex)?.includes(vertex)) result.push(component.sort());
  }
  for (const vertex of graph.keys()) if (!indexes.has(vertex)) connect(vertex);
  return result;
}

/** Analiza límites de capas y genera inventario trazable; no certifica S, O, L ni I automáticamente.
 * @param {string} root Directorio del servicio.
 * @returns {Object} Componentes, dependencias e incumplimientos sin excepciones ocultas.
 */
function analyze(root) {
  root = path.resolve(root);
  const components = [];
  const findings   = [];
  const graph      = new Map();
  const hazards    = new Map();
  const coreFiles  = new Set();
  for (const filename of files(path.join(root, 'server'))) {
    const relative     = path.relative(root, filename).split(path.sep).join('/');
    const source       = fs.readFileSync(filename, 'utf8');
    const dependencies = [];
    const layer        = relative.match(/\/modules\/[^/]+\/([^/]+)\//)?.[1] || 'technical';
    const core         = [
      'services',
      'policies',
      'ports',
      'contracts',
      'dtos',
      'presenters',
      'read-models',
    ].includes(layer);
    if (core) coreFiles.add(relative);
    const localHazards = [];
    hazards.set(relative, localHazards);
    const ast          = acorn.parse(source, {
      ecmaVersion : 'latest',
      sourceType  : 'script',
      locations   : true,
    });
    const constructors = new Set([
      'Object',
      'Array',
      'String',
      'Number',
      // Decimal es una primitiva matemática pura; no abre clientes ni produce E/S.
      'Decimal',
      'Boolean',
      'Date',
      'RegExp',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'Promise',
      'Error',
      'TypeError',
      'RangeError',
      'URL',
      'URLSearchParams',
      'AbortController',
      'ApplicationError',
    ]);
    visit(
      ast,
      /** @param {Object} node Declaración propia del componente.
       * @returns {void} Permite construir modelos de dominio declarados en el mismo archivo.
       */
      (node) => {
        if (['ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id)
          constructors.add(node.id.name);
      },
    );
    /** Registra una infracción con su ubicación y principio afectado.
     * @param {Object} node Nodo infractor.
     * @param {string} rule Regla incumplida.
     * @param {string} detail Explicación reproducible.
     * @returns {void} Añade el hallazgo a la salida.
     */
    function report(node, rule, detail) {
      findings.push({
        file      : relative,
        line      : node.loc.start.line,
        principle : 'D',
        rule,
        detail,
      });
    }
    visit(
      ast,
      /**
       * Aplica la operación local y devuelve su resultado al flujo que la invoca.
       * @param {*} node Valor utilizado por la operación.
       * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
       */
      (node) => {
        const environmentAccess       =
          node.type === 'MemberExpression' &&
          node.object?.type === 'Identifier' &&
          node.object.name === 'process' &&
          (node.property.name === 'env' || node.property.value === 'env');
        const destructuredEnvironment =
          node.type === 'VariableDeclarator' &&
          node.init?.name === 'process' &&
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some(
            /** @param {Object} property Campo desestructurado del proceso.
             * @returns {boolean} Identifica la configuración ambiental consultada indirectamente.
             */
            (property) => property.key?.name === 'env',
          );
        if (environmentAccess || destructuredEnvironment) {
          localHazards.push({
            line   : node.loc.start.line,
            rule   : 'environment-in-core',
            detail : 'Inyectar configuración desde composición.',
          });
          if (core && destructuredEnvironment)
            report(node, 'environment-in-core', 'Inyectar configuración desde composición.');
        }
        if (
          core &&
          node.type === 'MemberExpression' &&
          [
            '_doc',
            'toObject',
            'toJSON',
            'collection',
            'findOneAndUpdate',
            'aggregate',
            'lean',
            'populate',
          ].includes(node.property?.name || node.property?.value)
        )
          report(
            node,
            'persistence-shape-in-core',
            'Consumir registros de aplicación mediante puertos, sin documentos ni consultas del SDK.',
          );
        if (
          core &&
          node.type === 'NewExpression' &&
          (node.callee.type === 'MemberExpression' ||
            (node.callee.type === 'Identifier' && !constructors.has(node.callee.name)))
        )
          report(
            node,
            'technical-construction-in-core',
            'Construir clientes técnicos en composición e inyectar sus capacidades.',
          );
        if (
          core &&
          node.type === 'MemberExpression' &&
          node.object?.type === 'Identifier' &&
          node.object.name === 'process' &&
          (node.property.name === 'env' || node.property.value === 'env')
        )
          report(node, 'environment-in-core', 'Inyectar configuración desde composición.');
        if (
          node.type !== 'ImportExpression' &&
          (node.type !== 'CallExpression' ||
            node.callee.type !== 'Identifier' ||
            node.callee.name !== 'require')
        )
          return;
        const request = (node.type === 'ImportExpression' ? node.source : node.arguments[0])?.value;
        if (typeof request !== 'string') {
          report(
            node,
            'dynamic-import',
            'Resolver implementaciones con un registro explícito en composición.',
          );
          return;
        }
        const resolved = resolveLocal(filename, request);
        dependencies.push({
          request,
          target : resolved ? path.relative(root, resolved).split(path.sep).join('/') : null,
          line   : node.loc.start.line,
        });
        if (request.startsWith('.') && !resolved) report(node, 'missing-import', request);
        if (
          resolved &&
          /\/server\/(?:adapters\/|modules\/[^/]+\/(?:repositories|models|compositions|controllers|workers|handlers|routes)\/)/.test(
            resolved,
          )
        )
          localHazards.push({
            line   : node.loc.start.line,
            rule   : 'implementation-in-core',
            detail : request,
          });
        if (
          !request.startsWith('.') &&
          !request.startsWith('node:') &&
          !['ms', 'ajv', 'decimal.js'].includes(request)
        )
          localHazards.push({
            line   : node.loc.start.line,
            rule   : 'package-in-core',
            detail : request,
          });
        if (
          /^(?:node:)?(?:fs(?:\/promises)?|https?|net|tls|dgram|dns(?:\/promises)?|child_process|worker_threads)$/.test(
            request,
          )
        )
          localHazards.push({
            line   : node.loc.start.line,
            rule   : 'io-in-core',
            detail : request,
          });

        if (
          core &&
          resolved &&
          /\/server\/(?:adapters\/|modules\/[^/]+\/(?:repositories|models|compositions|controllers|workers|handlers|routes)\/)/.test(
            resolved,
          )
        )
          report(node, 'implementation-in-core', request);
        if (
          core &&
          !request.startsWith('.') &&
          !request.startsWith('node:') &&
          !['ms', 'ajv', 'decimal.js'].includes(request)
        )
          report(node, 'package-in-core', request);
        if (
          core &&
          /^(?:node:)?(?:fs(?:\/promises)?|https?|net|tls|dgram|dns(?:\/promises)?|child_process|worker_threads)$/.test(
            request,
          )
        )
          report(node, 'io-in-core', request);
        if (
          layer === 'controllers' &&
          resolved &&
          /\/server\/(?:adapters\/|modules\/[^/]+\/(?:repositories|models|workers)\/)/.test(
            resolved,
          )
        )
          report(node, 'implementation-in-controller', request);
        if (
          layer === 'ports' &&
          resolved &&
          /\/server\/(?:adapters\/|modules\/[^/]+\/(?:services|repositories|models|compositions|controllers)\/)/.test(
            resolved,
          )
        )
          report(node, 'implementation-in-port', request);
      },
    );
    components.push({
      file         : relative,
      layer,
      dependencies,
      manualReview : {
        S : 'pending',
        O : 'pending',
        L : 'pending',
        I : 'pending',
        D : 'pending',
      },
    });
    graph.set(
      relative,
      dependencies
        .map(
          /**
           * Aplica la operación local y devuelve su resultado al flujo que la invoca.
           * @param {*} dependency Valor utilizado por la operación.
           * @returns {*} Resultado de la operación; los fallos se propagan al flujo invocador.
           */
          (dependency) => dependency.target,
        )
        .filter(Boolean),
    );
  }
  for (const origin of coreFiles) {
    const visited = new Set([origin]);
    const pending = (graph.get(origin) || []).map(
      /** @param {string} target Dependencia local directa.
       * @returns {Object} Ruta inicial para inspeccionar los colaboradores indirectos.
       */
      (target) => ({
        file  : target,
        chain : [origin, target],
      }),
    );
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      for (const hazard of hazards.get(current.file) || []) {
        findings.push({
          file           : origin,
          line           : 1,
          principle      : 'D',
          rule           : 'indirect-' + hazard.rule,
          detail         : `${current.file}:${hazard.line} ${hazard.detail}`,
          dependencyPath : current.chain,
        });
      }
      for (const target of graph.get(current.file) || [])
        pending.push({
          file  : target,
          chain : [...current.chain, target],
        });
    }
  }
  const circular = cycles(graph);
  for (const component of circular)
    findings.push({
      file      : component[0],
      line      : 1,
      principle : 'D',
      rule      : 'dependency-cycle',
      detail    : component.join(' -> '),
    });
  if (fs.existsSync(path.join(root, 'package.json'))) {
    const usage = require('./check-unused.cjs').analyzeUnused(root);
    findings.push(...usage.findings);
  }
  return {
    service : path.basename(root),
    components,
    cycles  : circular,
    findings,
    passed  : findings.length === 0,
  };
}

if (require.main === module) {
  const result = analyze(path.resolve(__dirname, '..'));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of result.findings)
      console.error(`${finding.file}:${finding.line} ${finding.rule}: ${finding.detail}`);
    console.log(
      `${result.service}: ${result.components.length} componentes; ${result.findings.length} hallazgos; ${result.cycles.length} ciclos.`,
    );
  }
  if (!result.passed) process.exitCode = 1;
}
module.exports = {
  analyze,
  cycles,
};
