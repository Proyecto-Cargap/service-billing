/** @file Estadísticas y activación del outbox derivadas de cambios confirmados de MongoDB. */
'use strict';
const { PersistenceFeed } = require('./persistence-feed');
module.exports = {
  /** @returns {Object} Describe una proyección todavía desconocida. */
  _newStatsMetadata() {
    return {
      status        : 'pending',
      updatedAt     : null,
      lastAttemptAt : null,
      durationMs    : null,
      errorCode     : null,
      inFlight      : false,
    };
  },
  /** @returns {Promise<void>} Comparte una única suscripción de persistencia por runtime. */
  _statsLoop() {
    if (this.statsTask) return this.statsTask;
    this.persistenceFeed = new PersistenceFeed({
      connection : this.dbConnection,
      scope      : this.store.scope,
      retryMs    : this.config.reconnectMinMs,
      /** @param {string} [kind] Colección afectada o cambio de disponibilidad. @returns {void} Despierta sólo ante trabajo propio o recuperación. */
      onChange   : (kind) => {
        if (!kind || kind === 'outbox') this.outboxSignal.notify();
        this.changes.emit('change');
      },
      /** @param {Error} error Fallo técnico del stream. @returns {void} Expone indisponibilidad sin inventar estadísticas. */
      onError    : (error) => {
        this._count('persistenceStreamErrors');
        this._log('persistence-stream-unavailable', {
          code : error.code || 'CHANGE_STREAM_UNAVAILABLE',
        });
      },
    });
    this.statsTask = this.persistenceFeed.start();
    return this.statsTask;
  },
  /** @returns {Object} Obtiene contadores en memoria sin consultas periódicas. */
  _persistenceSnapshot() {
    const feed     = this.persistenceFeed;
    const value    = feed?.snapshot();
    const ready    = feed?.ready === true && !this.stopping;
    const metadata = {
      status        : this.stopping ? 'stopped' : ready ? 'ready' : 'pending',
      updatedAt     : feed?.updatedAt || null,
      lastAttemptAt : feed?.updatedAt || null,
      durationMs    : null,
      errorCode     : ready ? null : 'CHANGE_STREAM_UNAVAILABLE',
      inFlight      : !ready && !this.stopping,
      stale         : !ready,
    };
    return {
      outbox             : value?.outbox || null,
      inbox              : value?.inbox || null,
      failures           : value?.failures || null,
      oldestPendingAt    : value?.oldestPendingAt || null,
      oldestPendingAgeMs : value?.oldestPendingAgeMs ?? null,
      statsMetadata      : {
        historical  : { ...metadata },
        operational : { ...metadata },
      },
    };
  },
};
