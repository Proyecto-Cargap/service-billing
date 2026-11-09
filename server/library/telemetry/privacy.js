/**
 * @file Saneamiento previo de spans, métricas y registros técnicos. Nunca conserva datos de aplicación.
 * Módulo autónomo; las plantillas de rutas pertenecen a la aplicación consumidora.
 */
'use strict';
const METHODS                = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
const OPERATIONS             = new Set(['accept', 'request', 'dispatch', 'publish']);
const OUTCOMES               = new Set(['accepted', 'staged', 'received', 'completed', 'published', 'error']);
const KINDS                  = new Set(['event', 'command', 'request', 'response']);
const CODES                  = new Set(
  'BACKPRESSURE CONFIRM_TIMEOUT CONNECTION_LOST DEADLINE_EXCEEDED EXECUTION_UNCERTAIN HANDLER_FAILED HANDLER_NOT_FOUND INVALID_CONFIGURATION INVALID_ENVELOPE INVALID_JSON INVALID_REPLY INVALID_ROUTE LEASE_LOST MESSAGE_TOO_LARGE MISSING_REPLY_TO NOT_AVAILABLE PERSISTENCE_UNAVAILABLE PUBLISH_REJECTED RPC_TIMEOUT RPC_UNCERTAIN SERIALIZATION_FAILED TRANSACTION_REQUIRED TRANSACTIONS_REQUIRED UNROUTABLE UNSUPPORTED_PROTOCOL INTERNAL_ERROR OPERATION_FAILED AUTHENTICATION_FAILED ACCESS_DENIED VALIDATION_FAILED DEPENDENCY_FAILED'.split(
    ' ',
  ),
);
const PUBLICATION_END_OWNERS = new WeakSet();
const EVENTS                 = new Set([
  'startup',
  'startup_failed',
  'shutdown',
  'ready',
  'disconnect',
  'export_failed',
  'health_failed',
  'connection_failed',
  'reconnecting',
  'closed',
  'draining',
  'persistence_failed',
  'publish_failed',
  'operation_failed',
  'operation_completed',
  'authentication_failed',
  'validation_failed',
  'dependency_failed',
]);
const DB_OPERATIONS          = new Set(
  'find findOne insert insertOne insertMany update updateOne updateMany delete deleteOne deleteMany aggregate count countDocuments distinct findAndModify createIndexes getMore commitTransaction abortTransaction ping unknown'.split(
    ' ',
  ),
);
const AMQP_OPERATIONS        = new Set([
  'publish',
  'send',
  'receive',
  'deliver',
  'process',
  'ack',
  'nack',
  'reject',
  'auto ack',
  'ackAll',
  'nackAll',
  'channel closed',
  'channel error',
  'instrumentation timeout',
]);

