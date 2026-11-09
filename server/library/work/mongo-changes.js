/** @file Despierta trabajadores mediante Change Streams sin conservar cargas de negocio en memoria. */
'use strict';
const { WakeSignal } = require('../messaging/wake-signal');

/**
 * Abre un cursor antes de reconciliar pendientes; una discontinuidad repite esa secuencia.
 * @param {Object} options Conexión Mongoose compartida, colecciones y logger seguro.
 * @returns {Object} Fuente cancelable con disponibilidad explícita; no tiene fallback a polling.
 */
function createMongoChanges({
  connection,
  collections,
  updateFields = [],
  logger,
  component,
  retryMs = 1000,
}) {
  if (!collections?.length) throw new TypeError('WORK_COLLECTIONS_REQUIRED');
  const fieldPattern = updateFields.length
    ? `^(${updateFields
        .map(
          /** @param {string} field Campo raíz registrado por el trabajador. @returns {string} Patrón literal, incluyendo cambios posicionales de arreglos. */
          (field) => field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('|')})(\\.|$)`
    : null;
  const signal       = new WakeSignal();
  let controller;
  let ready = false,
    stream,
    task,
    changed;
  /** @returns {Promise<void>} Consume el cursor nativo y reconstruye sólo ante fallos reales. */
  async function run() {
    while (!controller.signal.aborted) {
      try {
        stream = connection.db.watch(
          [
            {
              $match : {
                $or : [
                  { 'ns.coll': { $in: collections } },
                  { operationType: { $in: ['invalidate', 'dropDatabase'] } },
                ],
              },
            },
            {
              // Inserciones, bajas y cambios estructurales conservan siempre su señal.
              $match : fieldPattern
                ? {
                    $or : [
                      { operationType: { $ne: 'update' } },
                      {
                        $expr : {
                          $anyElementTrue : [
                            {
                              $map : {
                                input : {
                                  $concatArrays : [
                                    {
                                      $map : {
                                        input : {
                                          $objectToArray : {
                                            $ifNull : ['$updateDescription.updatedFields', {}],
                                          },
                                        },
                                        as    : 'field',
                                        in    : '$$field.k',
                                      },
                                    },
                                    { $ifNull: ['$updateDescription.removedFields', []] },
                                    {
                                      $map : {
                                        input : {
                                          $ifNull : ['$updateDescription.truncatedArrays', []],
                                        },
                                        as    : 'array',
                                        in    : '$$array.field',
                                      },
                                    },
                                  ],
                                },
                                as    : 'name',
                                in    : {
                                  $regexMatch : {
                                    input : '$$name',
                                    regex : fieldPattern,
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }
                : {},
            },
            {
              $project : {
                _id           : 1,
                operationType : 1,
                ns            : 1,
                documentKey   : 1,
              },
            },
          ],
          { maxAwaitTimeMS: 1000 },
        );
        // tryNext establece realmente el cursor. La recuperación canónica posterior cubre
        // lo anterior a este límite, y el cursor conserva todos los cambios siguientes.
        const first = await stream.tryNext();
        if (controller.signal.aborted) break;
        check(first);
        ready = true;
        changed();
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          check(event);
          changed(event);
        }
        if (!controller.signal.aborted) throw new Error('WORK_STREAM_CLOSED');
      } catch {
        if (!controller.signal.aborted) {
          ready = false;
          changed();
          logger.error({
            component,
            event : 'work_change_stream_unavailable',
          });
        }
      } finally {
        ready = false;
        await stream?.close().catch(
          /** @returns {void} El cursor fallido se reemplaza antes de volver a reclamar trabajo. */
          () => {},
        );
        stream = null;
      }
      if (!controller.signal.aborted)
        await signal.wait(signal.version, {
          signal     : controller.signal,
          deadlineAt : Date.now() + retryMs,
        });
    }
  }
  /** @param {Object|null} event Metadatos del cursor. @returns {void} Interrumpe ante cambios estructurales. */
  function check(event) {
    if (['invalidate', 'drop', 'dropDatabase', 'rename'].includes(event?.operationType)) {
      throw new Error('WORK_STREAM_INVALIDATED');
    }
  }
  return {
    /** @returns {boolean} Sólo un cursor abierto habilita reclamaciones. */
    get ready() {
      return ready;
    },
    /** @param {Function} onChange Señal del consumidor. @returns {void} Arranca una sola tarea. */
    start(onChange) {
      if (task) return;
      controller = new AbortController();
      changed = onChange;
      task = run();
    },
    /** @returns {Promise<void>} Libera el cursor, sin cerrar MongoDB compartido. */
    async close() {
      if (!task) return;
      ready = false;
      controller.abort();
      changed?.();
      await stream?.close();
      await task;
      task = undefined;
    },
  };
}
module.exports = { createMongoChanges };
