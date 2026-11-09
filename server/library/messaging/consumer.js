/**
 * @file Procesamiento de entregas: propiedad del inbox, ejecución del manejador y confirmación posterior
 * a la persistencia.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { randomUUID }                    = require('node:crypto');
const protocol                          = require('./protocol');
const { MessagingError, errorMetadata } = require('./errors');
/**
 * Devuelve una promesa que se resuelve una vez transcurrido el intervalo indicado.
 *
 * @param {number} ms Duración de la espera en milisegundos.
 * @returns {Promise<void>} Promesa que finaliza después del intervalo indicado.
 */
const sleep                             = (ms) =>
  new Promise(
    /**
     * Coordina la resolución o el rechazo de la operación asíncrona.
     * @param {Function} resolve Continuación que confirma el resultado de la promesa.
     * @returns {void} Finaliza después de aplicar los efectos de la operación.
     */
    (resolve) => {
      setTimeout(resolve, ms);
    },
  );

/**
 * Procesamiento de entregas con propiedad del inbox, confirmación y tratamiento de fallos. Los métodos
 * internos se ejecutan con la instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Suscribe el canal a su cola y registra cada entrega como trabajo en curso hasta que termina.
   *
   * @param {Object} consumer Canal, cola y estado del consumidor responsable de la entrega.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async _attachConsumer(consumer) {
    const result = await consumer.channel.consume(
      this.names.queues[consumer.kind],
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} message Mensaje recibido con datos y contexto del transporte.
       * @returns {undefined} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (message) => {
        if (!message) {
          this._disconnected(this.amqpConnection);
          return;
        }
        const work = this._consume(message, consumer);
        this.inFlight.add(work);
        work
          .finally(
            /**
             * Libera o restablece los recursos al terminar la operación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => this.inFlight.delete(work),
          )
          .catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      },
      { noAck: false },
    );
    consumer.tag = result.consumerTag;
    consumer.paused = false;
  },

  /**
   * Reintenta la operación de persistencia y pausa el consumidor mientras no pueda guardar su resultado.
   *
   * @param {Function} operation Operación que se ejecuta con las condiciones de este módulo.
   * @param {Object} consumer Canal, cola y estado del consumidor responsable de la entrega.
   * @returns {Promise<*>} Valor de result obtenido por esta operación.
   * @throws {Error} La promesa se rechaza
   * ante NOT_AVAILABLE.
   */
  async _persist(operation, consumer) {
    while (!this.stopping || (this.state === 'closing' && Date.now() < this.shutdownDeadline)) {
      try {
        const result = await operation();
        this.persistenceHealth = true;
        if (consumer.paused && this.state === 'ready' && this.consumerChannels.includes(consumer)) {
          try {
            await this._attachConsumer(consumer);
          } catch {
            this._disconnected(this.amqpConnection);
          }
        }
        return result;
      } catch (error) {
        if (
          ['LEASE_LOST', 'REPLAY_NOT_ALLOWED', 'INBOX_NOT_FOUND'].includes(error.code) ||
          error instanceof MessagingError
        )
          throw error;
        this.persistenceHealth = false;
        this._count('persistenceErrors');
        if (!consumer.paused) {
          consumer.paused = true;
          await consumer.channel.cancel(consumer.tag).catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
        }
        await sleep(this.config.persistenceRetryMs);
      }
    }
    throw new MessagingError('NOT_AVAILABLE');
  },

  /**
   * Confirma la entrega en su canal cuando el consumidor permite completar el procesamiento.
   *
   * @param {Object} message Mensaje que se procesa en esta ejecución.
   * @param {Object} consumer Canal, cola y estado del consumidor responsable de la entrega.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _ack(message, consumer) {
    try {
      consumer.channel.ack(message);
    } catch {
      /**
       * El inbox controla la deduplicación cuando el broker vuelve a entregar el mensaje.
       */
    }
  },

  /**
   * Serializa el resultado y comprueba el límite de transporte sin validar datos de negocio.
   *
   * @param {*} value Valor que se examina o transforma.
   * @param {Object} request Sobre de la solicitud cuya correlación se conserva.
   * @returns {string} Resultado serializado como JSON dentro del límite permitido.
   * @throws {Error} Interrumpe la operación
   * ante SERIALIZATION_FAILED, MESSAGE_TOO_LARGE.
   */
  _resultWire(value, request) {
    const result = {
      ok    : true,
      value : value === undefined ? null : value,
    };
    /**
     * Comprueba la serialización JSON y el tamaño de transporte; el resultado de negocio permanece opaco.
     */
    if (request.kind === 'request') protocol.encode(this._responseEnvelope(request, result));
    let wire;
    try {
      wire = JSON.stringify(result);
    } catch {
      throw new MessagingError('SERIALIZATION_FAILED');
    }
    if (Buffer.byteLength(wire) > protocol.MAX_WIRE_BYTES)
      throw new MessagingError('MESSAGE_TOO_LARGE');
    return wire;
  },

  /**
   * Valida, deduplica y ejecuta una entrega; persiste resultado, reintento o fallo antes de confirmarla.
   *
   * @param {Object} message Mensaje que se procesa en esta ejecución.
   * @param {Object} consumer Canal, cola y estado del consumidor responsable de la entrega.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async _consume(message, consumer) {
    let envelope;
    let row;
    const route = {
      kind        : 'direct',
      destination : this.names.queues[consumer.kind],
    };
    const wire  = message.content.toString();
    /**
     * Ejecuta esta fase conservando la recuperación y liberación de recursos definidas por el bloque de
     * errores.
     */
    try {
      try {
        envelope = protocol.decode(message.content);
        const expected = {
          events   : 'event',
          commands : 'command',
          rpc      : 'request',
        }[consumer.kind];
        if (envelope.kind !== expected || (envelope.target && envelope.target !== this.service))
          throw new MessagingError('INVALID_ROUTE');
        if (envelope.kind === 'request' && !message.properties.replyTo)
          throw new MessagingError('MISSING_REPLY_TO');
      } catch (error) {
        await this._persist(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () =>
            this.store.recordFailure({
              messageId    : message.properties.messageId || randomUUID(),
              rawWire      : message.content,
              error        : errorMetadata(error),
              route        : undefined,
              replayable   : false,
              failureRoute : {
                kind        : 'failure',
                destination : this.service,
              },
            }),
          consumer,
        );
        this._count('invalidMessages');
        this._ack(message, consumer);
        return;
      }
      const registry   = envelope.kind === 'event' ? this.subscriptions : this.actions;
      const definition = registry.get(this._key(envelope.name, envelope.version));
      if (!definition) {
        const error = new MessagingError('HANDLER_NOT_FOUND');
        await this._persist(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () =>
            this.store.recordFailure({
              messageId    : envelope.messageId,
              wire,
              error        : errorMetadata(error),
              route,
              deadlineAt   : envelope.deadlineAt,
              replayable   : envelope.kind !== 'request',
              failureRoute : {
                kind        : 'failure',
                destination : this.service,
              },
            }),
          consumer,
        );
        await this._reply(message, envelope, {
          ok    : false,
          error : errorMetadata(error),
        });
        this._ack(message, consumer);
        return;
      }
      const handler = `${envelope.kind}:${this._key(envelope.name, envelope.version)}`;
      let claim;
      do {
        claim = await this._persist(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () =>
            this.store.claimInbox({
              handler,
              messageId  : envelope.messageId,
              wire,
              execution  : definition.execution,
              owner      : this.owner,
              deadlineAt : envelope.deadlineAt,
            }),
          consumer,
        );
        if (claim.status === 'busy') await sleep(Math.min(100, this.config.leaseMs / 3));
      } while (claim.status === 'busy' && !this.stopping);
      row = claim.row;
      if (claim.status === 'completed') {
        this._count('duplicates');
        await this._reply(message, envelope, JSON.parse(row.resultWire));
        this._ack(message, consumer);
        return;
      }
      if (claim.status === 'waiting' || claim.status === 'failed') {
        await this._reply(message, envelope, {
          ok    : false,
          error : {
            code      : 'PROCESSING_FAILED',
            retryable : false,
          },
        });
        this._ack(message, consumer);
        return;
      }
      if (claim.status === 'uncertain')
        throw new MessagingError('EXECUTION_UNCERTAIN', 'Interrupted non-transactional handler', {
          uncertain : true,
        });
      if (this.stopping) return;
      if (envelope.deadlineAt !== undefined && Date.now() >= envelope.deadlineAt)
        throw new MessagingError('DEADLINE_EXCEEDED');
      let result;
      /**
       * Invoca el manejador dentro del contexto del mensaje y con la sesión de la transacción correspondiente.
       *
       * @param {Object} session Sesión MongoDB que permite participar en la transacción vigente.
       * @returns {Promise<*>} Resultado del manejador ejecutado con contexto y sesión del mensaje.
       */
      const invoke = (session) =>
        this.context.run(
          {
            context : envelope.context,
            message : envelope,
            session,
          },

          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          async () => {
            const operation = this.observer.beginOperation('dispatch', {
              messageKind : envelope.kind,
            });
            return operation.run(
              /**
               * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
               * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              async () => {
                try {
                  if (envelope.deadlineAt !== undefined && Date.now() >= envelope.deadlineAt)
                    throw new MessagingError('DEADLINE_EXCEEDED');
                  const result = await definition.handler(envelope.payload, {
                    context : envelope.context,
                    session,
                    message : envelope,
                    kind    : envelope.kind,
                  });
                  operation.end({ outcome: 'completed' });
                  return result;
                } catch (error) {
                  operation.end({
                    outcome : 'error',
                    code    : error instanceof MessagingError ? error.code : 'HANDLER_FAILED',
                  });
                  /**
                   * Conserva la etiqueta transaccional del controlador MongoDB para permitir el reintento de conflictos de
                   * escritura revertidos.
                   */
                  if (
                    session &&
                    typeof error?.hasErrorLabel === 'function' &&
                    error.hasErrorLabel('TransientTransactionError')
                  )
                    throw error;
                  throw error instanceof MessagingError
                    ? error
                    : new MessagingError('HANDLER_FAILED', 'Handler execution failed', {
                        uncertain :
                          definition.execution === 'nonTransactional' && !definition.retrySafe,
                      });
                }
              },
            );
          },
        );
      if (definition.execution === 'transactional') {
        result = await this._persist(
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () =>
            this.store.transaction(
              /**
               * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
               * @param {Object} session Sesión que agrupa las operaciones de persistencia.
               * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
               */
              async (session) => {
                if (
                  this.store.fenceInbox &&
                  !(await this.store.fenceInbox({
                    id    : row.id,
                    token : row.token,
                    session,
                  }))
                )
                  throw new MessagingError('LEASE_LOST');
                const value      = await invoke(session);
                const resultWire = this._resultWire(value, envelope);
                if (
                  !(await this.store.completeInbox({
                    id    : row.id,
                    token : row.token,
                    resultWire,
                    session,
                  }))
                )
                  throw new MessagingError('LEASE_LOST');
                return value;
              },
            ),
          consumer,
        );
      } else {
        let leaseLost   = false;
        const heartbeat = setInterval(
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
                  this.store.renewInbox({
                    id    : row.id,
                    token : row.token,
                  }),
              )
              .then(
                /**
                 * Procesa el resultado de la operación asíncrona.
                 * @param {*} renewed Valor de renewed utilizado por esta operación.
                 * @returns {void} Finaliza después de aplicar los efectos de la operación.
                 */
                (renewed) => {
                  if (!renewed) leaseLost = true;
                },
              )
              .catch(
                /**
                 * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
                 * @returns {void} Finaliza después de aplicar los efectos de la operación.
                 */
                () => {
                  leaseLost = true;
                },
              ),
          Math.max(20, this.config.leaseMs / 3),
        );
        this.heartbeats.add(heartbeat);
        try {
          result = await invoke(undefined);
          if (leaseLost)
            throw new MessagingError('EXECUTION_UNCERTAIN', 'Execution ownership lost', {
              uncertain : true,
            });
          let resultWire;
          try {
            resultWire = this._resultWire(result, envelope);
          } catch (error) {
            throw new MessagingError(error.code, 'Execution result could not be recorded', {
              uncertain : true,
            });
          }
          const completed = await this._persist(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () =>
              this.store.completeInbox({
                id    : row.id,
                token : row.token,
                resultWire,
              }),
            consumer,
          );
          if (!completed)
            throw new MessagingError('EXECUTION_UNCERTAIN', 'Execution ownership lost', {
              uncertain : true,
            });
        } catch (error) {
          if (leaseLost)
            throw new MessagingError('EXECUTION_UNCERTAIN', 'Execution ownership lost', {
              uncertain : true,
            });
          throw error;
        } finally {
          clearInterval(heartbeat);
          this.heartbeats.delete(heartbeat);
        }
      }
      this._count('processed');
      await this._reply(message, envelope, {
        ok    : true,
        value : result === undefined ? null : result,
      });
      this._ack(message, consumer);
    } catch (error) {
      try {
        if (!envelope || !row || (this.stopping && Date.now() >= this.shutdownDeadline))
          throw error;
        const definition = (envelope.kind === 'event' ? this.subscriptions : this.actions).get(
          this._key(envelope.name, envelope.version),
        );
        const safe       = definition?.execution === 'transactional' || definition?.retrySafe;
        const retryDelay = this.config.retryDelays[row.attempt];
        const canRetry   =
          envelope.kind !== 'request' &&
          safe &&
          error instanceof MessagingError &&
          error.retryable &&
          !error.uncertain &&
          retryDelay !== undefined &&
          (envelope.deadlineAt === undefined || Date.now() + retryDelay < envelope.deadlineAt);
        if (canRetry) {
          await this._persist(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () =>
              this.store.scheduleRetry({
                id          : row.id,
                token       : row.token,
                wire,
                route,
                messageId   : envelope.messageId,
                availableAt : new Date(Date.now() + retryDelay),
                error       : errorMetadata(error),
              }),
            consumer,
          );
          this._count('retries');
        } else {
          await this._persist(
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () =>
              this.store.recordFailure({
                id           : row.id,
                token        : row.token,
                wire,
                route,
                messageId    : envelope.messageId,
                error        : errorMetadata(error),
                deadlineAt   : envelope.deadlineAt,
                replayable   : envelope.kind !== 'request',
                failureRoute : {
                  kind        : 'failure',
                  destination : this.service,
                },
              }),
            consumer,
          );
          this._count('handlerFailures');
        }
        await this._reply(message, envelope, {
          ok    : false,
          error : errorMetadata(error),
        });
        this._ack(message, consumer);
      } catch {
        /**
         * La entrega permanece sin confirmar hasta que su resultado o recuperación queden registrados de forma
         * durable.
         */
        this._count('unacknowledgedFailures');
        if (!this.stopping && this.amqpConnection) this._disconnected(this.amqpConnection);
      }
    }
  },
};
