/**
 * @file Conexión AMQP, creación de canales y recuperación del transporte compartido por el runtime.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const amqp                 = require('amqplib');
const { declare }          = require('./topology');
const { ConfirmPublisher } = require('./publisher');
const { MessagingError }   = require('./errors');

/**
 * Conexión, recuperación y ciclo de vida de los canales AMQP. Los métodos internos se ejecutan con la
 * instancia propietaria de MessagingRuntime como this.
 */
module.exports = {
  /**
   * Restablece la conexión con espera progresiva, declara la topología y prepara publicadores y
   * consumidores.
   * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
   */
  async _connectLoop() {
    let attempt = 0;
    while (!this.stopping) {
      let connection;
      try {
        this._state(attempt ? 'recovering' : 'connecting');
        connection = await amqp.connect(this.url, { timeout: 5000 });
        if (this.stopping) {
          await connection.close();
          break;
        }
        this.amqpConnection = connection;
        const disconnected = new Promise(
          /**
           * Coordina la resolución o el rechazo de la operación asíncrona.
           * @param {Function} resolve Continuación que confirma el resultado de la promesa.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          (resolve) => {
            this.disconnectResolve = resolve;
          },
        );
        connection.on(
          'error',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => this._disconnected(connection),
        );
        connection.on(
          'close',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => this._disconnected(connection),
        );
        this.brokerBlocked = false;
        connection.on(
          'blocked',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            this.brokerBlocked = true;
            this.changes.emit('change');
            this.outboxSignal.notify();
          },
        );
        connection.on(
          'unblocked',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            this.brokerBlocked = false;
            this.changes.emit('change');
            this.outboxSignal.notify();
          },
        );
        const publishChannel = await connection.createConfirmChannel();
        this.publisher = new ConfirmPublisher(publishChannel, {
          ...this.config,
          observer : this.observer,
        });
        publishChannel.on(
          'error',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => this._disconnected(connection),
        );
        publishChannel.on(
          'close',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            if (!this.stopping) this._disconnected(connection);
          },
        );
        await declare(publishChannel, this.names, this.service, this.subscriptions.values());
        const rpcChannel = await connection.createConfirmChannel();
        this.rpcPublisher = new ConfirmPublisher(rpcChannel, {
          ...this.config,
          observer : this.observer,
        });
        rpcChannel.on(
          'error',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          () => this._disconnected(connection),
        );
        rpcChannel.on(
          'close',

          /**
           * Atiende el evento emitido por el colaborador.
           * @returns {void} Finaliza después de aplicar los efectos de la operación.
           */
          () => {
            if (!this.stopping) this._disconnected(connection);
          },
        );
        await rpcChannel.consume(
          'amq.rabbitmq.reply-to',
          /**
           * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
           * @param {Object} message Mensaje recibido con datos y contexto del transporte.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (message) => this._receiveReply(message),
          { noAck: true },
        );
        this.consumerChannels = [];
        for (const kind of ['events', 'commands', 'rpc']) {
          const channel = await connection.createChannel();
          channel.on(
            'error',

            /**
             * Atiende el evento emitido por el colaborador.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => this._disconnected(connection),
          );
          channel.on(
            'close',

            /**
             * Atiende el evento emitido por el colaborador.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {
              if (!this.stopping) this._disconnected(connection);
            },
          );
          await channel.prefetch(this.config.prefetch);
          const consumer = {
            channel,
            kind,
            paused : false,
          };
          this.consumerChannels.push(consumer);
          await this._attachConsumer(consumer);
        }
        if (this.amqpConnection !== connection) throw new MessagingError('CONNECTION_LOST');
        attempt = 0;
        this._state('ready');
        this._count('connections');
        this._log('ready');
        await disconnected;
      } catch {
        if (connection)
          await connection.close().catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
        this.amqpConnection = null;
        if (!this.stopping) this._state('recovering');
      }
      if (!this.stopping) {
        const delay = Math.min(
          this.config.reconnectMaxMs,
          this.config.reconnectMinMs * 2 ** Math.min(attempt++, 10),
        );
        await require('node:timers/promises')
          .setTimeout(delay * (0.8 + Math.random() * 0.4), undefined, {
            signal : this.stopController.signal,
          })
          .catch(
            /**
             * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
             * @returns {void} Finaliza después de aplicar los efectos de la operación.
             */
            () => {},
          );
      }
    }
  },

  /**
   * Marca la pérdida de transporte, invalida solicitudes afectadas y habilita la recuperación de conexión.
   *
   * @param {Object} connection Conexión de base de datos o transporte utilizada por el módulo.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _disconnected(connection) {
    if (!connection || this.amqpConnection !== connection) return;
    this.amqpConnection = null;
    this.publisher?.abort();
    this.rpcPublisher?.abort();
    /**
     * Recorre los registros afectados y aplica a cada uno la transición de estado correspondiente.
     */
    for (const entry of [...this.pendingRequests.values()]) {
      if (entry.sent)
        entry.finish(
          new MessagingError('RPC_UNCERTAIN', 'RPC connection lost', { uncertain: true }),
        );
    }
    if (!this.stopping) this._state('recovering');
    this._count('disconnects');
    this.disconnectResolve?.();
    connection.close().catch(
      /**
       * Gestiona el fallo de la operación asíncrona y conserva la política de error del módulo.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      () => {},
    );
  },
};
