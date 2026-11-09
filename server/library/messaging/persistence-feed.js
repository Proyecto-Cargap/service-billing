/** @file Proyección de estados y vencimientos de Messaging alimentada por Change Streams. */
'use strict';

const { WakeSignal } = require('./wake-signal');
const COLLECTIONS    = Object.freeze({
  messaging_v1_outbox   : 'outbox',
  messaging_v1_inbox    : 'inbox',
  messaging_v1_failures : 'failures',
});

/** Mantiene únicamente metadatos técnicos; nunca conserva mensajes ni credenciales. */
class PersistenceFeed {
  /** @param {Object} options Conexión, ámbito y notificación de cambios o indisponibilidad. */
  constructor({ connection, scope, onChange, onError, retryMs = 1000 }) {
    this.connection = connection;
    this.scope = scope;
    this.onChange = onChange;
    this.onError = onError;
    this.retryMs = retryMs;
    this.signal = new WakeSignal();
    this.controller = new AbortController();
    this.rows = new Map();
    this.pendingOutbox = new Map();
    this.counts = {
      outbox   : {},
      inbox    : {},
      failures : {},
    };
    this.ready = false;
    this.closed = false;
  }

  /** @returns {Promise<void>} Inicializa una instantánea coherente y consume los cambios posteriores. */
  async start() {
    if (this.task) return this.task;
    this.task = this.run();
    return this.task;
  }

  /** @returns {Promise<void>} Recupera sólo ante errores reales del stream; no sondea colecciones. */
  async run() {
    while (!this.closed) {
      try {
        await this.open();
        if (this.closed) break;
        this.ready = true;
        this.changed();
        for await (const event of this.stream) {
          if (this.closed) break;
          if (event.clusterTime?.compare(this.snapshotTime) <= 0) continue;
          if (['invalidate', 'drop', 'dropDatabase', 'rename'].includes(event.operationType))
            throw new Error('MESSAGING_CHANGE_STREAM_INVALIDATED');
          this.apply(event);
        }
        if (!this.closed) throw new Error('MESSAGING_CHANGE_STREAM_CLOSED');
      } catch (error) {
        if (!this.closed) {
          this.ready = false;
          this.onError(error);
          this.changed();
        }
      } finally {
        await this.stream?.close().catch(
          /** @returns {void} El siguiente arranque reconstruye el cursor que falló. */
          () => {},
        );
        this.stream = null;
      }
      if (!this.closed)
        await this.signal.wait(this.signal.version, {
          signal     : this.controller.signal,
          deadlineAt : Date.now() + this.retryMs,
        });
    }
  }

  /** @returns {Promise<void>} Lee los metadatos a un mismo tiempo snapshot y abre desde ese límite. */
  async open() {
    const session = await this.connection.startSession({ snapshot: true });
    this.rows.clear();
    this.pendingOutbox.clear();
    this.counts = {
      outbox   : {},
      inbox    : {},
      failures : {},
    };
    try {
      for (const [collection, kind] of Object.entries(COLLECTIONS)) {
        const cursor = this.connection.db.collection(collection).find(this.scope, {
          session,
          signal         : this.controller.signal,
          readPreference : 'primary',
          projection     : {
            _id         : 1,
            status      : 1,
            createdAt   : 1,
            availableAt : 1,
            leaseUntil  : 1,
          },
        });
        try {
          for await (const row of cursor) {
            if (this.closed) return;
            this.put(kind, row);
          }
        } finally {
          await cursor.close();
        }
      }
      if (!session.snapshotTime) throw new Error('MESSAGING_SNAPSHOT_TIME_REQUIRED');
      this.snapshotTime = session.snapshotTime;
      this.stream = this.connection.db.watch(
        [
          {
            $match : {
              $or : [
                { 'ns.coll': { $in: Object.keys(COLLECTIONS) } },
                { operationType: { $in: ['invalidate', 'dropDatabase'] } },
              ],
            },
          },
          {
            $match : {
              $or : [
                { operationType: { $ne: 'insert' } },
                {
                  'fullDocument.namespace' : this.scope.namespace,
                  'fullDocument.service'   : this.scope.service,
                },
              ],
            },
          },
          {
            $project : {
              _id                                           : 1,
              operationType                                 : 1,
              clusterTime                                   : 1,
              ns                                            : 1,
              documentKey                                   : 1,
              'fullDocument._id'                            : 1,
              'fullDocument.namespace'                      : 1,
              'fullDocument.service'                        : 1,
              'fullDocument.status'                         : 1,
              'fullDocument.createdAt'                      : 1,
              'fullDocument.availableAt'                    : 1,
              'fullDocument.leaseUntil'                     : 1,
              'updateDescription.updatedFields.status'      : 1,
              'updateDescription.updatedFields.createdAt'   : 1,
              'updateDescription.updatedFields.availableAt' : 1,
              'updateDescription.updatedFields.leaseUntil'  : 1,
              'updateDescription.removedFields'             : {
                $filter : {
                  input : { $ifNull: ['$updateDescription.removedFields', []] },
                  as    : 'field',
                  cond  : { $in: ['$$field', ['status', 'createdAt', 'availableAt', 'leaseUntil']] },
                },
              },
            },
          },
        ],
        {
          startAtOperationTime : this.snapshotTime,
        },
      );
    } finally {
      await session.endSession();
    }
  }

