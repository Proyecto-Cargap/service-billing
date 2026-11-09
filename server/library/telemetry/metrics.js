/**
 * @file Catálogo técnico de proceso, dependencias y mensajería; los snapshots acumulados no se vuelven a sumar.
 * Biblioteca autónoma de observabilidad técnica para aplicaciones Node.js.
 */
'use strict';
const { safeAttributes } = require('./privacy');
const COUNTERS           = [
  'accepted',
  'published',
  'processed',
  'duplicates',
  'retries',
  'handlerFailures',
  'unacknowledgedFailures',
  'invalidMessages',
  'persistenceErrors',
  'failedPublications',
  'connections',
  'disconnects',
  'rpcCompleted',
  'rpcErrors',
  'rpcUncertain',
  'rpcTimeouts',
  'lostReplies',
];
const STATES             = [
  'pending',
  'publishing',
  'published',
  'failed',
  'processing',
  'completed',
  'retry',
  'uncertain',
  'resolved',
  'open',
  'replayed',
  'busy',
  'claimed',
  'queued',
  'waiting',
];
const GAUGES             = ['pendingRequests', 'processing', 'pendingConfirms', 'pendingAcceptances'];

/** Filtra dimensiones antes de agregarlas, incluidas métricas automáticas de HTTP y V8.
 * @param {*} attributes Valor de attributes utilizado por esta operación.
 * @param {*} normalize Valor de normalize utilizado por esta operación.
 * @param {*} [healthComponents] Valor de healthComponents utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function metricAttributes(attributes, normalize, healthComponents = ['database', 'messaging']) {
  const result  = safeAttributes(attributes, normalize);
  const allowed = {
    component                : healthComponents,
    counter                  : COUNTERS,
    state                    : STATES,
    queue                    : GAUGES,
    collection               : ['outbox', 'inbox', 'failures'],
    snapshot                 : ['historical', 'operational'],
    scope                    : ['shared'],
    'cpu.mode'               : ['user', 'system'],
    'v8js.gc.type'           : ['minor', 'major', 'incremental', 'weakcb'],
    'nodejs.gc.type'         : ['minor', 'major', 'incremental', 'weakcb'],
    'v8js.heap.space.name'   : [
      'new_space',
      'old_space',
      'code_space',
      'map_space',
      'large_object_space',
      'code_large_object_space',
      'new_large_object_space',
      'read_only_space',
      'shared_space',
      'shared_large_object_space',
      'trusted_space',
      'trusted_large_object_space',
    ],
    'nodejs.eventloop.state' : ['idle', 'active'],
  };
  for (const [key, values] of Object.entries(allowed))
    if (values.includes(attributes?.[key])) result[key] = attributes[key];
  return result;
}

/** Registra instrumentos de sólo lectura y observa la salud sin intervenir en readiness.
 * @param {*} meter Valor de meter utilizado por esta operación.
 * @param {*} runtime Valor de runtime utilizado por esta operación.
 * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function registerMetrics(meter, runtime) {
  const counters      = meter.createObservableCounter('telemetry.messaging.operations', {
    description : 'Contadores acumulados de este proceso.',
    unit        : '{operation}',
  });
  const work          = meter.createObservableGauge('telemetry.messaging.pending', {
    description : 'Trabajo local pendiente.',
    unit        : '{operation}',
  });
  const buffered      = meter.createObservableGauge('telemetry.messaging.buffered', { unit: 'By' });
  const health        = meter.createObservableGauge('telemetry.dependency.ready', {
    description : '1 disponible; 0 no disponible.',
    unit        : '1',
  });
  const persistence   = meter.createObservableGauge('telemetry.messaging.persistence.records', {
    description : 'Snapshot compartido por servicio: agregar con MAX entre instancias, nunca SUM.',
    unit        : '{record}',
  });
  const oldest        = meter.createObservableGauge('telemetry.messaging.persistence.oldest_pending', {
    description : 'Antigüedad compartida: agregar con MAX entre instancias.',
    unit        : 's',
  });
  const snapshotAge   = meter.createObservableGauge('telemetry.messaging.persistence.snapshot_age', {
    description :
      'Edad de la última muestra válida de esta instancia; ausente si aún es desconocida.',
    unit        : 's',
  });
  const snapshotFresh = meter.createObservableGauge(
    'telemetry.messaging.persistence.snapshot_fresh',
    {
      description : '1 muestra vigente; 0 desconocida, fallida o vencida. No determina readiness.',
      unit        : '1',
    },
  );
  const cpu           = meter.createObservableCounter('telemetry.process.cpu.time', { unit: 's' });
  const memory        = meter.createObservableGauge('telemetry.process.memory.rss', { unit: 'By' });
  const uptime        = meter.createObservableGauge('telemetry.process.uptime', { unit: 's' });
  const duration      = meter.createHistogram('telemetry.messaging.operation.duration', {
    unit   : 's',
    advice : { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60] },
  });
  const instruments   = [
    counters,
    work,
    buffered,
    health,
    persistence,
    oldest,
    snapshotAge,
    snapshotFresh,
    cpu,
    memory,
    uptime,
  ];
  /**
   * Ejecuta callback dentro del flujo de metrics.
   * @param {*} result Valor de result utilizado por esta operación.
   * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  const callback      = async (result) => {
    if (runtime.state !== 'started') return;
    const usage = process.cpuUsage();
    result.observe(cpu, usage.user / 1e6, { 'cpu.mode': 'user' });
    result.observe(cpu, usage.system / 1e6, { 'cpu.mode': 'system' });
    result.observe(memory, process.memoryUsage().rss);
    result.observe(uptime, process.uptime());
    if (!runtime.messaging && !runtime.healthCheck) return;
    if (runtime.messaging) {
      try {
        const snapshot = runtime.messaging.getStats();
        for (const counter of COUNTERS)
          result.observe(counters, finite(snapshot[counter]), { counter });
        for (const queue of GAUGES) result.observe(work, finite(snapshot[queue]), { queue });
        result.observe(buffered, finite(snapshot.bufferedBytes));
        if (snapshot.persistence) {
          const metadata = snapshot.persistence.statsMetadata;
          /**
           * Ejecuta sampled dentro del flujo de metrics.
           * @param {*} kind Valor de kind utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          const sampled  = (kind) => Number.isFinite(Date.parse(metadata?.[kind]?.updatedAt));
          for (const collection of ['outbox', 'inbox', 'failures']) {
            const counts = snapshot.persistence[collection];
            if (!counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
            for (const state of STATES) {
              const kind =
                collection === 'outbox' && ['pending', 'publishing'].includes(state)
                  ? 'operational'
                  : 'historical';
              if (metadata && !sampled(kind)) continue;
              const value = Object.hasOwn(counts, state) ? counts[state] : 0;
              if (!Number.isFinite(value) || value < 0) continue;
              result.observe(persistence, value, {
                collection,
                state,
                scope : 'shared',
              });
            }
          }
          const age = snapshot.persistence.oldestPendingAgeMs;
          if ((!metadata || sampled('operational')) && Number.isFinite(age) && age >= 0)
            result.observe(oldest, age / 1000, { scope: 'shared' });
          if (metadata) {
            for (const kind of ['historical', 'operational']) {
              const known = sampled(kind);
              if (known)
                result.observe(
                  snapshotAge,
                  Math.max(0, Date.now() - Date.parse(metadata[kind].updatedAt)) / 1000,
                  { snapshot: kind },
                );
              result.observe(snapshotFresh, known && metadata[kind].stale === false ? 1 : 0, {
                snapshot : kind,
              });
            }
          }
        }
      } catch {
        /* La ausencia de estadísticas no oculta una comprobación independiente de salud. */
      }
    }
    let status;
    try {
      status = runtime.healthCheck
        ? await runtime.observer.suppress(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => runtime.healthCheck(),
          )
        : runtime.messaging?.getHealth();
    } catch {
      /* Los componentes declarados no están disponibles cuando falla la comprobación. */
    }
    for (const component of runtime.healthComponents) {
      result.observe(health, status?.[component] === 'ready' ? 1 : 0, { component });
    }
  };
  meter.addBatchObservableCallback(callback, instruments);
  return {
    duration,

    /**
     * Retira el recurso indicado.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    remove : () => meter.removeBatchObservableCallback(callback, instruments),
  };
}

/** Normaliza mediciones defectuosas sin exponer objetos recibidos.
 * @param {*} value Valor de value utilizado por esta operación.
 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

module.exports = {
  registerMetrics,
  metricAttributes,
};
