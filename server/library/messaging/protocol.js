/**
 * @file Construcción, validación y serialización del sobre técnico versión 2; los datos de negocio
 * permanecen opacos.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { randomUUID }     = require('node:crypto');
const { MessagingError } = require('./errors');
const VERSION            = 2;
const MAX_WIRE_BYTES     = 8 * 1024 * 1024;
const kinds              = new Set(['event', 'command', 'request', 'response']);

/** Valida exclusivamente el carrier W3C técnico, sin admitir baggage ni formatos anteriores.
 * @param {*} carrier Valor de carrier utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function validateTelemetry(carrier) {
  if (carrier === null) return carrier;
  /**
   * Ejecuta invalid dentro del flujo de protocol.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  const invalid = () => {
    throw new MessagingError('INVALID_ENVELOPE', 'Invalid telemetry carrier');
  };
  if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) invalid();
  if (
    Object.keys(carrier).some(
      /**
       * Comprueba si el elemento satisface la condición.
       * @param {string} key Clave del campo o recurso que se procesa.
       * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (key) => !['traceparent', 'tracestate'].includes(key),
    )
  )
    invalid();
  const parent = carrier.traceparent;
  if (
    typeof parent !== 'string' ||
    !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(parent) ||
    /^0{32}$/.test(parent.slice(3, 35)) ||
    /^0{16}$/.test(parent.slice(36, 52))
  )
    invalid();
  if (carrier.tracestate !== undefined) {
    if (typeof carrier.tracestate !== 'string' || carrier.tracestate.length > 512) invalid();
    const members = carrier.tracestate.split(',');
    if (members.length > 32) invalid();
    const keys = new Set();
    for (const member of members) {
      const trimmed = member.replace(/^[ \t]+|[ \t]+$/g, '');
      if (!trimmed) continue;
      const pair = trimmed.split('=');
      const key = pair[0],
        value   = pair[1];
      if (
        pair.length !== 2 ||
        !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(
          key,
        ) ||
        !value ||
        value.length > 256 ||
        !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]*[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(value) ||
        keys.has(key)
      )
        invalid();
      keys.add(key);
    }
  }
  return carrier;
}

/**
 * Comprueba que un campo técnico sea una cadena no vacía de hasta 256 caracteres.
 *
 * @param {*} value Valor que se examina o transforma.
 * @param {string} field Nombre del campo utilizado por la operación.
 * @returns {void} Finaliza si el campo cumple las restricciones técnicas.
 * @throws {Error} Interrumpe la operación
 * ante INVALID_ENVELOPE.
 */
function text(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new MessagingError('INVALID_ENVELOPE', `Invalid technical field: ${field}`);
  }
}

/**
 * Valida la versión, identidad, destino y plazos del sobre, sin inspeccionar el contenido de negocio.
 *
 * @param {Object} envelope Sobre técnico con identidad, versión, contexto y contenido del mensaje.
 * @returns {Object} El mismo sobre recibido, una vez validados sus campos técnicos.
 * @throws {Error} Interrumpe la operación
 * ante INVALID_ENVELOPE, UNSUPPORTED_PROTOCOL.
 */
function validate(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new MessagingError('INVALID_ENVELOPE');
  }
  if (envelope.schemaVersion !== VERSION) throw new MessagingError('UNSUPPORTED_PROTOCOL');
  if (!Object.hasOwn(envelope, 'telemetry'))
    throw new MessagingError('INVALID_ENVELOPE', 'Missing telemetry carrier');
  validateTelemetry(envelope.telemetry);
  if (!kinds.has(envelope.kind))
    throw new MessagingError('INVALID_ENVELOPE', 'Unknown message kind');
  for (const field of ['messageId', 'name', 'source', 'correlationId'])
    text(envelope[field], field);
  if (!Number.isSafeInteger(envelope.version) || envelope.version < 1) {
    throw new MessagingError('INVALID_ENVELOPE', 'Invalid contract version');
  }
  if (!Number.isFinite(Date.parse(envelope.createdAt)))
    throw new MessagingError('INVALID_ENVELOPE', 'Invalid creation time');
  if (['command', 'request', 'response'].includes(envelope.kind)) text(envelope.target, 'target');
  if (envelope.causationId !== undefined) text(envelope.causationId, 'causationId');
  if (envelope.kind === 'request' || envelope.deadlineAt !== undefined) {
    if (!Number.isSafeInteger(envelope.deadlineAt) || envelope.deadlineAt < 0) {
      throw new MessagingError('INVALID_ENVELOPE', 'Invalid deadline');
    }
  }
  if (!Object.hasOwn(envelope, 'payload') || !Object.hasOwn(envelope, 'context')) {
    throw new MessagingError('INVALID_ENVELOPE', 'Missing transport body');
  }
  if (
    envelope.readCursor !== undefined &&
    (envelope.kind !== 'response' ||
      typeof envelope.readCursor !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.readCursor))
  )
    throw new MessagingError('INVALID_READ_RECEIPT');
  if (envelope.transportError !== undefined) {
    text(envelope.transportError.code, 'transportError.code');
  }
  /**
   * El contenido de aplicación y el contexto son valores JSON opacos; sus reglas de negocio se validan
   * fuera del protocolo.
   */
  return envelope;
}

