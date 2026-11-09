/**
 * @file Publicación en un canal de confirmaciones AMQP con límites de capacidad, plazo y detección de
 * destinos sin ruta.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { randomUUID }     = require('node:crypto');
const { MessagingError } = require('./errors');
const { createObserver } = require('./observer');

/**
 * Agrupa el estado y las operaciones de publicación confirmada.
 */
class ConfirmPublisher {
  /**
   * Asocia el canal AMQP y registra devoluciones, desbloqueos y cierres para controlar las publicaciones
   * pendientes.
   *
   * @param {Object} channel Canal AMQP utilizado para la operación.
   * @param {Object} [options2] Opciones y dependencias de esta operación.
   * @param {number} [options2.maxPending] Cantidad máxima de publicaciones pendientes de confirmación.
   * @param {number} [options2.confirmTimeoutMs] Tiempo máximo de espera de la confirmación, en
   * milisegundos.
   */
  constructor(channel, { maxPending = 100, confirmTimeoutMs = 15000, observer } = {}) {
    this.channel = channel;
    this.maxPending = maxPending;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.observer = createObserver(observer);
    this.pending = new Map();
    this.blocked = false;
    this.closed = false;
    channel.on(
      'return',

      /**
       * Atiende el evento emitido por el colaborador.
       * @param {Object} message Mensaje recibido con datos y contexto del transporte.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (message) => {
        const entry = this.pending.get(message.properties.headers?.['x-publication-id']);
        if (entry) entry.returned = true;
      },
    );
    channel.on(
      'drain',

      /**
       * Atiende el evento emitido por el colaborador.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {
        this.blocked = false;
      },
    );
    channel.on(
      'error',

      /**
       * Atiende el evento emitido por el colaborador.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => this.abort(),
    );
    channel.on(
      'close',

      /**
       * Atiende el evento emitido por el colaborador.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      () => this.abort(),
    );
  }

  /**
   * Publica un mensaje y espera confirmación dentro de su plazo; detecta saturación, desconexión y destinos
   * sin ruta.
   *
   * @param {string} exchange Intercambio AMQP donde se publica el mensaje.
   * @param {string} routingKey Clave utilizada por el broker para enrutar la publicación.
   * @param {Buffer} content Contenido serializado que se publica en el canal.
   * @param {Object} [properties] Propiedades AMQP que acompañan la publicación.
   * @param {Object} [options5] Opciones y dependencias de esta operación.
   * @param {number} options5.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<void>} Confirmación del broker o rechazo por plazo, capacidad, desconexión o falta de
   * ruta.
   */
  publish(exchange, routingKey, content, properties = {}, { deadlineAt } = {}) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      return Promise.reject(new MessagingError('RPC_TIMEOUT'));
    if (this.closed)
      return Promise.reject(
        new MessagingError('CONNECTION_LOST', 'Connection lost', {
          retryable : true,
          uncertain : true,
        }),
      );
    if (this.pending.size >= this.maxPending || this.blocked) {
      return Promise.reject(
        new MessagingError('BACKPRESSURE', 'Publisher capacity reached', { retryable: true }),
      );
    }
    const publicationId = randomUUID();
    return new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @param {Function} reject Continuación que rechaza la promesa con su causa.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (resolve, reject) => {
        /**
         * Retira la publicación pendiente y su temporizador antes de comunicar confirmación, devolución o error.
         *
         * @param {Error|Object} error Fallo que se clasifica, registra o propaga.
         * @returns {void} Finaliza después de aplicar los efectos de esta operación.
         */
        const finish = (error) => {
          const entry = this.pending.get(publicationId);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(publicationId);
          const failure = entry.returned ? new MessagingError('UNROUTABLE') : error;
          this.observer.completePublication(
            publicationId,
            failure
              ? {
                  outcome : 'error',
                  code    : failure instanceof MessagingError ? failure.code : 'INTERNAL_ERROR',
                }
              : { outcome: 'published' },
          );
          if (failure) reject(failure);
          else resolve();
        };
        const entry  = {
          returned : false,
          finish,
        };
        entry.timer = setTimeout(
          /**
           * Ejecuta la continuación cuando vence el intervalo configurado.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () =>
            finish(
              new MessagingError('CONFIRM_TIMEOUT', 'Publish outcome uncertain', {
                retryable : true,
                uncertain : true,
              }),
            ),
          this.confirmTimeoutMs,
        );
        this.pending.set(publicationId, entry);
        try {
          const writable = this.channel.publish(
            exchange,
            routingKey,
            content,
            {
              ...properties,
              headers : {
                ...properties.headers,
                'x-publication-id' : publicationId,
              },
            },
            /**
             * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
             * @param {Error} error Fallo recibido por la continuación.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            (error) =>
              finish(
                error
                  ? new MessagingError('PUBLISH_REJECTED', 'Broker rejected publication', {
                      retryable : true,
                      uncertain : true,
                    })
                  : null,
              ),
          );
          if (!writable) this.blocked = true;
        } catch {
          finish(
            new MessagingError('CONNECTION_LOST', 'Publication interrupted', {
              retryable : true,
              uncertain : true,
            }),
          );
        }
      },
    );
  }

  /**
   * Rechaza las publicaciones pendientes al interrumpirse el canal y marca su resultado como incierto.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  abort() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.pending.values()]) {
      entry.finish(
        new MessagingError('CONNECTION_LOST', 'Publication interrupted', {
          retryable : true,
          uncertain : true,
        }),
      );
    }
  }
}

module.exports = { ConfirmPublisher };