  /** @param {string} kind Colección lógica. @param {Object} row Metadatos del documento. @returns {boolean} Actualiza sólo cambios de estado o vencimiento. */
  put(kind, row) {
    const key      = `${kind}:${row._id}`;
    const previous = this.rows.get(key);
    const value    = {
      kind,
      status      : row.status,
      createdAt   : row.createdAt,
      availableAt : row.availableAt,
      leaseUntil  : row.leaseUntil,
    };
    if (
      previous &&
      Object.keys(value).every(
        /** @param {string} field Campo técnico. @returns {boolean} Compara fechas por valor, no por referencia. */
        (field) => previous[field]?.valueOf() === value[field]?.valueOf(),
      )
    )
      return false;
    if (previous?.status) this.counts[kind][previous.status]--;
    this.rows.set(key, value);
    if (kind === 'outbox' && ['pending', 'publishing'].includes(value.status))
      this.pendingOutbox.set(key, value);
    else this.pendingOutbox.delete(key);
    if (value.status) this.counts[kind][value.status] = (this.counts[kind][value.status] || 0) + 1;
    return true;
  }

  /** @param {Object} event Cambio confirmado de MongoDB. @returns {void} Aplica sólo estados del ámbito propio. */
  apply(event) {
    const kind = COLLECTIONS[event.ns?.coll];
    if (!kind) return;
    const key      = `${kind}:${event.documentKey?._id}`;
    const previous = this.rows.get(key);
    if (event.operationType === 'delete') {
      if (!previous) return;
      if (previous.status) this.counts[kind][previous.status]--;
      this.rows.delete(key);
      this.pendingOutbox.delete(key);
    } else if (event.operationType === 'update') {
      // El ámbito es inmutable: el snapshot o el insert anterior ya acreditaron la identidad.
      if (!previous) return;
      const row = {
        ...previous,
        _id : event.documentKey._id,
      };
      for (const field of ['status', 'createdAt', 'availableAt', 'leaseUntil']) {
        if (Object.hasOwn(event.updateDescription?.updatedFields || {}, field))
          row[field] = event.updateDescription.updatedFields[field];
        if (event.updateDescription?.removedFields?.includes(field)) delete row[field];
      }
      if (!this.put(kind, row)) return;
    } else {
      const row = event.fullDocument;
      if (!row || row.namespace !== this.scope.namespace || row.service !== this.scope.service) {
        if (!previous) return;
        if (previous.status) this.counts[kind][previous.status]--;
        this.rows.delete(key);
        this.pendingOutbox.delete(key);
      } else if (!this.put(kind, row)) return;
    }
    this.changed(kind);
  }

  /** @param {string} [kind] Colección afectada; ausente al cambiar disponibilidad. @returns {void} Notifica cambios técnicos pertinentes. */
  changed(kind) {
    this.updatedAt = new Date().toISOString();
    this.signal.notify();
    this.onChange(kind);
  }

  /** @returns {number|undefined} Próximo trabajo pendiente o arrendamiento recuperable conocido. */
  nextOutboxAt() {
    let next = Infinity;
    for (const row of this.pendingOutbox.values()) {
      const value =
        row.status === 'pending'
          ? row.availableAt
          : row.status === 'publishing'
            ? row.leaseUntil
            : null;
      if (value) next = Math.min(next, new Date(value).getTime());
    }
    return Number.isFinite(next) ? next : undefined;
  }

  /** @returns {Object} Copia de cantidades y antigüedad sin consultas a persistencia. */
  snapshot() {
    let oldestPendingAt = null;
    for (const row of this.pendingOutbox.values()) {
      if (row.kind === 'outbox' && ['pending', 'publishing'].includes(row.status) && row.createdAt)
        if (!oldestPendingAt || row.createdAt < oldestPendingAt) oldestPendingAt = row.createdAt;
    }
    return {
      outbox             : {
        pending    : 0,
        publishing : 0,
        ...this.counts.outbox,
      },
      inbox              : { ...this.counts.inbox },
      failures           : { ...this.counts.failures },
      oldestPendingAt,
      oldestPendingAgeMs : oldestPendingAt
        ? Math.max(0, Date.now() - new Date(oldestPendingAt).getTime())
        : 0,
    };
  }

  /** @returns {Promise<void>} Cancela la suscripción y libera la proyección en memoria. */
  async close() {
    this.closed = true;
    this.ready = false;
    this.controller.abort();
    this.signal.notify();
    await this.stream?.close();
    await this.task;
    this.rows.clear();
    this.pendingOutbox.clear();
  }
}

module.exports = { PersistenceFeed };
