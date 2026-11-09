/**
 * @file Aceptación persistente de comandos y eventos, publicación confirmada y reprocesamiento de fallos.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const protocol                          = require('./protocol');
const { eventKey }                      = require('./topology');
const { MessagingError, errorMetadata } = require('./errors');
/**
 * Aceptación persistente, entrega confirmada del outbox y reprocesamiento de fallos. Los métodos internos
 * se ejecutan con la instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Construye y persiste el sobre respetando capacidad y contexto transaccional antes de aceptar la
   * operación.
   *
   * @param {string} kind Tipo de mensaje, recurso o selección que procesa la operación.
   * @param {string} name Nombre utilizado para identificar la operación o el recurso.
   * @param {*} payload Contenido de aplicación; el transporte lo conserva sin validar sus reglas de
   * negocio.
   * @param {Object} options Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @param {string} target Servicio o destino al que se dirige la operación.
   * @returns {Promise<Object>} Identidad de mensaje y publicación con estado accepted o staged según la
   * sesión.
   * @throws {Error} La promesa se rechaza
   * ante NOT_AVAILABLE, BACKPRESSURE, TRANSACTION_REQUIRED.
   */
  async _enqueue(kind, name, payload, options, target) {
    const operation = this.observer.beginOperation('accept', { messageKind: kind });
    return operation.run(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async () => {
        try {
          const accepted = await this._accept(kind, name, payload, options, target);
          operation.end({ outcome: accepted.status });
          return accepted;
        } catch (error) {
          operation.end({
            outcome : 'error',
            code    : error instanceof MessagingError ? error.code : 'INTERNAL_ERROR',
          });
          throw error;
        }
      },
    );
  },

  /** Acepta el mensaje sin exponer datos de aplicación al observador.
   * @param {*} kind Valor de kind utilizado por esta operación.
   * @param {string} name Nombre del componente o recurso.
   * @param {*} payload Valor de payload utilizado por esta operación.
   * @param {Object} options Opciones que delimitan el comportamiento de la operación.
   * @param {string} target Valor de target utilizado por esta operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async _accept(kind, name, payload, options, target) {
    if (
      this.stopping &&
      !(
        this.state === 'closing' &&
        this.context.getStore()?.message &&
        Date.now() < this.shutdownDeadline
      )
    )
      throw new MessagingError('NOT_AVAILABLE');
    const envelope = this._envelope(kind, name, payload, options, target);
    const wire     = protocol.encode(envelope).toString();
    const bytes    = Buffer.byteLength(wire);
    if (
      this.pendingAcceptances >= this.config.maxPending ||
      this.bufferedBytes + bytes > this.config.maxBufferedBytes
    )
      throw new MessagingError('BACKPRESSURE', 'Acceptance capacity reached', { retryable: true });
    this.pendingAcceptances++;
    this.bufferedBytes += bytes;
    /**
     * Ejecuta esta fase conservando la recuperación y liberación de recursos definidas por el bloque de
     * errores.
     */
    try {
      await this._waitFor(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => this.store?.ready === true,
        Date.now() + this.config.startTimeoutMs,
      );
      const session = options.session || this.context.getStore()?.session;
      if (session && (typeof session.inTransaction !== 'function' || !session.inTransaction()))
        throw new MessagingError('TRANSACTION_REQUIRED');
      const row = await this.store.enqueueOutbox({
        wire,
        messageId     : envelope.messageId,
        publicationId : options.publicationId,
        session,
        deadlineAt    : envelope.deadlineAt,
        route         :
          kind === 'event'
            ? {
                kind        : 'event',
                destination : eventKey(name, envelope.version),
              }
            : {
                kind        : 'command',
                destination : target,
              },
      });
      this._count('accepted');
      return {
        messageId     : envelope.messageId,
        publicationId : row.publicationId,
        status        : session ? 'staged' : 'accepted',
      };
    } finally {
      this.pendingAcceptances--;
      this.bufferedBytes -= bytes;
    }
  },

  /**
   * Acepta de forma durable un comando destinado a una acción de otro servicio.
   *
   * @param {string} target Servicio o destino al que se dirige la operación.
   * @param {string} action Nombre de la acción que debe ejecutar el destinatario.
   * @param {*} payload Contenido de aplicación; el transporte lo conserva sin validar sus reglas de
   * negocio.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @returns {Promise<Object>} Aceptación durable o transaccional del comando; no equivale a su ejecución
   * por el receptor.
   */
  sendCommand(target, action, payload, options = {}) {
    return this._enqueue('command', action, payload, options, target);
  },

  /**
   * Acepta de forma durable un evento para su distribución a las suscripciones correspondientes.
   *
   * @param {string} type Clasificación utilizada por la operación.
   * @param {*} payload Contenido de aplicación; el transporte lo conserva sin validar sus reglas de
   * negocio.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @returns {Promise<Object>} Aceptación durable o transaccional del evento; no equivale a su consumo por
   * suscriptores.
   */
  publishEvent(type, payload, options = {}) {
    return this._enqueue('event', type, payload, options);
  },

  /**
   * Adquiere publicaciones pendientes, renueva su propiedad y registra confirmación o reintento del envío.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async _outboxLoop() {
    while (!this.stopping) {
      const generation = this.outboxSignal.version;
      if (this.state !== 'ready' || this.brokerBlocked || !this.persistenceFeed?.ready) {
        await this.outboxSignal.wait(generation, { signal: this.stopController.signal });
        continue;
      }
      let row;
      let heartbeat;
      try {
        row = await this.observer.suppress(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => this.store.claimOutbox({ owner: this.owner }),
        );
        if (this.stopping) break;
        if (!row) {
          const deadline = this.persistenceFeed.nextOutboxAt();
          await this.outboxSignal.wait(generation, {
            signal     : this.stopController.signal,
            deadlineAt : deadline > Date.now() ? deadline : undefined,
          });
        } else {
          heartbeat = setInterval(
            /**
             * Ejecuta la operación periódica configurada.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () =>
              this.observer
                .suppress(
                  /**
                   * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                   * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                   */
                  () =>
                    this.store.renewOutbox({
                      id    : row.id,
                      token : row.token,
                    }),
                )
                .catch(
                  /**
                   * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
                   * @returns {void} Finaliza después de aplicar los efectos de la operación.
                   */
                  () => {},
                ),
            Math.max(20, this.config.leaseMs / 3),
          );
          this.heartbeats.add(heartbeat);
          const routes = {
            event   : this.names.exchanges.events,
            command : this.names.exchanges.commands,
            failure : this.names.exchanges.failures,
            direct  : '',
          };
          if (!Object.hasOwn(routes, row.route.kind)) throw new MessagingError('INVALID_ROUTE');
          const envelope = protocol.decode(row.wire);
          await this.observer.runWithCarrier(
            envelope.telemetry,

            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            async () => {
              const operation = this.observer.beginOperation('publish', {
                messageKind : envelope.kind,
              });
              return operation.run(
                /**
                 * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
                 */
                async () => {
                  try {
                    await this.publisher.publish(
                      routes[row.route.kind],
                      row.route.destination,
                      Buffer.from(row.wire),
                      {
                        persistent  : true,
                        mandatory   : true,
                        contentType : 'application/json',
                        messageId   : row.messageId,
                      },
                    );
                    operation.end({ outcome: 'published' });
                  } catch (error) {
                    operation.end({
                      outcome : 'error',
                      code    : error instanceof MessagingError ? error.code : 'INTERNAL_ERROR',
                    });
                    throw error;
                  }
                },
              );
            },
          );
          if (
            await this.store.completeOutbox({
              id    : row.id,
              token : row.token,
            })
          )
            this._count('published');
        }
        this.persistenceHealth = true;
      } catch (error) {
        if (row) {
          try {
            const retryable = !(error instanceof MessagingError) || error.retryable;
            if (retryable) {
              const delay =
                Math.min(30000, 250 * 2 ** Math.min(row.attempts, 8)) * (0.8 + Math.random() * 0.4);
              await this.store.failOutbox({
                id      : row.id,
                token   : row.token,
                error   : errorMetadata(error),
                retryAt : new Date(Date.now() + delay),
              });
            } else {
              await this.store.failOutbox({
                id           : row.id,
                token        : row.token,
                error        : errorMetadata(error),
                failureRoute :
                  row.route.kind === 'failure'
                    ? undefined
                    : {
                        kind        : 'failure',
                        destination : this.service,
                      },
              });
              this._count('failedPublications');
            }
          } catch {
            this.persistenceHealth = false;
          }
        } else this.persistenceHealth = false;
        await this.outboxSignal.wait(this.outboxSignal.version, {
          signal     : this.stopController.signal,
          deadlineAt : Date.now() + this.config.persistenceRetryMs,
        });
      } finally {
        clearInterval(heartbeat);
        this.heartbeats.delete(heartbeat);
      }
    }
  },

  /**
   * Espera la disponibilidad de la persistencia y solicita el reprocesamiento de un fallo guardado.
   *
   * @param {Object} options Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @returns {Promise<Object>} Resultado del reprocesamiento autorizado por el almacén.
   */
  async replayFailed(options) {
    await this._waitFor(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => this.store?.ready === true,
      Date.now() + this.config.startTimeoutMs,
    );
    return this.store.replayFailed(options);
  },
};
