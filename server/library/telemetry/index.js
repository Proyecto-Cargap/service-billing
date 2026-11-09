/**
 * @file Fábrica independiente de telemetría técnica; importar o construir no activa el SDK ni abre conexiones.
 * Biblioteca autónoma de observabilidad técnica para aplicaciones Node.js.
 */
'use strict';
const { randomUUID } = require('node:crypto');
const {
  createRouteNormalizer,
  safeLog,
  sanitizeSpan,
  safeSpanContext,
  OPERATIONS,
  OUTCOMES,
  KINDS,
  CODES,
} = require('./privacy');
const { registerMetrics, metricAttributes } = require('./metrics');
const VERSION                               = '2.2.1';
const NO_OPERATION                          = Object.freeze({
  /**
   * Ejecuta run dentro del flujo de index.
   * @param {Function} callback Operación que se invoca durante el procesamiento.
   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  run : (callback) => callback(),

  /**
   * Ofrece el punto de extensión end sin efectos por defecto.
   * @returns {void} Finaliza después de aplicar los efectos de la operación.
   */
  end() {},
});

/**
 * Construye una instancia con configuración e identidad explícitas. Los exportadores inyectables permiten
 * verificar el contrato sin conectarse a infraestructura; el uso normal configura OTLP HTTP/protobuf.
 * @param {Object} options Identidad, ambiente y opciones técnicas.
 * @returns {Object} Fachada de ciclo de vida, logger y observador técnico.
 */
