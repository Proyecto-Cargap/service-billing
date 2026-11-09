/**
 * @file Solicitudes RPC con fecha límite, correlación de respuestas y publicación de la respuesta al
 * solicitante.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { randomUUID }                           = require('node:crypto');
const protocol                                 = require('./protocol');
const { MessagingError }                       = require('./errors');
const { issueReadReceipt, confirmReadReceipt } = require('./read-receipt');

/**
 * Plazos de solicitudes, correlación y publicación de respuestas. Los métodos internos se ejecutan con la
 * instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Envía una solicitud con correlación y fecha límite y espera su respuesta sin exceder la capacidad
   * configurada.
   *
   * @param {string} target Servicio o destino al que se dirige la operación.
   * @param {string} action Nombre de la acción que debe ejecutar el destinatario.
   * @param {*} payload Contenido de aplicación; el transporte lo conserva sin validar sus reglas de
   * negocio.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @returns {Promise<*>} Contenido de la respuesta correlacionada; los fallos de transporte rechazan la
   * promesa.
   * @throws {Error} La promesa se rechaza
   * ante NOT_AVAILABLE, BACKPRESSURE.
   */
  async request(target, action, payload, options = {}) {
    const operation = this.observer.beginOperation('request', { messageKind: 'request' });
    return operation.run(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async () => {
        try {
          const result = await this._request(target, action, payload, options);
          operation.end({ outcome: 'received' });
          return result;
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

  /** Conserva el resultado RPC opaco y su finalización única mediante entry.finish.
   * @param {string} target Valor de target utilizado por esta operación.
   * @param {string} action Valor de action utilizado por esta operación.
   * @param {*} payload Valor de payload utilizado por esta operación.
   * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async _request(target, action, payload, options = {}) {
    if (this.stopping) throw new MessagingError('NOT_AVAILABLE');
    if (this.pendingRequests.size >= this.config.maxPending)
      throw new MessagingError('BACKPRESSURE');
    const deadlineAt =
      options.deadlineAt ?? Date.now() + (options.timeoutMs ?? this.config.rpcTimeoutMs);
    const envelope   = this._envelope(
      'request',
      action,
      payload,
      {
        ...options,
        deadlineAt,
      },
      target,
    );
    const content    = protocol.encode(envelope);
    if (this.bufferedBytes + content.length > this.config.maxBufferedBytes)
      throw new MessagingError('BACKPRESSURE', 'RPC capacity reached', { retryable: true });
    this.bufferedBytes += content.length;
    const correlationId = randomUUID();
    return new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @param {Function} reject Continuación que rechaza la promesa con su causa.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (resolve, reject) => {
        const entry = {
          envelope,
          sent : false,
        };
        /**
         * Libera la solicitud pendiente, cancela su temporizador y registra el resultado o su incertidumbre.
         *
         * @param {Error|Object} error Fallo que se clasifica, registra o propaga.
         * @param {*} result Resultado de la operación que debe devolverse o serializarse.
         * @returns {void} Finaliza después de aplicar los efectos de esta operación.
         */
        entry.finish = (error, result) => {
          if (!this.pendingRequests.delete(correlationId)) return;
          clearTimeout(entry.timer);
          this.bufferedBytes -= content.length;
          if (error) {
            this._count(error.uncertain ? 'rpcUncertain' : 'rpcErrors');
            reject(error);
          } else {
            this._count('rpcCompleted');
            resolve(result);
          }
        };
        entry.timer = setTimeout(
          /**
           * Ejecuta la continuación cuando vence el intervalo configurado.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            this._count('rpcTimeouts');
            entry.finish(
              new MessagingError('RPC_TIMEOUT', 'RPC deadline exceeded', { uncertain: entry.sent }),
            );
          },
          Math.max(0, deadlineAt - Date.now()),
        );
        this.pendingRequests.set(correlationId, entry);
        (
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @returns {Promise<undefined>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          async () => {
            try {
              await this._waitFor(
                /**
                 * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
                 * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
                 */
                () => this.state === 'ready' && !this.brokerBlocked,
                deadlineAt,
              );
              if (!this.pendingRequests.has(correlationId) || Date.now() >= deadlineAt) return;
              entry.sent = true;
              await this.rpcPublisher.publish(
                this.names.exchanges.rpc,
                target,
                content,
                {
                  persistent  : true,
                  mandatory   : true,
                  contentType : 'application/json',
                  messageId   : envelope.messageId,
                  correlationId,
                  replyTo     : 'amq.rabbitmq.reply-to',
                  expiration  : String(Math.max(1, deadlineAt - Date.now())),
                },
                { deadlineAt },
              );
            } catch (error) {
              entry.finish(error);
            }
          }
        )();
      },
    );
  },

  /**
   * Valida la respuesta y su correspondencia con una solicitud pendiente antes de resolverla.
   *
   * @param {Object} message Mensaje que se procesa en esta ejecución.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _receiveReply(message) {
    if (!message) return;
    const entry = this.pendingRequests.get(message.properties.correlationId);
    if (!entry) return;
    try {
      const envelope = protocol.decode(message.content);
      if (
        envelope.kind !== 'response' ||
        envelope.source !== entry.envelope.target ||
        envelope.target !== this.service ||
        envelope.causationId !== entry.envelope.messageId ||
        envelope.name !== entry.envelope.name ||
        envelope.version !== entry.envelope.version
      )
        throw new MessagingError('INVALID_REPLY');
      if (envelope.transportError)
        entry.finish(
          new MessagingError(
            envelope.transportError.code,
            'Remote messaging failure',
            envelope.transportError,
          ),
        );
      else entry.finish(null, confirmReadReceipt(envelope.payload, envelope.readCursor));
    } catch {
      entry.finish(
        new MessagingError('INVALID_REPLY', 'RPC reply is invalid', { uncertain: true }),
      );
    }
  },

  /**
   * Construye el sobre de respuesta conservando versión, correlación y causalidad de la solicitud.
   *
   * @param {Object} request Sobre de la solicitud cuya correlación se conserva.
   * @param {*} result Resultado de la operación que debe devolverse o serializarse.
   * @returns {Object} Sobre dirigido al solicitante con resultado o metadatos técnicos del fallo.
   */
  _responseEnvelope(request, result) {
    return protocol.createEnvelope({
      telemetry     : this.observer.captureCarrier(),
      kind          : 'response',
      name          : request.name,
      version       : request.version,
      source        : this.service,
      target        : request.source,
      correlationId : request.correlationId,
      causationId   : request.messageId,
      context       : {},
      payload       : result.ok ? result.value : null,
      ...(result.ok
        ? { readCursor: issueReadReceipt(result.value) }
        : { transportError: result.error }),
    });
  },

  /**
   * Publica la respuesta en la cola indicada por el solicitante y contabiliza respuestas que no pudieron
   * entregarse.
   *
   * @param {Object} message Mensaje que se procesa en esta ejecución.
   * @param {Object} request Sobre de la solicitud cuya correlación se conserva.
   * @param {*} result Resultado de la operación que debe devolverse o serializarse.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async _reply(message, request, result) {
    if (request.kind !== 'request' || !message.properties.replyTo) return;
    try {
      const envelope = this._responseEnvelope(request, result);
      await this.publisher.publish('', message.properties.replyTo, protocol.encode(envelope), {
        correlationId : message.properties.correlationId,
        contentType   : 'application/json',
      });
    } catch {
      this._count('lostReplies');
    }
  },
};
