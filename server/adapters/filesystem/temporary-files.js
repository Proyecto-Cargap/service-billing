/** @file Acceso confinado a temporales; no permite escapar mediante rutas o enlaces simbólicos. */
'use strict';
const nativeFs       = require('node:fs');
const path           = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Compone createTemporaryFiles con las dependencias recibidas y devuelve su interfaz.
 * @param {Object} [options] Colaboradores u opciones: root, readRoots, fs.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createTemporaryFiles({ root, readRoots = [], fs = nativeFs } = {}) {
  const directory = typeof root === 'string' && root ? path.resolve(root) : null;
  /**
   * Ejecuta inside dentro del flujo de temporary-files.
   * @param {*} base Valor de base utilizado por esta operación.
   * @param {*} candidate Valor de candidate utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const inside    = (base, candidate) => candidate === base || candidate.startsWith(base + path.sep);
  /**
   * Ejecuta confined dentro del flujo de temporary-files.
   * @param {string} filename Ruta del archivo que se procesa.
   * @param {*} [write] Valor de write utilizado por esta operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async function confined(filename, write = false) {
    if (!directory || typeof filename !== 'string' || filename.includes('\0'))
      throw Object.assign(new Error('INVALID_TEMPORARY_PATH'), { code: 'INVALID_TEMPORARY_PATH' });
    const candidate = path.resolve(filename);
    const roots     = write
      ? [directory]
      : [
          directory,
          ...readRoots.map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {*} value Valor de value utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (value) => path.resolve(value),
          ),
        ];
    const selected  = roots.find(
      /**
       * Determina si el elemento corresponde al recurso buscado.
       * @param {*} base Valor de base utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (base) => inside(base, candidate),
    );
    if (!selected)
      throw Object.assign(new Error('INVALID_TEMPORARY_PATH'), { code: 'INVALID_TEMPORARY_PATH' });
    const realRoot = await fs.promises.realpath(selected);
    let current    = candidate;
    while (true) {
      try {
        const real = await fs.promises.realpath(current);
        if (!inside(realRoot, real))
          throw Object.assign(new Error('INVALID_TEMPORARY_PATH'), {
            code : 'INVALID_TEMPORARY_PATH',
          });
        return candidate;
      } catch (error) {
        if (error.code !== 'ENOENT' || current === selected) throw error;
        current = path.dirname(current);
      }
    }
  }
  const promises = {};
  for (const operation of ['readFile', 'stat', 'access', 'open']) {
    /**
     * Ejecuta operation dentro del flujo de temporary-files.
     * @param {string} filename Ruta del archivo que se procesa.
     * @param {...*} args Valor de args utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    promises[operation] = async (filename, ...args) =>
      fs.promises[operation](await confined(filename), ...args);
  }
  for (const operation of ['writeFile', 'unlink']) {
    /**
     * Ejecuta operation dentro del flujo de temporary-files.
     * @param {string} filename Ruta del archivo que se procesa.
     * @param {...*} args Valor de args utilizado por esta operación.
     * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    promises[operation] = async (filename, ...args) =>
      fs.promises[operation](await confined(filename, true), ...args);
  }
  return {
    /** Abre un stream sólo después de acreditar la ruta bajo una raíz aprobada.
     * @param {string} filename Archivo de lectura.
     * @returns {Promise<Object>} Stream nativo cuyo cierre pertenece al consumidor.
     */
    async readStream(filename) {
      return fs.createReadStream(await confined(filename));
    },
    /** Reserva un stream de escritura confinado; conserva creación exclusiva y permisos del solicitante.
     * @param {string} filename Archivo de destino bajo TEMP.
     * @param {Object} options Modo y banderas de apertura de la operación interna.
     * @returns {Promise<Object>} Stream nativo que propaga errores de escritura y cierre.
     */
    async writeStream(filename, options) {
      return fs.createWriteStream(await confined(filename, true), options);
    },
    promises,
    constants : fs.constants,
    /**
     * Valida la entrada antes de continuar con la operación.
     * @param {string} filename Ruta del archivo que se procesa.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    validate  : (filename) => confined(filename, true),
    /**
     * Ejecuta uniquePath dentro del flujo de temporary-files.
     * @param {string} [name] Nombre del componente o recurso.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    uniquePath(name = 'file') {
      if (!directory)
        throw Object.assign(new Error('INVALID_TEMPORARY_PATH'), {
          code : 'INVALID_TEMPORARY_PATH',
        });
      return path.join(
        directory,
        `${randomUUID()}-${path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      );
    },
    /**
     * Retira el recurso indicado.
     * @param {string} filename Ruta del archivo que se procesa.
     * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async remove(filename) {
      if (!filename) return;
      try {
        await promises.unlink(filename);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}
module.exports = { createTemporaryFiles };