function createTelemetry(options = {}) {
  const env          = options.env || process.env;
  const normalize    = createRouteNormalizer(options.routeTemplates);
  const runtime      = {
    state            : 'new',
    messaging        : null,
    healthCheck      : null,
    healthComponents : ['database', 'messaging'],
  };
  const publications = new Map();
  let sdk,
    api,
    core,
    tracer,
    log,
    instruments,
    processors    = [],
    registrations = [],
    closing;
  const logger = {};
  for (const [name, severity] of [
    ['debug', 5],
    ['info', 9],
    ['warn', 13],
    ['error', 17],
  ]) {
    /**
     * Ejecuta name dentro del flujo de index.
     * @param {*} record Valor de record utilizado por esta operación.
     * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    logger[name] = (record) => {
      if (runtime.state !== 'started') return;
      try {
        const entry   = safeLog(record);
        const active  = api.trace.getSpanContext(api.context.active());
        const context = active
          ? api.trace.setSpanContext(api.ROOT_CONTEXT, safeSpanContext(active))
          : api.ROOT_CONTEXT;
        log.emit({
          ...entry,
          severityNumber : severity,
          severityText   : name.toUpperCase(),
          context,
        });
      } catch {
        /* Un registro técnico nunca interrumpe la operación observada. */
      }
    };
  }
  const observer = {
    /** Finaliza el mismo span PRODUCER automático ante confirmación, retorno o timeout del publicador.
     * @param {*} publicationId Valor de publicationId utilizado por esta operación.
     * @param {*} [result] Valor de result utilizado por esta operación.
     * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    completePublication(publicationId, result = {}) {
      const span = publications.get(publicationId);
      if (!span) return;
      publications.delete(publicationId);
      try {
        if (result.outcome === 'error') {
          span.setAttribute('error.type', CODES.has(result.code) ? result.code : 'INTERNAL_ERROR');
          span.setStatus({ code: api.SpanStatusCode.ERROR });
        }
      } finally {
        span.end();
      }
    },
    /** Serializa exclusivamente el contexto W3C activo, incluso cuando la traza no fue muestreada.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    captureCarrier() {
      if (runtime.state !== 'started') return null;
      try {
        const carrier = {};
        core.propagator.inject(api.context.active(), carrier, api.defaultTextMapSetter);
        return carrier.traceparent ? carrier : null;
      } catch {
        return null;
      }
    },
    /** Restaura cada mensaje sobre una raíz limpia para no mezclar solicitudes concurrentes.
     * @param {*} carrier Valor de carrier utilizado por esta operación.
     * @param {Function} callback Operación que se invoca durante el procesamiento.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    runWithCarrier(carrier, callback) {
      if (runtime.state !== 'started') return callback();
      const context = core.propagator.extract(
        api.ROOT_CONTEXT,
        carrier || {},
        api.defaultTextMapGetter,
      );
      return api.context.with(context, callback);
    },
    /** Suprime consultas de mantenimiento y elimina contexto accidental del worker.
     * @param {Function} callback Operación que se invoca durante el procesamiento.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    suppress(callback) {
      if (runtime.state !== 'started') return callback();
      return api.context.with(core.suppressTracing(api.ROOT_CONTEXT), callback);
    },
    /** Crea una operación técnica sin observar el payload ni el resultado funcional.
     * @param {*} kind Valor de kind utilizado por esta operación.
     * @param {*} [metadata] Valor de metadata utilizado por esta operación.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    beginOperation(kind, metadata = {}) {
      if (runtime.state !== 'started' || !OPERATIONS.has(kind)) return NO_OPERATION;
      try {
        const attributes = { operation: kind };
        if (KINDS.has(metadata.messageKind))
          attributes['messaging.message.type'] = metadata.messageKind;
        const parent    = api.context.active();
        const span      = tracer.startSpan(
          `messaging.${kind}`,
          {
            kind : api.SpanKind.INTERNAL,
            attributes,
          },
          parent,
        );
        const context   = api.trace.setSpan(parent, span);
        const startedAt = performance.now();
        let ended       = false;
        return {
          /**
           * Ejecuta run dentro del flujo de index.
           * @param {Function} callback Operación que se invoca durante el procesamiento.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          run : (callback) => api.context.with(context, callback),
          /**
           * Ejecuta end dentro del flujo de index.
           * @param {*} [result] Valor de result utilizado por esta operación.
           * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          end(result = {}) {
            if (ended) return;
            ended = true;
            try {
              const outcome        = OUTCOMES.has(result.outcome) ? result.outcome : 'completed';
              const classification = {
                ...attributes,
                outcome,
              };
              if (outcome === 'error') {
                classification['error.type'] = CODES.has(result.code)
                  ? result.code
                  : 'INTERNAL_ERROR';
                span.setStatus({ code: api.SpanStatusCode.ERROR });
              }
              span.setAttributes(classification);
              instruments.duration.record(
                (performance.now() - startedAt) / 1000,
                classification,
                context,
              );
            } finally {
              span.end();
            }
          },
        };
      } catch {
        return NO_OPERATION;
      }
    },
  };
  runtime.observer = observer;
  const facade = {
    logger,
    observer,
    /**
     * Ejecuta state dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    get state() {
      return runtime.state;
    },
    /** Arranca una sola vez antes de importar HTTP/Express, drivers y clientes.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    start() {
      if (runtime.state !== 'new') return facade;
      if (String(env.OTEL_SDK_DISABLED).toLowerCase() === 'true') {
        runtime.state = 'disabled';
        return facade;
      }
      try {
        for (const signal of ['', '_TRACES', '_METRICS', '_LOGS']) {
          const protocol = env[`OTEL_EXPORTER_OTLP${signal}_PROTOCOL`];
          if (protocol && protocol !== 'http/protobuf')
            throw new Error('INVALID_TELEMETRY_PROTOCOL');
        }
        api = require('@opentelemetry/api');
        const { W3CTraceContextPropagator, suppressTracing } = require('@opentelemetry/core');
        core = {
          propagator : new W3CTraceContextPropagator(),
          suppressTracing,
        };
        const { NodeSDK }                                 = require('@opentelemetry/sdk-node');
        const { resourceFromAttributes, defaultResource } = require('@opentelemetry/resources');
        const { BatchSpanProcessor }                      = require('@opentelemetry/sdk-trace');
        const { BatchLogRecordProcessor }                 = require('@opentelemetry/sdk-logs');
        const { PeriodicExportingMetricReader }           = require('@opentelemetry/sdk-metrics');
        const { OTLPTraceExporter }                       = require('@opentelemetry/exporter-trace-otlp-proto');
        const { OTLPLogExporter }                         = require('@opentelemetry/exporter-logs-otlp-proto');
        const { OTLPMetricExporter }                      = require('@opentelemetry/exporter-metrics-otlp-proto');
        const traceExporter                               =
          options.exporters?.traces || new OTLPTraceExporter(exportOptions(env, 'TRACES'));
        const logsExporter                                =
          options.exporters?.logs || new OTLPLogExporter(exportOptions(env, 'LOGS'));
        const metricExporter                              =
          options.exporters?.metrics || new OTLPMetricExporter(exportOptions(env, 'METRICS'));
        const spanProcessor                               = new BatchSpanProcessor({
          exporter             : safeTraceExporter(traceExporter, normalize),
          maxQueueSize         : 2048,
          maxExportBatchSize   : 256,
          scheduledDelayMillis : 1000,
          exportTimeoutMillis  : 3000,
        });
        const logProcessor                                = new BatchLogRecordProcessor({
          exporter             : logsExporter,
          maxQueueSize         : 2048,
          maxExportBatchSize   : 256,
          scheduledDelayMillis : 1000,
          exportTimeoutMillis  : 3000,
        });
        const interval                                    = boundedNumber(
          options.metricIntervalMs || env.OTEL_METRIC_EXPORT_INTERVAL,
          30000,
          1000,
          3600000,
        );
        const metricReader                                = new PeriodicExportingMetricReader({
          exporter             : metricExporter,
          exportIntervalMillis : interval,
          exportTimeoutMillis  : Math.min(interval, 3000),
        });
        processors = [spanProcessor, logProcessor, metricReader];
        for (const processor of processors) {
          const shutdown = processor.shutdown.bind(processor);
          let shutdownPromise;
          /**
           * Ejecuta shutdown dentro del flujo de index.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          processor.shutdown = () => (shutdownPromise ||= Promise.resolve().then(shutdown));
        }
        const identity = {
          'service.name'                : options.serviceName || env.OTEL_SERVICE_NAME || 'unknown_service',
          'service.version'             : options.serviceVersion || 'unknown',
          'service.instance.id'         : options.instanceId || randomUUID(),
          'deployment.environment.name' : options.environment || 'development',
        };
        if (options.serviceId) identity['service.id'] = options.serviceId;
        registrations =
          options.instrumentations === false
            ? []
            : require('./instrumentation').createInstrumentations({
                /**
                 * Ejecuta trackPublication dentro del flujo de index.
                 * @param {*} publicationId Valor de publicationId utilizado por esta operación.
                 * @param {*} span Valor de span utilizado por esta operación.
                 * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                trackPublication(publicationId, span) {
                  if (typeof publicationId !== 'string' || publicationId.length > 128) return;
                  if (publications.size >= 2048)
                    observer.completePublication(publications.keys().next().value, {
                      outcome : 'error',
                      code    : 'BACKPRESSURE',
                    });
                  publications.set(publicationId, span);
                },
                completePublication : observer.completePublication,
                normalizeRoute      : normalize,
              });
        sdk = new NodeSDK({
          resource            : defaultResource().merge(resourceFromAttributes(identity)),
          autoDetectResources : false,
          sampler             : createSampler(env),
          textMapPropagator   : core.propagator,
          spanLimits          : {
            attributeCountLimit       : 32,
            attributeValueLengthLimit : 256,
            eventCountLimit           : 8,
            linkCountLimit            : 8,
          },
          spanProcessors      : [spanProcessor],
          logRecordProcessors : [logProcessor],
          metricReaders       : [metricReader],
          views               : [
            {
              instrumentName              : '*',
              attributesProcessors        : [
                {
                  /**
                   * Ejecuta process dentro del flujo de index.
                   * @param {*} attributes Valor de attributes utilizado por esta operación.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  process : (attributes) =>
                    metricAttributes(attributes, normalize, runtime.healthComponents),
                },
              ],
              aggregationCardinalityLimit : 256,
            },
          ],
          instrumentations    : registrations,
        });
        // Los diagnósticos del SDK tampoco deben imprimir URLs, headers o errores sin sanear.
        let lastDiagnostic = 0;
        api.diag.setLogger(
          {
            /**
             * Ejecuta error dentro del flujo de index.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            error() {
              if (Date.now() - lastDiagnostic >= 30000) {
                lastDiagnostic = Date.now();
                process.stderr.write('[telemetry] export_failed\n');
              }
            },
            /**
             * Ofrece el punto de extensión warn sin efectos por defecto.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            warn() {},
            /**
             * Ofrece el punto de extensión info sin efectos por defecto.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            info() {},
            /**
             * Ofrece el punto de extensión debug sin efectos por defecto.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            debug() {},
            /**
             * Ofrece el punto de extensión verbose sin efectos por defecto.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            verbose() {},
          },
          api.DiagLogLevel.ERROR,
        );
        sdk.start();
        tracer = api.trace.getTracer('telemetry', VERSION);
        log = require('@opentelemetry/api-logs').logs.getLogger('telemetry', VERSION);
        instruments = registerMetrics(api.metrics.getMeter('telemetry', VERSION), runtime);
        runtime.state = 'started';
        logger.info({
          event     : 'startup',
          component : 'telemetry',
        });
      } catch {
        runtime.state = 'failed';
        process.stderr.write(
          '[telemetry] startup_failed: verify OTEL configuration and dependencies\n',
        );
        for (const instrumentation of registrations) {
          try {
            instrumentation.disable();
          } catch {}
        }
        if (sdk)
          Promise.resolve(sdk.shutdown()).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
      return facade;
    },
    /** Conecta únicamente la fachada técnica común; reemplazarla no duplica observadores.
     * @param {Object} messaging Puerto de mensajería y contexto autenticado.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    attachMessaging(messaging) {
      runtime.messaging = messaging;
      return facade;
    },
    /** Observa un mapa plano de estados técnicos; los componentes son una lista explícita y acotada.
     * @param {*} check Valor de check utilizado por esta operación.
     * @param {Object} [options] Colaboradores u opciones: components.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    attachHealth(check, { components = ['database', 'messaging'] } = {}) {
      runtime.healthCheck = check;
      runtime.healthComponents = [...new Set(Array.isArray(components) ? components : [])]
        .filter(
          /**
           * Determina si el elemento cumple el criterio de selección.
           * @param {*} component Valor de component utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (component) =>
            typeof component === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(component),
        )
        .slice(0, 16);
      return facade;
    },
    /** Fuerza las tres señales de forma independiente, dentro del presupuesto disponible.
     * @param {Object} [options] Colaboradores u opciones: deadlineAt.
     * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    async flush({ deadlineAt = Date.now() + 5000 } = {}) {
      if (runtime.state !== 'started') return;
      await bounded(
        Promise.allSettled(
          processors.map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {*} processor Valor de processor utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (processor) =>
              Promise.resolve().then(
                /**
                 * Procesa el resultado de la operación asíncrona.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                () => processor.forceFlush(),
              ),
          ),
        ),
        deadlineAt,
      );
    },
    /** Cierra una sola vez después del drenaje de mensajería; no instala manejadores de señales.
     * @param {Object} [options] Colaboradores u opciones: deadlineAt.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    close({ deadlineAt = Date.now() + 5000 } = {}) {
      if (closing) return closing;
      closing = (
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async () => {
          if (runtime.state !== 'started') {
            runtime.state = 'closed';
            return;
          }
          logger.info({
            event     : 'shutdown',
            component : 'telemetry',
          });
          for (const publicationId of publications.keys())
            observer.completePublication(publicationId, {
              outcome : 'error',
              code    : 'CONNECTION_LOST',
            });
          for (const instrumentation of registrations) {
            try {
              instrumentation.disable();
            } catch {}
          }
          // NodeSDK.shutdown usa Promise.all; esperamos cada procesador para no finalizar por un rechazo temprano.
          const shutdown = Promise.allSettled(
            processors.map(
              /**
               * Proyecta cada elemento en la estructura requerida por la operación.
               * @param {*} processor Valor de processor utilizado por esta operación.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              (processor) =>
                Promise.resolve().then(
                  /**
                   * Procesa el resultado de la operación asíncrona.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  () => processor.shutdown(),
                ),
            ),
          )
            .then(
              /**
               * Procesa el resultado de la operación asíncrona.
               * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              () => sdk.shutdown(),
            )
            .catch(
              /**
               * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
               * @returns {void} Finaliza después de aplicar los efectos de la operación.
               */
              () => {},
            );
          await bounded(shutdown, Math.min(deadlineAt, Date.now() + 5000));
          instruments.remove();
          runtime.state = 'closed';
        }
      )();
      return closing;
    },
  };
  return facade;
}

