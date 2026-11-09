/**
 * @file Estado compartido del transporte, registro, contexto y persistencia; coordina arranque,
 * recuperación y cierre.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { WakeSignal }        = require('./wake-signal');
const { randomUUID }        = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter }      = require('node:events');
const { topology }          = require('./topology');
const { MongoStore }        = require('./store');
const { MessagingError }    = require('./errors');
const { createObserver }    = require('./observer');

/**
 * Devuelve una promesa que se resuelve una vez transcurrido el intervalo indicado.
 *
 * @param {number} ms Duración de la espera en milisegundos.
 * @returns {Promise<void>} Promesa que finaliza después del intervalo indicado.
 */
const sleep = (ms) =>
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
 * Espera a que termine la promesa o venza el plazo y libera el temporizador de la espera.
 *
 * @param {Promise<*>} promise Operación cuya finalización se espera.
 * @param {number} deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
 * @returns {Promise<boolean>} true si la operación terminó antes del plazo; false si venció la espera.
 */
async function settleBefore(promise, deadlineAt) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        /**
         * Procesa el resultado de la operación asíncrona.
         * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => true,
        /**
         * Procesa el resultado de la operación asíncrona.
         * @returns {boolean} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => true,
      ),
      new Promise(
        /**
         * Coordina la resolución o el rechazo de la operación asíncrona.
         * @param {Function} resolve Continuación que confirma el resultado de la promesa.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        (resolve) => {
          timer = setTimeout(
            /**
             * Ejecuta la continuación cuando vence el intervalo configurado.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => resolve(false),
            Math.max(0, deadlineAt - Date.now()),
          );
        },
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const defaults = {
  rpcTimeoutMs       : 15000,
  startTimeoutMs     : 15000,
  prefetch           : 20,
  maxPending         : 100,
  maxBufferedBytes   : 16 * 1024 * 1024,
  confirmTimeoutMs   : 15000,
  persistenceRetryMs : 1000,
  leaseMs            : 30000,
  retentionMs        : 30 * 86400000,
  shutdownMs         : 30000,
  retryDelays        : [1000, 5000, 30000],
  reconnectMinMs     : 250,
  reconnectMaxMs     : 30000,
};

/**
 * Agrupa el estado y las operaciones de la instancia de mensajería.
 */
class MessagingRuntime {
  /**
   * Inicializa registros, contadores, límites y estado de la instancia sin abrir conexiones.
   *
   * @param {Object} [options] Opciones y dependencias de esta operación.
   * @param {string} options.service Identidad del servicio dentro del transporte.
   * @param {string} options.namespace Espacio de nombres que aísla los recursos del transporte.
   * @param {*} options.url Dirección del recurso que se utiliza.
   * @param {Object} [options.logger] Receptor de registros técnicos de la operación.
   * @param {Object} [options.config] Configuración que define el comportamiento de la operación.
   */
  constructor({ service, namespace, url, logger = console, config = {}, observer } = {}) {
    this.service = service;
    this.namespace = namespace;
    this.url = url;
    this.logger = logger;
    this.observer = createObserver(observer);
    this.config = {
      ...defaults,
      ...config,
    };
    this.state = 'created';
    this.owner = randomUUID();
    this.actions = new Map();
    this.subscriptions = new Map();
    this.context = new AsyncLocalStorage();
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(0);
    this.pendingRequests = new Map();
    this.inFlight = new Set();
    this.consumerChannels = [];
    this.counters = Object.create(null);
    this.stopping = false;
    this.persistenceHealth = true;
    this.heartbeats = new Set();
    this.bufferedBytes = 0;
    this.pendingAcceptances = 0;
    this.stopController = new AbortController();
    this.outboxSignal = new WakeSignal();
    this.statsMetadata = {
      historical  : this._newStatsMetadata(),
      operational : this._newStatsMetadata(),
    };
  }

  /**
   * Actualiza el estado del runtime y despierta a quienes esperan cambios de disponibilidad.
   *
   * @param {string} state Nuevo estado que se registra.
   * @returns {void} Finaliza después de aplicar los efectos de esta operación.
   */
  _state(state) {
    this.state = state;
    this.changes.emit('change');
    this.outboxSignal.notify();
  }

