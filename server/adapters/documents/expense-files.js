/** @file Transferencias privadas de comprobantes recibidos con huella, formato y temporales confinados. */
'use strict';
const { createHash }              = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { ApplicationError }        = require('../../shared/application-error');
/** @param {string} name Nodo calificado. @param {Object} value Contenido XML. @param {Object} inherited Espacios de nombres heredados. @returns {void} Acredita los nodos fiscales consumidos sin interpretar complementos ajenos. */
function fiscalNamespaces(name, value, inherited = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
  const scope = { ...inherited };
  for (const [key, uri] of Object.entries(value)) {
    if (key === '@_xmlns') scope[''] = uri;
    else if (key.startsWith('@_xmlns:')) scope[key.slice(8)] = uri;
  }
  const parts = name.split(':'),
    local     = parts.at(-1),
    prefix    = parts.length > 1 ? parts[0] : '';
  const expected =
    local === 'TimbreFiscalDigital'
      ? 'http://www.sat.gob.mx/TimbreFiscalDigital'
      : 'http://www.sat.gob.mx/cfd/4';
  if (scope[prefix] !== expected) throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
  const children =
    {
      Comprobante : ['Emisor', 'Receptor', 'Conceptos', 'Impuestos', 'Complemento'],
      Conceptos   : ['Concepto'],
      Concepto    : ['Impuestos'],
      Impuestos   : ['Traslados', 'Retenciones'],
      Traslados   : ['Traslado'],
      Retenciones : ['Retencion'],
      Complemento : ['TimbreFiscalDigital'],
    }[local] || [];
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_') || !children.includes(key.split(':').at(-1))) continue;
    for (const item of Array.isArray(child) ? child : [child]) fiscalNamespaces(key, item, scope);
  }
}
/** @param {string} xml XML recibido. @returns {Object} Árbol CFDI acotado sin entidades externas. */
function parseExpenseXml(xml) {
  if (
    typeof xml !== 'string' ||
    Buffer.byteLength(xml) > 20971520 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
  const raw     = new XMLParser({
    ignoreAttributes    : false,
    parseTagValue       : false,
    parseAttributeValue : false,
  }).parse(xml);
  const rootKey = Object.keys(raw).find(
    /** @param {string} key Nodo raíz. @returns {boolean} Comprobante sin declaración XML. */ (
      key,
    ) => !key.startsWith('?'),
  );
  const prefix  = rootKey?.includes(':') ? rootKey.split(':')[0] : '';
  if (raw[rootKey]?.[prefix ? '@_xmlns:' + prefix : '@_xmlns'] !== 'http://www.sat.gob.mx/cfd/4')
    throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
  fiscalNamespaces(rootKey, raw[rootKey]);
  const value = new XMLParser({
    ignoreAttributes    : false,
    removeNSPrefix      : true,
    parseTagValue       : false,
    parseAttributeValue : false,
    trimValues          : false,
  }).parse(xml).Comprobante;
  if (
    !value ||
    Array.isArray(value) ||
    value['@_Version'] !== '4.0' ||
    value['@_TipoDeComprobante'] !== 'I'
  )
    throw new ApplicationError(400, 'BILLING_EXPENSE_XML_UNSUPPORTED');
  return value;
}
/** @param {Object} dependencies Transporte y temporales aprobados. @returns {Object} Almacenamiento con idempotencia por identidad estable. */
function expenseFiles({ messaging, temporaryFiles }) {
  /** @param {string} action Operación interna. @param {Object} data Metadatos de dominio. @returns {Promise<Object>} Datos o fallo sin convertir indisponibilidad en ausencia. */
  async function request(action, data) {
    const result = await messaging.request('service-documents', 'files-storage-' + action, data, {
      timeoutMs : 310000,
    });
    if (result.statusCode < 200 || result.statusCode >= 300)
      throw new ApplicationError(result.statusCode, result.descriptionCode);
    return result.data;
  }
  /** @param {Object} owner Registro propietario. @param {string} resource Dominio. @param {string} fileId Identidad. @returns {Object} Pertenencia privada. */
  function subject(owner, resource, fileId) {
    return {
      fileId,
      resourceType : 'billing-' + resource,
      resourceCode : owner.code,
    };
  }
  return {
    /** @param {Object} data Temporal validado del transporte. @returns {Promise<Object>} CFDI recibido para alta asistida. */
    async parseUpload(data) {
      await this.inspect({
        ...data,
        useXml : true,
      });
      return parseExpenseXml(
        await temporaryFiles.promises.readFile(
          await temporaryFiles.validate(data.tempFilePath),
          'utf8',
        ),
      );
    },
    /** @param {Object} data Transferencia recibida desde Gateway. @returns {Promise<Object>} Metadatos de contenido verificados. */
    async inspect(data) {
      const path = await temporaryFiles.validate(data.tempFilePath);
      const stat = await temporaryFiles.promises.stat(path);
      if (
        !stat.isFile() ||
        stat.size !== data.byteLength ||
        stat.size > 20971520 ||
        stat.size === 0
      )
        throw new ApplicationError(400, 'BILLING_FILE_SIZE_MISMATCH');
      const bytes = await temporaryFiles.promises.readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== data.sha256)
        throw new ApplicationError(400, 'BILLING_FILE_DIGEST_MISMATCH');
      let kind, mimeType;
      if (bytes.subarray(0, 5).toString() === '%PDF-') {
        kind = 'pdf';
        mimeType = 'application/pdf';
      } else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        kind = 'image';
        mimeType = 'image/png';
      } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        kind = 'image';
        mimeType = 'image/jpeg';
      } else if (
        bytes.subarray(0, 4).toString() === 'RIFF' &&
        bytes.subarray(8, 12).toString() === 'WEBP'
      ) {
        kind = 'image';
        mimeType = 'image/webp';
      } else if (
        bytes
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trimStart()
          .startsWith('<')
      ) {
        const xml = bytes.toString('utf8');
        if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
          throw new ApplicationError(400, 'BILLING_EXPENSE_XML_INVALID');
        kind = 'xml';
        mimeType = 'application/xml';
      } else throw new ApplicationError(415, 'BILLING_FILE_TYPE_UNSUPPORTED');
      if (data.useXml) parseExpenseXml(bytes.toString('utf8'));
      return {
        name       : data.name,
        byteLength : bytes.length,
        sha256     : data.sha256,
        kind,
        mimeType,
      };
    },
    /** @param {Object} owner Registro autorizado. @param {string} resource Recurso. @param {Object} file Metadatos estables. @param {string} path Temporal del transporte. @returns {Promise<void>} Carga idempotente sin URLs públicas. */
    async upload(owner, resource, file, path) {
      await request('upload', {
        ...subject(owner, resource, file.fileId),
        tempFilePath     : await temporaryFiles.validate(path),
        name             : file.name,
        workspace        : owner.workspace,
        visibility       : 'private',
        image            : file.kind === 'image',
        generateVariants : false,
      });
    },
    /** @param {Object} owner Registro autorizado. @param {string} resource Recurso. @param {Object} file Referencia adoptada. @returns {Promise<Object>} Temporal para descarga autorizada. */
    async read(owner, resource, file) {
      const result = await request('read', subject(owner, resource, file.fileId));
      return {
        tempFilePath : result.tempFilePath,
        fileName     : file.name,
        mimeType     : file.mimeType,
      };
    },
    /** @param {Object} transfer Temporal que perdió autorización. @returns {Promise<void>} Retira sólo la copia de transferencia. */
    async discardTransfer(transfer) {
      await temporaryFiles.remove(transfer.tempFilePath);
    },
    /** @param {Object} owner Gasto. @param {Object} file XML adoptado. @returns {Promise<Object>} Árbol leído del original privado. */
    async xml(owner, file) {
      const result = await request('read', subject(owner, 'expense', file.fileId));
      try {
        return parseExpenseXml(
          await temporaryFiles.promises.readFile(
            await temporaryFiles.validate(result.tempFilePath),
            'utf8',
          ),
        );
      } finally {
        await temporaryFiles.remove(result.tempFilePath);
      }
    },
    /** @param {Object} owner Pertenencia original. @param {string} resource Tipo. @param {Object} file Archivo reservado. @returns {Promise<void>} Limpieza idempotente; propaga fallos recuperables. */
    async remove(owner, resource, file) {
      try {
        await request('remove', subject(owner, resource, file.fileId));
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    },
  };
}
module.exports = {
  expenseFiles,
  parseExpenseXml,
};