/** Mantiene destino, headers y tiempos OTLP dentro de la configuración explícita de cada señal.
 * @param {*} env Valor de env utilizado por esta operación.
 * @param {*} signal Valor de signal utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function exportOptions(env, signal) {
  const base   = env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://127.0.0.1:4318';
  const url    =
    env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] ||
    `${base.replace(/\/$/, '')}/v1/${signal.toLowerCase()}`;
  const parsed = new URL(url);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error('INVALID_TELEMETRY_ENDPOINT');
  const headers    = {};
  const configured =
    env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`] || env.OTEL_EXPORTER_OTLP_HEADERS || '';
  for (const entry of configured.split(',')) {
    const separator = entry.indexOf('=');
    if (separator > 0)
      headers[entry.slice(0, separator).trim()] = decodeURIComponent(
        entry.slice(separator + 1).trim(),
      );
  }
  return {
    url,
    headers,
    timeoutMillis    : boundedNumber(
      env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] || env.OTEL_EXPORTER_OTLP_TIMEOUT,
      3000,
      100,
      3000,
    ),
    concurrencyLimit : 1,
  };
}

/** Aplica el muestreo estándar sin vincularlo a métricas o logs.
 * @param {*} env Valor de env utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function createSampler(env) {
  const {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
    AlwaysOnSampler,
    AlwaysOffSampler,
  } = require('@opentelemetry/sdk-trace');
  const name    = env.OTEL_TRACES_SAMPLER || 'parentbased_traceidratio';
  const ratio   = boundedNumber(env.OTEL_TRACES_SAMPLER_ARG, 1, 0, 1);
  const choices = {
    /**
     * Ejecuta always_on dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    always_on                : () => new AlwaysOnSampler(),
    /**
     * Ejecuta always_off dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    always_off               : () => new AlwaysOffSampler(),
    /**
     * Ejecuta traceidratio dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    traceidratio             : () => new TraceIdRatioBasedSampler(ratio),
    /**
     * Ejecuta parentbased_always_on dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    parentbased_always_on    : () => new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    /**
     * Ejecuta parentbased_always_off dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    parentbased_always_off   : () => new ParentBasedSampler({ root: new AlwaysOffSampler() }),
    /**
     * Ejecuta parentbased_traceidratio dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    parentbased_traceidratio : () =>
      new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
  };
  if (!choices[name]) throw new Error('INVALID_TELEMETRY_SAMPLER');
  return choices[name]();
}

/** Retira datos sensibles incluso cuando una instrumentación futura añade atributos al final.
 * @param {*} exporter Valor de exporter utilizado por esta operación.
 * @param {*} normalize Valor de normalize utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function safeTraceExporter(exporter, normalize) {
  return {
    /**
     * Ejecuta export dentro del flujo de index.
     * @param {*} spans Valor de spans utilizado por esta operación.
     * @param {Function} callback Operación que se invoca durante el procesamiento.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    export(spans, callback) {
      try {
        exporter.export(
          spans.map(
            /**
             * Proyecta cada elemento en la estructura requerida por la operación.
             * @param {*} span Valor de span utilizado por esta operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (span) => sanitizeSpan(span, normalize),
          ),
          callback,
        );
      } catch {
        callback({ code: 1 });
      }
    },
    /**
     * Ejecuta shutdown dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    shutdown   : () => exporter.shutdown(),
    /**
     * Ejecuta forceFlush dentro del flujo de index.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    forceFlush : () => exporter.forceFlush?.() || Promise.resolve(),
  };
}

/** Acota una espera y siempre consume rechazos para no alterar el cierre de la aplicación.
 * @param {*} promise Valor de promise utilizado por esta operación.
 * @param {number} deadlineAt Valor de deadlineAt utilizado por esta operación.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */
async function bounded(promise, deadlineAt) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise(
        /**
         * Coordina la resolución o el rechazo de la operación asíncrona.
         * @param {Function} resolve Continuación que confirma el resultado de la promesa.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        (resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
        },
      ),
    ]);
  } catch {
    /* Los exportadores no forman parte de la disponibilidad funcional. */
  } finally {
    clearTimeout(timer);
  }
}

/** Convierte valores numéricos configurables sin permitir intervalos o tiempos ilimitados.
 * @param {*} value Valor de value utilizado por esta operación.
 * @param {*} fallback Valor de fallback utilizado por esta operación.
 * @param {*} minimum Valor de minimum utilizado por esta operación.
 * @param {number} maximum Valor de maximum utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

module.exports = {
  createTelemetry,
  VERSION,
};