  /**
   * Comparte una sola promesa de arranque entre todas las solicitudes de inicio.
   *
   * @param {Object} [options] Opciones y dependencias de esta operación.
   * @param {Object} options.connection Conexión de base de datos o transporte utilizada por el módulo.
   * @returns {Promise<Object>} La instancia del runtime una vez que termina el arranque compartido.
   */
  async start({ connection } = {}) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(connection);
    return this.startPromise;
  }

  /**
   * Valida la configuración, prepara MongoDB con soporte transaccional y espera la disponibilidad del
   * transporte.
   *
   * @param {Object} connection Conexión de base de datos o transporte utilizada por el módulo.
   * @returns {Promise<Object>} La instancia lista para procesar mensajes.
   * @throws {Error} La promesa se rechaza
   * cuando falla una comprobación explícita o se propaga un error de la operación.
   */
  async _start(connection) {
    /**
     * Ejecuta esta fase conservando la recuperación y liberación de recursos definidas por el bloque de
     * errores.
     */
    try {
      this.names = topology(this.namespace, this.service);
      if (!this.url || !connection) throw new MessagingError('INVALID_CONFIGURATION');
      for (const key of Object.keys(defaults).filter(
        /**
         * Determina si el elemento cumple el criterio de selección.
         * @param {string} key Clave del campo o recurso que se procesa.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        (key) => key !== 'retryDelays',
      )) {
        if (!Number.isFinite(this.config[key]) || this.config[key] <= 0)
          throw new MessagingError('INVALID_CONFIGURATION', `Invalid ${key}`);
      }
      for (const key of ['persistenceRetryMs']) {
        if (!Number.isInteger(this.config[key]) || this.config[key] > 2147483647)
          throw new MessagingError('INVALID_CONFIGURATION', `Invalid ${key}`);
      }
      if (
        !Array.isArray(this.config.retryDelays) ||
        this.config.retryDelays.some(
          /**
           * Comprueba si el elemento satisface la condición.
           * @param {*} ms Valor de ms utilizado por esta operación.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (ms) => !Number.isFinite(ms) || ms < 0,
        )
      )
        throw new MessagingError('INVALID_CONFIGURATION');
      this.dbConnection = connection;
      this._state('starting');
      this.store = new MongoStore({
        connection,
        namespace   : this.namespace,
        service     : this.service,
        retentionMs : this.config.retentionMs,
        leaseMs     : this.config.leaseMs,
        observer    : this.observer,
      });
      await this.store.initialize();
      const hello = await connection.db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid')
        throw new MessagingError('TRANSACTIONS_REQUIRED');
      this.changes.emit('change');
      this.connectTask = this._connectLoop();
      this._statsLoop();
      this.outboxTask = this._outboxLoop();
      await this._waitFor(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => this.state === 'ready' && this.persistenceFeed.ready,
        Date.now() + this.config.startTimeoutMs,
      );
      return this;
    } catch (error) {
      if (!this.connectTask) this._state('failed');
      throw error;
    }
  }

  /**
   * Espera una condición de disponibilidad hasta el plazo indicado; cancela la espera durante cierre o
   * fallo.
   *
   * @param {Function} predicate Condición que permite dar por terminada la espera.
   * @param {number} deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<void>} Espera resuelta cuando se cumple la condición o rechazada si vence el plazo o
   * termina el runtime.
   */
  _waitFor(predicate, deadlineAt) {
    if (['closed', 'failed'].includes(this.state))
      return Promise.reject(new MessagingError('NOT_AVAILABLE'));
    if (predicate()) return Promise.resolve();
    return new Promise(
      /**
       * Coordina la resolución o el rechazo de la operación asíncrona.
       * @param {Function} resolve Continuación que confirma el resultado de la promesa.
       * @param {Function} reject Continuación que rechaza la promesa con su causa.
       * @returns {void} Finaliza después de aplicar los efectos de la operación.
       */
      (resolve, reject) => {
        let timer;
        /**
         * Libera el temporizador y el observador de estado antes de resolver o rechazar la espera.
         *
         * @param {Error|Object} error Fallo que se clasifica, registra o propaga.
         * @returns {void} Finaliza después de aplicar los efectos de esta operación.
         */
        const finish = (error) => {
          clearTimeout(timer);
          this.changes.removeListener('change', check);
          error ? reject(error) : resolve();
        };
        /**
         * Reevalúa el estado, el plazo y la condición que permiten terminar la espera.
         * @returns {*} Valores de salida de las ramas descritas; una salida sin expresión devuelve undefined.
         */
        const check  = () => {
          if (this.stopping || ['closed', 'failed'].includes(this.state))
            return finish(new MessagingError('NOT_AVAILABLE'));
          if (deadlineAt !== undefined && Date.now() >= deadlineAt)
            return finish(new MessagingError('RPC_TIMEOUT'));
          if (predicate()) finish();
        };
        this.changes.on('change', check);
        if (deadlineAt !== undefined)
          timer = setTimeout(
            /**
             * Ejecuta la continuación cuando vence el intervalo configurado.
             * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
             */
            () => finish(new MessagingError('RPC_TIMEOUT')),
            Math.max(0, deadlineAt - Date.now()),
          );
        check();
      },
    );
  }

  /**
   * Comparte una sola promesa de cierre para impedir liberaciones simultáneas del runtime.
   *
   * @param {Object} [options] Opciones y dependencias de esta operación.
   * @param {number} options.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<void>} La promesa compartida de cierre de la instancia.
   */
  async close({ deadlineAt } = {}) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close(deadlineAt);
    return this.closePromise;
  }

  /**
   * Detiene nuevas operaciones, cancela consumidores y drena el trabajo pendiente dentro del plazo de
   * cierre.
   *
   * @param {number} deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<void>} Finaliza tras drenar o cancelar las operaciones dentro del plazo.
   */
  async _close(deadlineAt) {
    this.stopping = true;
    this.stopController.abort();
    const feedClosed = this.persistenceFeed?.close();
    this.shutdownDeadline = Math.min(deadlineAt ?? Infinity, Date.now() + this.config.shutdownMs);
    this._state('closing');
    /**
     * Recorre los registros afectados y aplica a cada uno la transición de estado correspondiente.
     */
    for (const entry of [...this.pendingRequests.values()])
      entry.finish(
        new MessagingError(entry.sent ? 'RPC_UNCERTAIN' : 'NOT_AVAILABLE', 'Runtime closing', {
          uncertain : entry.sent,
        }),
      );
    await settleBefore(
      Promise.allSettled(
        this.consumerChannels.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {Object} options Colaboradores u opciones: channel, tag.
           * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          ({ channel, tag }) => channel.cancel(tag),
        ),
      ),
      this.shutdownDeadline,
    );
    const deadline = this.shutdownDeadline;
    while (
      (this.inFlight.size || this.publisher?.pending.size || this.rpcPublisher?.pending.size) &&
      Date.now() < deadline
    )
      await sleep(20);
    for (const heartbeat of this.heartbeats) clearInterval(heartbeat);
    this.heartbeats.clear();
    this.publisher?.abort();
    this.rpcPublisher?.abort();
    const connection = this.amqpConnection;
    this.amqpConnection = null;
    this.disconnectResolve?.();
    if (connection) {
      const closed = await settleBefore(connection.close(), deadline);
      if (!closed) connection.connection?.stream?.destroy();
    }
    this.statsDrained = await settleBefore(feedClosed || Promise.resolve(), deadline);
    await settleBefore(this.outboxTask || Promise.resolve(), deadline);
    this._state('closed');
  }
}

/**
 * Los componentes internos comparten conexión, persistencia, registro, contexto y ciclo de vida de esta
 * instancia. Se copian descriptores para conservar la semántica de los métodos de clase.
 */
for (const component of [
  require('./connection'),
  require('./rpc'),
  require('./consumer'),
  require('./context'),
  require('./registry'),
  require('./observability'),
  require('./outbox'),
  require('./statistics'),
]) {
  for (const [name, operation] of Object.entries(component)) {
    Object.defineProperty(MessagingRuntime.prototype, name, {
      value        : operation,
      writable     : true,
      configurable : true,
    });
  }
}

module.exports = { MessagingRuntime };
