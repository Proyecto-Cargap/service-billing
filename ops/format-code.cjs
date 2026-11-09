/** @file Formato uniforme de código: indentación de dos espacios y claves de objetos alineadas. */
'use strict';
const fs       = require('node:fs');
const path     = require('node:path');
const acorn    = require('acorn');
const prettier = require('prettier');

/**
 * Visita recursivamente los nodos de sintaxis sin recorrer posiciones ni comentarios.
 * @param {Object} node Nodo de sintaxis que se recorre.
 * @param {Function} visitor Operación que recibe cada nodo.
 * @returns {void} Finaliza después de visitar los descendientes.
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
 * Aplica sustituciones desde el final del archivo para conservar las posiciones originales.
 * @param {string} source Código que se transforma sin modificar sus expresiones.
 * @param {Object[]} edits Posiciones iniciales, finales y texto de reemplazo.
 * @returns {string} Código con las sustituciones de espacios y saltos de línea.
 */
function applyEdits(source, edits) {
  for (const edit of edits.sort(
    /**
     * Compara dos elementos para establecer su orden.
     * @param {*} left Valor de left utilizado por esta operación.
     * @param {*} right Valor de right utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (left, right) => right.start - left.start,
  ))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

/**
 * Separa en líneas los objetos con varias propiedades para hacer visible su estructura.
 * @param {string} source Código JavaScript válido.
 * @returns {string} Código con un salto tras la apertura de objetos con varias propiedades.
 */
function expandObjects(source) {
  const ast   = acorn.parse(source, {
    ecmaVersion : 'latest',
    sourceType  : 'commonjs',
    locations   : true,
  });
  const edits = [];
  visit(
    ast,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    (node) => {
      if (
        node.type === 'ObjectExpression' &&
        node.properties.length > 1 &&
        node.loc.start.line === node.properties[0].loc.start.line
      )
        edits.push({
          start : node.start + 1,
          end   : node.start + 1,
          text  : '\n',
        });
    },
  );
  return applyEdits(source, edits);
}

/**
 * Alinea los dos puntos de propiedades multilínea en una columna común por objeto.
 * Conserva un espacio a cada lado; los métodos y propiedades abreviadas no llevan dos puntos.
 * @param {string} source Código ya estructurado por Prettier.
 * @param {boolean} [json=false] Permite analizar un documento JSON como expresión.
 * @returns {string} Código con claves, separadores y valores alineados por objeto.
 */
function alignObjectKeys(source, json = false) {
  const parsed = json ? '(' + source + ')' : source;
  const ast    = acorn.parse(parsed, {
    ecmaVersion : 'latest',
    sourceType  : 'commonjs',
    locations   : true,
  });
  const offset = json ? 1 : 0;
  const edits  = [];
  visit(
    ast,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (node) => {
      if (
        !['ObjectExpression', 'ObjectPattern'].includes(node.type) ||
        node.loc.start.line === node.loc.end.line
      )
        return;
      const entries = node.properties.flatMap(
        /**
         * Proyecta y reúne los elementos en una sola colección.
         * @param {*} property Valor de property utilizado por esta operación.
         * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (property) => {
          if (
            property.type !== 'Property' ||
            property.method ||
            property.shorthand ||
            property.kind !== 'init' ||
            property.key.loc.start.line !== property.key.loc.end.line
          )
            return [];
          const colon = parsed.indexOf(':', property.key.end);
          if (colon < 0 || colon >= property.value.start) return [];
          const keyEnd = property.computed ? parsed.lastIndexOf(']', colon) + 1 : property.key.end;
          if (!/^\s*$/.test(parsed.slice(keyEnd, colon))) return [];
          const column = property.key.loc.end.column + (keyEnd - property.key.end);
          return [
            {
              keyEnd,
              colon,
              column,
            },
          ];
        },
      );
      if (!entries.length) return;
      const column =
        Math.max(
          ...entries.map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {*} entry Valor de entry utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (entry) => entry.column,
          ),
        ) + 1;
      for (const entry of entries)
        edits.push({
          start : entry.keyEnd - offset,
          end   : entry.colon - offset,
          text  : ' '.repeat(column - entry.column),
        });
    },
  );
  return applyEdits(source, edits);
}

/**
 * Alinea las inicializaciones consecutivas de cada bloque, sin cambiar valores ni alcance léxico.
 * @param {string} source Código JavaScript estructurado e indentado.
 * @returns {string} Declaraciones de variables, constantes y campos con el signo igual alineado.
 */
function alignDeclarations(source) {
  const ast   = acorn.parse(source, {
    ecmaVersion : 'latest',
    sourceType  : 'commonjs',
    locations   : true,
  });
  const edits = [];
  /**
   * Calcula la columna común y modifica sólo los espacios anteriores al signo igual.
   * @param {Object[]} declarations Declaraciones consecutivas con inicializador.
   * @returns {void} Agrega las sustituciones de espacios a la colección de cambios.
   */
  function align(declarations) {
    if (!declarations.length) return;
    const entries = declarations.flatMap(
      /**
       * Proyecta y reúne los elementos en una sola colección.
       * @param {*} declaration Valor de declaration utilizado por esta operación.
       * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (declaration) => {
        const left  = declaration.id || declaration.key;
        const right = declaration.init || declaration.value;
        if (!left || !right || left.loc.start.line !== left.loc.end.line) return [];
        const middle = source.slice(left.end, right.start);
        if (!/^\s*=\s*$/.test(middle)) return [];
        const equals = source.indexOf('=', left.end);
        return [
          {
            end    : left.end,
            equals,
            column : left.loc.end.column,
          },
        ];
      },
    );
    if (!entries.length) return;
    const column =
      Math.max(
        ...entries.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} entry Valor de entry utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (entry) => entry.column,
        ),
      ) + 1;
    for (const entry of entries)
      edits.push({
        start : entry.end,
        end   : entry.equals,
        text  : ' '.repeat(column - entry.column),
      });
  }
  visit(
    ast,
    /**
     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
     * @param {*} node Valor de node utilizado por esta operación.
     * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (node) => {
      if (!['Program', 'BlockStatement', 'StaticBlock', 'ClassBody'].includes(node.type)) return;
      let group = [];
      let previous;
      for (const statement of node.body) {
        const declaration =
          statement.type === 'VariableDeclaration' && statement.declarations.length === 1
            ? statement.declarations[0]
            : statement.type === 'PropertyDefinition'
              ? statement
              : null;
        const left        = declaration?.id || declaration?.key;
        const right       = declaration?.init || declaration?.value;
        if (
          !declaration ||
          !left ||
          !right ||
          left.loc.start.line !== left.loc.end.line ||
          (previous && /\n[ \t]*\n/.test(source.slice(previous.end, statement.start)))
        ) {
          align(group);
          group = [];
        }
        if (declaration && left && right && left.loc.start.line === left.loc.end.line)
          group.push(declaration);
        else if (statement.type === 'VariableDeclaration' && statement.declarations.length > 1)
          align(statement.declarations);
        previous = statement;
      }
      align(group);
    },
  );
  return applyEdits(source, edits);
}

/**
 * Aplica el estándar completo de forma determinista sin cambiar expresiones ni valores.
 * @param {string} source Código o documento JSON que se formatea.
 * @param {string} filename Ruta que determina el parser y la configuración del servicio.
 * @returns {Promise<string>} Texto estructurado, indentado y alineado.
 */
async function formatSource(source, filename) {
  const json = path.extname(filename) === '.json';
  if (json) JSON.parse(source);
  const options = await prettier.resolveConfig(filename);
  let formatted = json ? source : expandObjects(source);
  for (let pass = 0; pass < 5; pass++) {
    const next = await prettier.format(formatted, {
      ...options,
      filepath : filename,
    });
    if (next === formatted) break;
    formatted = next;
  }
  const aligned = alignObjectKeys(formatted, json);
  return json ? aligned : alignDeclarations(aligned);
}

/**
 * Enumera código y JSON propios, sin dependencias instaladas ni archivos generados por npm.
 * @param {string} root Directorio raíz del servicio.
 * @returns {string[]} Archivos a los que se aplica el estándar.
 */
function codeFiles(root) {
  /**
   * Ejecuta list dentro del flujo de format-code.
   * @param {string} directory Valor de directory utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  function list(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(
      /**
       * Proyecta y reúne los elementos en una sola colección.
       * @param {*} entry Valor de entry utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory()
          ? list(filename)
          : /\.(?:js|cjs|json)$/.test(entry.name)
            ? [filename]
            : [];
      },
    );
  }
  return ['server', 'test', 'ops']
    .flatMap(
      /**
       * Proyecta y reúne los elementos en una sola colección.
       * @param {string} directory Valor de directory utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (directory) => list(path.join(root, directory)),
    )
    .concat(
      fs
        .readdirSync(root)
        .filter(
          /**
           * Determina si el elemento cumple el criterio de selección.
           * @param {string} name Nombre del componente o recurso.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (name) =>
            (name.endsWith('.json') && name !== 'package-lock.json') || /\.(?:js|cjs)$/.test(name),
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
}

/**
 * Escribe el formato o señala diferencias según la opción solicitada en la línea de comandos.
 * @returns {Promise<void>} Finaliza tras comprobar o escribir todos los archivos propios.
 */
async function main() {
  const write  = process.argv.includes('--write');
  let failures = 0;
  const files  = codeFiles(path.resolve(__dirname, '..'));
  for (const filename of files) {
    const source    = fs.readFileSync(filename, 'utf8');
    const formatted = await formatSource(source, filename);
    if (source === formatted) continue;
    if (write) fs.writeFileSync(filename, formatted);
    else {
      console.error(`${filename}: indentación o alineación distinta del estándar.`);
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
  else console.log(`${files.length} archivos: indentación y alineación correctas.`);
}

if (require.main === module)
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
module.exports = {
  formatSource,
  codeFiles,
};
