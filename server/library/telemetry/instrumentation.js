/**
 * @file Instrumentaciones explícitas y protegidas; MongoDB cubre el driver sin duplicar Mongoose.
 * Biblioteca autónoma de observabilidad técnica para aplicaciones Node.js.
 */
'use strict';
const {
  normalizeRoute : defaultNormalizeRoute,
  protectInstrumentation,
  ownPublicationSpan,
} = require('./privacy');

/** Construye el catálogo técnico; no importa drivers ni requiere que la aplicación utilice todos ellos.
 * @param {Object} [options] Colaboradores u opciones: trackPublication, completePublication, normalizeRoute.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createInstrumentations({
  trackPublication,
  completePublication,
  normalizeRoute = defaultNormalizeRoute,
} = {}) {
  const { HttpInstrumentation }        = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation }     = require('@opentelemetry/instrumentation-express');
  const { AmqplibInstrumentation }     = require('@opentelemetry/instrumentation-amqplib');
  const { MongoDBInstrumentation }     = require('@opentelemetry/instrumentation-mongodb');
  const { AwsInstrumentation }         = require('@opentelemetry/instrumentation-aws-sdk');
  const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');
  return [
    new HttpInstrumentation({
      headersToSpanAttributes        : {},
      enableSyntheticSourceDetection : false,
      /**
       * Ejecuta startIncomingSpanHook dentro del flujo de instrumentation.
       * @param {*} request Valor de request utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      startIncomingSpanHook          : (request) => ({ 'http.route': normalizeRoute(request.url) }),
      /**
       * Ejecuta startOutgoingSpanHook dentro del flujo de instrumentation.
       * @param {*} request Valor de request utilizado por esta operación.
       * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      startOutgoingSpanHook          : (request) => ({ 'http.route': normalizeRoute(request.path || '/') }),
    }),
    new ExpressInstrumentation({
      ignoreLayersType : ['middleware', 'router'],
      /**
       * Ejecuta spanNameHook dentro del flujo de instrumentation.
       * @param {*} info Valor de info utilizado por esta operación.
       * @returns {string} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      spanNameHook     : (info) => `express ${normalizeRoute(info.route)}`,
      /**
       * Ejecuta requestHook dentro del flujo de instrumentation.
       * @param {*} span Valor de span utilizado por esta operación.
       * @param {*} info Valor de info utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      requestHook      : (span, info) => span.setAttribute('http.route', normalizeRoute(info.route)),
    }),
    new AmqplibInstrumentation({
      consumeTimeoutMs   : 300000,
      useLinksForConsume : false,
      /**
       * Ejecuta publishHook dentro del flujo de instrumentation.
       * @param {*} span Valor de span utilizado por esta operación.
       * @param {*} info Valor de info utilizado por esta operación.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      publishHook        : (span, info) => {
        const publicationId = info.options?.headers?.['x-publication-id'];
        if (
          info.isConfirmChannel &&
          typeof trackPublication === 'function' &&
          typeof publicationId === 'string' &&
          publicationId.length <= 128
        )
          trackPublication(publicationId, ownPublicationSpan(span));
      },
      /**
       * Ejecuta publishConfirmHook dentro del flujo de instrumentation.
       * @param {*} ignoredSpan Valor de ignoredSpan utilizado por esta operación.
       * @param {*} info Valor de info utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      publishConfirmHook : (ignoredSpan, info) =>
        completePublication?.(info.options?.headers?.['x-publication-id'], {
          outcome : info.confirmError ? 'error' : 'published',
          ...(info.confirmError ? { code: 'PUBLISH_REJECTED' } : {}),
        }),
      /**
       * Ejecuta consumeEndHook dentro del flujo de instrumentation.
       * @param {*} span Valor de span utilizado por esta operación.
       * @param {*} info Valor de info utilizado por esta operación.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      consumeEndHook     : (span, info) => {
        span.setAttribute('messaging.operation.name', info.endOperation);
        if (info.rejected || info.endOperation === 'instrumentation timeout') {
          span.setAttribute(
            'error.type',
            info.endOperation === 'instrumentation timeout'
              ? 'DEADLINE_EXCEEDED'
              : 'HANDLER_FAILED',
          );
        }
      },
    }),
    new MongoDBInstrumentation({
      requireParentSpan         : true,
      enhancedDatabaseReporting : false,
      /**
       * Ejecuta dbStatementSerializer dentro del flujo de instrumentation.
       * @returns {string} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      dbStatementSerializer     : () => '',
    }),
    new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    new RuntimeNodeInstrumentation({ monitoringPrecision: 100 }),
  ].map(
    /**
     * Proyecta cada elemento en la estructura requerida por la operación.
     * @param {*} instrumentation Valor de instrumentation utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    (instrumentation) => protectInstrumentation(instrumentation, normalizeRoute),
  );
}

module.exports = { createInstrumentations };