/**
 * Serializa y vuelve a validar el sobre después de convertirlo a JSON; limita el tamaño en bytes.
 *
 * @param {Object} envelope Sobre técnico con identidad, versión, contexto y contenido del mensaje.
 * @param {number} [maxBytes] Límite máximo de bytes admitidos para la representación serializada.
 * @returns {Buffer} Sobre JSON codificado en UTF-8 y dentro del límite de transporte.
 * @throws {Error} Interrumpe la operación
 * ante SERIALIZATION_FAILED, MESSAGE_TOO_LARGE.
 */
function encode(envelope, maxBytes = MAX_WIRE_BYTES) {
  validate(envelope);
  let wire;
  try {
    wire = JSON.stringify(envelope);
  } catch {
    throw new MessagingError('SERIALIZATION_FAILED');
  }
  const bytes = Buffer.byteLength(wire);
  if (bytes > maxBytes) throw new MessagingError('MESSAGE_TOO_LARGE');
  /**
   * La serialización JSON puede omitir propiedades undefined; vuelve a validar el sobre que realmente se
   * transmitirá.
   */
  validate(JSON.parse(wire));
  return Buffer.from(wire);
}

/**
 * Decodifica UTF-8 y JSON, comprueba el tamaño y valida el sobre recibido.
 *
 * @param {Buffer|string} wire Representación serializada del mensaje.
 * @param {number} [maxBytes] Límite máximo de bytes admitidos para la representación serializada.
 * @returns {Object} Sobre decodificado y validado.
 * @throws {Error} Interrumpe la operación
 * ante MESSAGE_TOO_LARGE, INVALID_JSON.
 */
function decode(wire, maxBytes = MAX_WIRE_BYTES) {
  if (Buffer.byteLength(wire) > maxBytes) throw new MessagingError('MESSAGE_TOO_LARGE');
  let envelope;
  try {
    const json =
      typeof wire === 'string' ? wire : new TextDecoder('utf-8', { fatal: true }).decode(wire);
    envelope = JSON.parse(json);
  } catch {
    throw new MessagingError('INVALID_JSON');
  }
  return validate(envelope);
}

/**
 * Completa identificadores, versión, fechas y contexto predeterminados antes de validar el sobre.
 *
 * @param {Object} fields Campos que se incorporan al sobre técnico del mensaje.
 * @returns {Object} Sobre completo, con identificadores y valores predeterminados ya validados.
 */
function createEnvelope(fields) {
  const messageId = fields.messageId || randomUUID();
  return validate({
    schemaVersion : VERSION,
    telemetry     : fields.telemetry,
    messageId,
    kind          : fields.kind,
    name          : fields.name,
    version       : fields.version ?? 1,
    source        : fields.source,
    ...(fields.target === undefined ? {} : { target: fields.target }),
    createdAt     : fields.createdAt || new Date().toISOString(),
    correlationId : fields.correlationId || messageId,
    ...(fields.causationId === undefined ? {} : { causationId: fields.causationId }),
    ...(fields.deadlineAt === undefined ? {} : { deadlineAt: fields.deadlineAt }),
    context       : fields.context === undefined ? {} : fields.context,
    payload       : fields.payload === undefined ? null : fields.payload,
    ...(fields.transportError === undefined ? {} : { transportError: fields.transportError }),
    ...(fields.readCursor === undefined ? {} : { readCursor: fields.readCursor }),
  });
}

module.exports = {
  VERSION,
  MAX_WIRE_BYTES,
  validate,
  validateTelemetry,
  encode,
  decode,
  createEnvelope,
};