/** Obtiene una plantilla acotada y elimina query, fragmento, identificadores y tokens antes de registrarlos.
 * @param {*} value Valor de value utilizado por esta operación.
 * @param {*} [routeTemplates] Valor de routeTemplates utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function normalizeRoute(value, routeTemplates = []) {
  return createRouteNormalizer(routeTemplates)(value);
}

/** Compila un catálogo explícito una sola vez; sin catálogo no conserva segmentos de entrada.
 * @param {*} [routeTemplates] Valor de routeTemplates utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createRouteNormalizer(routeTemplates = []) {
  const templates = (Array.isArray(routeTemplates) ? routeTemplates : [])
    .slice(0, 256)
    .flatMap(
      /**
       * Proyecta y reúne los elementos en una sola colección.
       * @param {*} template Valor de template utilizado por esta operación.
       * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (template) => {
        if (typeof template !== 'string' || !template.startsWith('/') || template.length > 2048)
          return [];
        const parts = template.split('/').filter(Boolean);
        if (
          parts.length > 12 ||
          parts.some(
            /**
             * Comprueba si el elemento satisface la condición.
             * @param {*} part Valor de part utilizado por esta operación.
             * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (part) =>
              !/^(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*|\{[A-Za-z][A-Za-z0-9_]*\})$/.test(part),
          )
        )
          return [];
        const parameters = parts.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} part Valor de part utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (part) => part.startsWith(':') || part.startsWith('{'),
        );
        return [
          {
            parts,
            parameters,
            count : parameters.filter(Boolean).length,
            route :
              '/' +
              parts
                .map(
                  /**
                   * Proyecta cada elemento en la estructura requerida por la operación.
                   * @param {*} part Valor de part utilizado por esta operación.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  (part) => (part.startsWith(':') ? `{${part.slice(1)}}` : part),
                )
                .join('/'),
          },
        ];
      },
    )
    .sort(
      /**
       * Compara dos elementos para establecer su orden.
       * @param {*} left Valor de left utilizado por esta operación.
       * @param {*} right Valor de right utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (left, right) => left.count - right.count,
    );
  /**
   * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
   * @param {*} value Valor de value utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  return (value) => {
    if (typeof value !== 'string') return '/{unmatched}';
    let path = value.split(/[?#]/, 1)[0];
    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname;
      } catch {
        return '/{unmatched}';
      }
    }
    if (!path.startsWith('/') || path.length > 2048) return '/{unmatched}';
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 12) return '/{unmatched}';
    return (
      templates.find(
        /**
         * Determina si el elemento corresponde al recurso buscado.
         * @param {*} template Valor de template utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (template) =>
          template.parts.length === parts.length &&
          template.parts.every(
            /**
             * Comprueba la condición requerida para cada elemento.
             * @param {*} part Valor de part utilizado por esta operación.
             * @param {*} i Valor de i utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (part, i) => template.parameters[i] || part === parts[i],
          ),
      )?.route || '/{unmatched}'
    );
  };
}

/** Conserva exclusivamente dimensiones de infraestructura; no recorre objetos, payloads ni errores.
 * @param {Object} [input] Entrada que se procesa con las reglas del módulo.
 * @param {*} [normalize] Valor de normalize utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function safeAttributes(input = {}, normalize = normalizeRoute) {
  const result = {};
  const known  = new Set([
    'http.route',
    'http.method',
    'http.request.method',
    'http.status_code',
    'http.response.status_code',
    'db.system',
    'db.system.name',
    'db.operation',
    'db.operation.name',
    'messaging.system',
    'messaging.operation',
    'messaging.operation.type',
    'messaging.operation.name',
    'messaging.message.type',
    'operation',
    'outcome',
    'error.type',
    'rpc.system',
    'rpc.service',
    'rpc.method',
    'retryable',
    'uncertain',
    'messaging.rabbitmq.message.redelivered',
  ]);
  for (const key of Object.keys(input || {})) {
    if (!known.has(key)) continue;
    const value = input[key];
    if (key === 'http.route') {
      result[key] = normalize(value);
      continue;
    }
    if (key === 'http.method' || key === 'http.request.method') {
      result[key] = METHODS.has(value) ? value : '_OTHER';
      continue;
    }
    if (key === 'http.status_code' || key === 'http.response.status_code') {
      if (Number.isInteger(value) && value >= 100 && value <= 599) result[key] = value;
      continue;
    }
    if (key === 'db.system' || key === 'db.system.name') {
      if (value === 'mongodb') result[key] = value;
      continue;
    }
    if (key === 'db.operation' || key === 'db.operation.name') {
      result[key] = DB_OPERATIONS.has(value) ? value : 'unknown';
      continue;
    }
    if (key === 'messaging.system') {
      if (value === 'rabbitmq') result[key] = value;
      continue;
    }
    if (
      key === 'messaging.operation' ||
      key === 'messaging.operation.type' ||
      key === 'messaging.operation.name'
    ) {
      if (AMQP_OPERATIONS.has(value)) result[key] = value;
      continue;
    }
    if (key === 'messaging.message.type' && KINDS.has(value)) result[key] = value;
    if (key === 'operation' && OPERATIONS.has(value)) result[key] = value;
    if (key === 'outcome' && OUTCOMES.has(value)) result[key] = value;
    if (key === 'error.type') result[key] = CODES.has(value) ? value : 'INTERNAL_ERROR';
    if (key === 'rpc.system' && value === 'aws-api') result[key] = value;
    if (key === 'rpc.service' && value === 'S3') result[key] = value;
    if (
      key === 'rpc.method' &&
      [
        'GetObject',
        'PutObject',
        'DeleteObject',
        'HeadObject',
        'ListObjectsV2',
        'CopyObject',
        'CreateMultipartUpload',
        'UploadPart',
        'CompleteMultipartUpload',
        'AbortMultipartUpload',
      ].includes(value)
    )
      result[key] = value;
    if (
      ['retryable', 'uncertain', 'messaging.rabbitmq.message.redelivered'].includes(key) &&
      typeof value === 'boolean'
    )
      result[key] = value;
  }
  return result;
}

/** Nombra protocolos por su operación; jamás utiliza URL, colección, exchange o clave S3 como nombre.
 * @param {string} name Nombre del componente o recurso.
 * @param {*} [attributes] Valor de attributes utilizado por esta operación.
 * @param {string|symbol} [scope] Alcance solicitado o marcador interno de confianza.
 * @param {*} [normalize] Valor de normalize utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function safeSpanName(name, attributes = {}, scope = '', normalize = normalizeRoute) {
  if (scope.includes('http'))
    return `HTTP ${METHODS.has(attributes['http.request.method'] || attributes['http.method']) ? attributes['http.request.method'] || attributes['http.method'] : 'request'}`;
  if (scope.includes('express')) return `express ${normalize(attributes['http.route'] || '/')}`;
  if (scope.includes('mongodb'))
    return `mongodb ${attributes['db.operation.name'] || attributes['db.operation'] || 'operation'}`;
  if (scope.includes('amqplib'))
    return `rabbitmq ${attributes['messaging.operation.type'] || attributes['messaging.operation'] || (String(name).includes('publish') ? 'publish' : 'process')}`;
  if (scope.includes('aws-sdk')) return `aws ${attributes['rpc.method'] || 'request'}`;
  return /^messaging\.(accept|request|dispatch|publish)$/.test(name) ? name : 'technical.operation';
}

/** Crea una vista inmutable segura para exportadores y evita que errores del SDK expongan excepciones.
 * @param {*} span Valor de span utilizado por esta operación.
 * @param {*} [normalize] Valor de normalize utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function sanitizeSpan(span, normalize = normalizeRoute) {
  const attributes = safeAttributes(span.attributes, normalize);
  return {
    name                   : safeSpanName(span.name, attributes, span.instrumentationScope?.name || '', normalize),
    kind                   : span.kind,
    startTime              : span.startTime,
    endTime                : span.endTime,
    resource               : span.resource,
    instrumentationScope   : span.instrumentationScope,
    duration               : span.duration,
    ended                  : span.ended,
    droppedAttributesCount : span.droppedAttributesCount,
    droppedEventsCount     : span.droppedEventsCount,
    droppedLinksCount      : span.droppedLinksCount,
    attributes,
    status                 : { code: span.status.code },
    events                 : span.events
      .filter(
        /**
         * Determina si el elemento cumple el criterio de selección.
         * @param {*} event Valor de event utilizado por esta operación.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (event) => event.name === 'exception',
      )
      .map(
        /**
         * Proyecta cada elemento en la estructura requerida por la operación.
         * @param {*} event Valor de event utilizado por esta operación.
         * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (event) => ({
          ...event,
          name       : 'exception',
          attributes : { 'exception.type': 'TechnicalError' },
        }),
      ),
    links                  : span.links.map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} link Valor de link utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (link) => ({
        ...link,
        context    : safeSpanContext(link.context),
        attributes : {},
      }),
    ),
    parentSpanContext      : span.parentSpanContext ? safeSpanContext(span.parentSpanContext) : undefined,
    /**
     * Ejecuta spanContext dentro del flujo de privacy.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    spanContext            : () => safeSpanContext(span.spanContext()),
  };
}

/** El estado propietario W3C puede contener datos arbitrarios: se propaga, pero no se exporta.
 * @param {Object} context Contexto de identidad y alcance de la operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function safeSpanContext(context) {
  return {
    traceId    : context.traceId,
    spanId     : context.spanId,
    traceFlags : context.traceFlags,
    ...(context.isRemote === undefined ? {} : { isRemote: context.isRemote }),
  };
}

/** Intercepta el proveedor que recibe cada instrumentación, antes de construir o modificar un span.
 * @param {*} span Valor de span utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function ownPublicationSpan(span) {
  PUBLICATION_END_OWNERS.add(span);
  return span;
}

/**
 * Ejecuta protectInstrumentation dentro del flujo de privacy.
 * @param {*} instrumentation Valor de instrumentation utilizado por esta operación.
 * @param {*} [normalize] Valor de normalize utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function protectInstrumentation(instrumentation, normalize = normalizeRoute) {
  const original = instrumentation.setTracerProvider.bind(instrumentation);
  /**
   * Ejecuta setTracerProvider dentro del flujo de privacy.
   * @param {*} provider Valor de provider utilizado por esta operación.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  instrumentation.setTracerProvider = (provider) =>
    original({
      /**
       * Resuelve getTracer aplicando los filtros y colaboradores del módulo.
       * @param {string|symbol} scope Alcance solicitado o marcador interno de confianza.
       * @param {*} version Valor de version utilizado por esta operación.
       * @param {Object} options Opciones que delimitan el comportamiento de la operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      getTracer(scope, version, options) {
        const tracer = provider.getTracer(scope, version, options);
        return new Proxy(tracer, {
          /**
           * Obtiene el valor solicitado.
           * @param {string} target Valor de target utilizado por esta operación.
           * @param {string} key Clave del campo o recurso que se procesa.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          get(target, key) {
            if (key !== 'startSpan') {
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            }
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {string} name Nombre del componente o recurso.
             * @param {Object} [config] Valor de config utilizado por esta operación.
             * @param {*} parent Valor de parent utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            return (name, config = {}, parent) => {
              const attributes     = safeAttributes(config.attributes, normalize);
              const span           = target.startSpan(
                safeSpanName(name, attributes, scope, normalize),
                {
                  ...config,
                  attributes,
                  links : config.links?.map(
                    /**
                     * Proyecta cada elemento en la estructura requerida por la operación.
                     * @param {*} link Valor de link utilizado por esta operación.
                     * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    (link) => ({
                      ...link,
                      attributes : {},
                    }),
                  ),
                },
                parent,
              );
              let publicationEnded = false;
              const protectedSpan  = new Proxy(span, {
                /**
                 * Obtiene el valor solicitado.
                 * @param {*} actual Valor de actual utilizado por esta operación.
                 * @param {*} method Valor de method utilizado por esta operación.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                get(actual, method) {
                  // Only the explicit confirm bridge shares terminal ownership with amqplib.
                  // Other spans retain the SDK's diagnostics for incorrect repeated end calls.
                  if (method === 'end' && PUBLICATION_END_OWNERS.has(protectedSpan))
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @param {...*} args Valor de args utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return (...args) => {
                      if (publicationEnded) return;
                      publicationEnded = true;
                      return actual.end(...args);
                    };
                  if (method === 'setAttribute')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @param {string} key Clave del campo o recurso que se procesa.
                     * @param {*} value Valor de value utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return (key, value) => {
                      actual.setAttributes(safeAttributes({ [key]: value }, normalize));
                      return protectedSpan;
                    };
                  if (method === 'setAttributes')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @param {*} attrs Valor de attrs utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return (attrs) => {
                      actual.setAttributes(safeAttributes(attrs, normalize));
                      return protectedSpan;
                    };
                  if (method === 'updateName')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return () => span;
                  if (method === 'recordException')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return () => {
                      actual.addEvent('exception', { 'exception.type': 'TechnicalError' });
                      return protectedSpan;
                    };
                  if (method === 'addEvent')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @param {*} event Valor de event utilizado por esta operación.
                     * @param {*} attrs Valor de attrs utilizado por esta operación.
                     * @param {*} time Valor de time utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return (event, attrs, time) => {
                      if (event === 'exception')
                        actual.addEvent('exception', { 'exception.type': 'TechnicalError' }, time);
                      return protectedSpan;
                    };
                  if (method === 'setStatus')
                    /**
                     * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                     * @param {*} status Valor de status utilizado por esta operación.
                     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                     */
                    return (status) => {
                      actual.setStatus({ code: status.code });
                      return protectedSpan;
                    };
                  const value = actual[method];
                  return typeof value === 'function' ? value.bind(actual) : value;
                },
              });
              return protectedSpan;
            };
          },
        });
      },
    });
  return instrumentation;
}

/** Produce un registro con esquema fijo y omite todo metadato desconocido.
 * @param {*} record Valor de record utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function safeLog(record) {
  if (!record || typeof record !== 'object')
    return {
      body       : 'technical.event',
      attributes : {},
    };
  const event      = EVENTS.has(record.event) ? record.event : 'technical.event';
  const attributes = safeAttributes({
    'error.type' : record.code,
    retryable    : record.retryable,
    uncertain    : record.uncertain,
  });
  if (record.code === undefined) delete attributes['error.type'];
  if (
    [
      'messaging',
      'telemetry',
      'startup',
      'lifecycle',
      'service',
      'http',
      'socket',
      'smtp',
      'storage',
      'rendering',
      'database',
      'application',
    ].includes(record.component)
  )
    attributes.component = record.component;
  return {
    body : event,
    attributes,
  };
}

module.exports = {
  normalizeRoute,
  createRouteNormalizer,
  safeAttributes,
  safeSpanName,
  sanitizeSpan,
  safeSpanContext,
  protectInstrumentation,
  ownPublicationSpan,
  safeLog,
  OPERATIONS,
  OUTCOMES,
  KINDS,
  CODES,
};
