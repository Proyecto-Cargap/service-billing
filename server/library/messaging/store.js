/**
 * @file Persistencia MongoDB de outbox, inbox y fallos; controla deduplicación, arrendamientos y
 * escrituras transaccionales.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';

const { randomUUID, createHash } = require('node:crypto');
const protocol                   = require('./protocol');
const { createObserver }         = require('./observer');

const DAY             = 24 * 60 * 60 * 1000;
const RAW_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Construye un error de persistencia con un código técnico estable.
 *
 * @param {string} code Código o modalidad utilizado por esta operación.
 * @param {string} message Descripción interna que conserva la excepción para diagnóstico.
 * @returns {Error} Error con su código de persistencia.
 */
function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Agrupa el estado y las operaciones de persistencia del transporte.
 */
class MongoStore {
  /**
   * Valida la conexión y el ámbito e inicializa los límites de retención y arrendamiento.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {Object} options.connection Conexión de base de datos o transporte utilizada por el módulo.
   * @param {string} options.namespace Espacio de nombres que aísla los recursos del transporte.
   * @param {string} options.service Identidad del servicio dentro del transporte.
   * @param {number} [options.retentionMs] Tiempo de conservación de registros completados, en milisegundos.
   * @param {number} [options.leaseMs] Vigencia del arrendamiento de trabajo, en milisegundos.
   * @throws {Error} Interrumpe la operación
   * ante STORE_CONFIGURATION.
   */
  constructor({
    connection,
    namespace,
    service,
    retentionMs = 30 * DAY,
    leaseMs = 30000,
    observer,
  }) {
    if (!connection || !namespace || !service) {
      throw storeError('STORE_CONFIGURATION', 'A connection, namespace and service are required');
    }
    this.connection = connection;
    this.scope = Object.freeze({
      namespace,
      service,
    });
    this.retentionMs = retentionMs;
    this.leaseMs = leaseMs;
    this.ready = false;
    this.observer = createObserver(observer);
  }

  /**
   * Verifica los índices administrativos de deduplicación, búsqueda y caducidad sin crearlos.
   * @returns {Promise<Object>} El almacén inicializado y listo para recibir operaciones.
   * @throws {Error} La promesa se rechaza
   * ante STORE_NOT_READY.
   */
  async initialize() {
    this.ready = false;
    if (!this.connection.db) {
      throw storeError('STORE_NOT_READY', 'The injected MongoDB connection is not ready');
    }
    const options = { writeConcern: { w: 'majority' } };
    this.outbox = this.connection.db.collection('messaging_v1_outbox', options);
    this.inbox = this.connection.db.collection('messaging_v1_inbox', options);
    this.failures = this.connection.db.collection('messaging_v1_failures', options);
    this.failureChunks = this.connection.db.collection('messaging_v1_failure_chunks', options);
    await require('./indexes').verifyIndexes(this.connection.db, require('./indexes.json'));
    this.ready = true;
    return this;
  }

  /**
   * Exige que la persistencia haya terminado de inicializarse antes de acceder a las colecciones.
   * @returns {void} Finaliza si el almacén puede utilizarse.
   * @throws {Error} Interrumpe la operación
   * ante STORE_NOT_READY.
   */
  assertReady() {
    if (!this.ready)
      throw storeError('STORE_NOT_READY', 'Messaging persistence has not been initialized');
  }

  /**
   * Reutiliza una sesión suministrada o abre una transacción con lectura snapshot y escritura mayoritaria.
   *
   * @param {Function} work Operación ejecutada con la sesión transaccional disponible.
   * @param {Object} [options] Opciones de ejecución; las propiedades omitidas conservan los valores
   * predeterminados.
   * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
   * undefined.
   */
  async transaction(work, options = {}) {
    this.assertReady();
    if (options.session) return work(options.session);
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        () => work(session),
        {
          readConcern    : { level: 'snapshot' },
          writeConcern   : { w: 'majority' },
          readPreference : 'primary',
        },
      );
    } finally {
      await session.endSession();
    }
  }

  /**
   * Añade el espacio de nombres y el servicio a un filtro para acotar la operación de persistencia.
   *
   * @param {Object} [query] Filtro que se limita al ámbito de persistencia.
   * @returns {Object} Filtro con espacio de nombres y servicio de esta instancia.
   */
  scoped(query = {}) {
    return {
      ...query,
      ...this.scope,
    };
  }

  /**
   * Expone el identificador del documento como id y conserva null cuando no existe un registro.
   *
   * @param {Object|null} row Documento obtenido de la persistencia.
   * @returns {Object|null} Documento con alias id o null si no existe.
   */
  document(row) {
    return row
      ? {
          ...row,
          id : row._id,
        }
      : null;
  }

  /**
   * Persiste una publicación pendiente usando publicationId como clave de idempotencia de la entrega.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {Buffer|string} options.wire Representación serializada del mensaje.
   * @param {Object} options.route Tipo y destino de la ruta de entrega.
   * @param {string} options.messageId Identificador estable del mensaje entre sus intentos de entrega.
   * @param {string} [options.publicationId] Clave de idempotencia de una publicación concreta.
   * @param {Date} [options.availableAt] Momento a partir del cual puede adquirirse la entrega.
   * @param {number} options.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @returns {Promise<Object>} Publicación persistida o previamente existente para la misma clave de
   * idempotencia.
   */
  async enqueueOutbox({
    wire,
    route,
    messageId,
    publicationId = randomUUID(),
    availableAt = new Date(),
    deadlineAt,
    session,
  }) {
    this.assertReady();
    const now = new Date();
    const row = {
      _id         : randomUUID(),
      ...this.scope,
      publicationId,
      messageId,
      wire,
      route,
      status      : 'pending',
      attempts    : 0,
      availableAt : new Date(availableAt),
      createdAt   : now,
      updatedAt   : now,
    };
    if (deadlineAt !== undefined && deadlineAt !== null) row.deadlineAt = new Date(deadlineAt);
    /**
     * publicationId identifica de forma idempotente una entrega. messageId admite repetición porque los
     * reintentos dirigidos conservan el identificador del mensaje.
     */
    const result = await this.outbox.findOneAndUpdate(
      this.scoped({ publicationId }),
      { $setOnInsert: row },
      {
        upsert                : true,
        returnDocument        : 'after',
        includeResultMetadata : false,
        session,
      },
    );
    return this.document(result);
  }

  /**
   * Adquiere una publicación disponible o con arrendamiento vencido y asigna un nuevo token de propiedad.
   *
   * @param {Object} [options] Opciones y dependencias de esta operación.
   * @param {string} [options.owner] Identidad del proceso que adquiere el trabajo pendiente.
   * @param {Date} [options.now] Instante usado para evaluar disponibilidad y vencimiento.
   * @returns {Promise<Object|null>} Publicación adquirida con su token o null si no hay trabajo disponible.
   */
  async claimOutbox({ owner = randomUUID(), now = new Date() } = {}) {
    this.assertReady();
    const date = new Date(now);
    return this.document(
      await this.outbox.findOneAndUpdate(
        this.scoped({
          $or : [
            {
              status      : 'pending',
              availableAt : { $lte: date },
            },
            {
              status     : 'publishing',
              leaseUntil : { $lte: date },
            },
          ],
        }),
        {
          $set : {
            status     : 'publishing',
            owner,
            token      : randomUUID(),
            leaseUntil : new Date(date.getTime() + this.leaseMs),
            updatedAt  : date,
          },
          $inc : { attempts: 1 },
        },
        {
          sort                  : {
            availableAt : 1,
            createdAt   : 1,
          },
          returnDocument        : 'after',
          includeResultMetadata : false,
        },
      ),
    );
  }

  /**
   * Extiende el arrendamiento de una publicación únicamente si el token conserva la propiedad vigente.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @returns {Promise<boolean>} Indica si se renovó una publicación con propiedad vigente.
   */
  async renewOutbox({ id, token }) {
    this.assertReady();
    const now    = new Date();
    const result = await this.outbox.updateOne(
      this.scoped({
        _id        : id,
        token,
        status     : 'publishing',
        leaseUntil : { $gt: now },
      }),
      {
        $set : {
          leaseUntil : new Date(now.getTime() + this.leaseMs),
          updatedAt  : now,
        },
      },
    );
    return result.matchedCount === 1;
  }

  /**
   * Marca la publicación como confirmada y habilita su caducidad cuando el propietario sigue vigente.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @returns {Promise<boolean>} Indica si pudo completarse la publicación con el token suministrado.
   */
  async completeOutbox({ id, token }) {
    this.assertReady();
    const now    = new Date();
    const result = await this.outbox.updateOne(
      this.scoped({
        _id        : id,
        token,
        status     : 'publishing',
        leaseUntil : { $gt: now },
      }),
      {
        $set   : {
          status      : 'published',
          publishedAt : now,
          updatedAt   : now,
          expiresAt   : new Date(now.getTime() + this.retentionMs),
        },
        $unset : {
          owner      : '',
          token      : '',
          leaseUntil : '',
          lastError  : '',
        },
      },
    );
    return result.matchedCount === 1;
  }

  /**
   * Programa otro intento de publicación o registra un fallo definitivo, según la ruta de recuperación
   * recibida.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @param {Error|Object} options.error Fallo que se clasifica, registra o propaga.
   * @param {Date} options.retryAt Instante programado para el siguiente intento.
   * @param {Object} options.failureRoute Ruta donde se publica la referencia de fallo.
   * @returns {Promise<boolean>} Indica si pudo registrarse el fallo o reintento conservando la propiedad.
   */
  async failOutbox({ id, token, error, retryAt, failureRoute }) {
    this.assertReady();
    if (!retryAt) {
      return this.transaction(
        /**
         * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
         * @param {Object} session Sesión que agrupa las operaciones de persistencia.
         * @returns {Promise<boolean>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
         */
        async (session) => {
          const now = new Date();
          const row = await this.outbox.findOneAndUpdate(
            this.scoped({
              _id        : id,
              token,
              status     : 'publishing',
              leaseUntil : { $gt: now },
            }),
            {
              $set   : {
                status    : 'failed',
                failedAt  : now,
                updatedAt : now,
                lastError : error,
              },
              $unset : {
                owner      : '',
                token      : '',
                leaseUntil : '',
                expiresAt  : '',
              },
            },
            {
              returnDocument        : 'before',
              includeResultMetadata : false,
              session,
            },
          );
          if (!row) return false;
          const failureId = await this.recordFailure({
            outboxId   : id,
            messageId  : row.messageId,
            wire       : row.wire,
            route      : row.route,
            deadlineAt : row.deadlineAt,
            error,
            failureRoute,
            session,
          });
          await this.outbox.updateOne(
            this.scoped({
              _id    : id,
              status : 'failed',
            }),
            { $set: { failureId } },
            { session },
          );
          return true;
        },
      );
    }
    const now    = new Date();
    const result = await this.outbox.updateOne(
      this.scoped({
        _id        : id,
        token,
        status     : 'publishing',
        leaseUntil : { $gt: now },
      }),
      {
        $set   : {
          status      : 'pending',
          availableAt : new Date(retryAt),
          updatedAt   : now,
          lastError   : error,
        },
        $unset : {
          owner      : '',
          token      : '',
          leaseUntil : '',
          expiresAt  : '',
        },
      },
    );
    return result.matchedCount === 1;
  }

  /**
   * Busca el estado de recepción de un mensaje para un manejador dentro del ámbito de la instancia.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {string} options.handler Clave versionada del manejador para deduplicar la ejecución.
   * @param {string} options.messageId Identificador estable del mensaje entre sus intentos de entrega.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @returns {Promise<Object|null>} Recepción registrada para el manejador y mensaje o null si no existe.
   */
  async getInbox({ handler, messageId, session }) {
    this.assertReady();
    return this.document(
      await this.inbox.findOne(
        this.scoped({
          handler,
          messageId,
        }),
        { session },
      ),
    );
  }

  /**
   * Deduplica la entrega y adquiere su ejecución; distingue mensajes ocupados, completados y recuperables.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {string} options.handler Clave versionada del manejador para deduplicar la ejecución.
   * @param {string} options.messageId Identificador estable del mensaje entre sus intentos de entrega.
   * @param {Buffer|string} options.wire Representación serializada del mensaje.
   * @param {Object} options.execution Metadatos y contexto de la ejecución del manejador.
   * @param {string} [options.owner] Identidad del proceso que adquiere el trabajo pendiente.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @param {number} options.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @returns {Promise<Object>} Estado de adquisición y documento del inbox asociado.
   * @throws {Error} La promesa se rechaza
   * cuando falla una comprobación explícita o se propaga un error de la operación.
   */
  async claimInbox({
    handler,
    messageId,
    wire,
    execution,
    owner = randomUUID(),
    session,
    deadlineAt,
  }) {
    this.assertReady();
    const now   = new Date();
    const token = randomUUID();
    const key   = this.scoped({
      handler,
      messageId,
    });
    // Sin transacción explícita, la clave única adquiere directamente una entrega nueva.
    // Un duplicado conserva la lectura y clasificación existentes; otros fallos no se reintentan.
    // Dentro de una transacción se mantiene la lectura previa para no abortarla por un duplicado.
    let row     = session ? await this.inbox.findOne(key, { session }) : null;
    if (!row) {
      const candidate = {
        _id             : randomUUID(),
        ...key,
        wire,
        execution,
        status          : 'processing',
        owner,
        token,
        attempt         : 0,
        retryGeneration : 0,
        createdAt       : now,
        updatedAt       : now,
        leaseUntil      : new Date(now.getTime() + this.leaseMs),
      };
      if (deadlineAt !== undefined && deadlineAt !== null)
        candidate.deadlineAt = new Date(deadlineAt);
      try {
        await this.inbox.insertOne(candidate, { session });
        return {
          status : 'claimed',
          row    : this.document(candidate),
        };
      } catch (error) {
        /**
         * Otra entrega adquirió la clave única. Si la transacción pertenece al llamador, propaga el duplicado
         * para que su propietario pueda reintentarlo.
         */
        if (error.code !== 11000 || session) throw error;
        row = await this.inbox.findOne(key);
        if (!row) throw error;
      }
    }
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'uncertain') {
      return {
        status : row.status,
        row    : this.document(row),
      };
    }
    if (row.status === 'processing' && row.leaseUntil > now) {
      return {
        status : 'busy',
        row    : this.document(row),
      };
    }
    if (row.status === 'waiting' && row.availableAt > now) {
      return {
        status : 'waiting',
        row    : this.document(row),
      };
    }
    if (row.status === 'processing' && row.execution !== 'transactional') {
      const uncertain = await this.inbox.findOneAndUpdate(
        this.scoped({
          _id        : row._id,
          status     : 'processing',
          token      : row.token,
          leaseUntil : { $lte: now },
        }),
        {
          $set   : {
            status      : 'uncertain',
            updatedAt   : now,
            uncertainAt : now,
          },
          $unset : { expiresAt: '' },
        },
        {
          returnDocument        : 'after',
          includeResultMetadata : false,
          session,
        },
      );
      if (uncertain)
        return {
          status : 'uncertain',
          row    : this.document(uncertain),
        };
      return {
        status : 'busy',
        row    : await this.getInbox({
          handler,
          messageId,
          session,
        }),
      };
    }
    const condition =
      row.status === 'waiting'
        ? {
            status      : 'waiting',
            availableAt : { $lte: now },
          }
        : {
            status     : 'processing',
            token      : row.token,
            leaseUntil : { $lte: now },
          };
    const claimed   = await this.inbox.findOneAndUpdate(
      this.scoped({
        _id : row._id,
        ...condition,
      }),
      {
        $set   : {
          status     : 'processing',
          owner,
          token,
          leaseUntil : new Date(now.getTime() + this.leaseMs),
          updatedAt  : now,
        },
        $unset : {
          availableAt : '',
          expiresAt   : '',
        },
      },
      {
        returnDocument        : 'after',
        includeResultMetadata : false,
        session,
      },
    );
    return claimed
      ? {
          status : 'claimed',
          row    : this.document(claimed),
        }
      : {
          status : 'busy',
          row    : await this.getInbox({
            handler,
            messageId,
            session,
          }),
        };
  }

  /**
   * Renueva el arrendamiento del mensaje mientras el token mantiene la propiedad de la ejecución.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @returns {Promise<boolean>} Indica si se renovó la ejecución con su token vigente.
   */
  async renewInbox({ id, token }) {
    this.assertReady();
    const now    = new Date();
    const result = await this.inbox.updateOne(
      this.scoped({
        _id        : id,
        token,
        status     : 'processing',
        leaseUntil : { $gt: now },
      }),
      {
        $set : {
          leaseUntil : new Date(now.getTime() + this.leaseMs),
          updatedAt  : now,
        },
      },
    );
    return result.matchedCount === 1;
  }

  /**
   * Bloquea el documento del inbox dentro de la transacción antes de ejecutar el manejador.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @returns {Promise<boolean>} Indica si se adquirió el bloqueo transaccional con el token y arrendamiento
   * requeridos.
   * @throws {Error} La promesa se rechaza
   * ante TRANSACTION_REQUIRED.
   */
  async fenceInbox({ id, token, session }) {
    this.assertReady();
    if (!session?.inTransaction())
      throw storeError(
        'TRANSACTION_REQUIRED',
        'An active transaction is required to fence the inbox',
      );
    const now    = new Date();
    /**
     * Esta debe ser la primera escritura del inbox dentro de la transacción, antes del manejador. El bloqueo
     * impide que otra adquisición del arrendamiento se confirme mientras se ejecuta y completa el trabajo
     * atómicamente.
     */
    const result = await this.inbox.updateOne(
      this.scoped({
        _id        : id,
        token,
        status     : 'processing',
        leaseUntil : { $gt: now },
      }),
      {
        $set : {
          leaseUntil : new Date(now.getTime() + this.leaseMs),
          updatedAt  : now,
        },
      },
      { session },
    );
    return result.matchedCount === 1;
  }

  /**
   * Guarda el resultado de ejecución y completa el inbox comprobando la propiedad del token.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @param {string} options.resultWire Resultado serializado que se conserva para entregas duplicadas.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @returns {Promise<boolean>} Indica si se guardó la finalización de la ejecución con la propiedad
   * requerida.
   */
  async completeInbox({ id, token, resultWire, session }) {
    this.assertReady();
    const now       = new Date();
    const ownership = {
      _id    : id,
      token,
      status : 'processing',
    };
    /**
     * Cuando existe sesión, fenceInbox ya bloqueó el documento. El tiempo transcurrido no revoca la propiedad
     * de esa transacción.
     */
    if (!session) ownership.leaseUntil = { $gt: now };
    const result = await this.inbox.updateOne(
      this.scoped(ownership),
      {
        $set   : {
          status      : 'completed',
          resultWire,
          completedAt : now,
          updatedAt   : now,
          expiresAt   : new Date(now.getTime() + this.retentionMs),
        },
        $unset : {
          token      : '',
          owner      : '',
          leaseUntil : '',
          lastError  : '',
        },
      },
      { session },
    );
    return result.matchedCount === 1;
  }

  /**
   * Registra el siguiente intento de entrega junto con el resultado del intento actual.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @param {Buffer|string} options.wire Representación serializada del mensaje.
   * @param {Object} options.route Tipo y destino de la ruta de entrega.
   * @param {string} options.messageId Identificador estable del mensaje entre sus intentos de entrega.
   * @param {Date} options.availableAt Momento a partir del cual puede adquirirse la entrega.
   * @param {Error|Object} options.error Fallo que se clasifica, registra o propaga.
   * @returns {Promise<Object>} Estado actualizado del inbox y publicación del outbox que representa el
   * siguiente intento.
   */
  async scheduleRetry({ id, token, wire, route, messageId, availableAt, error }) {
    this.assertReady();
    return this.transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (session) => {
        const now = new Date();
        const row = await this.inbox.findOneAndUpdate(
          this.scoped({
            _id    : id,
            token,
            status : 'processing',
            $or    : [{ execution: 'transactional' }, { leaseUntil: { $gt: now } }],
          }),
          {
            $set   : {
              status      : 'waiting',
              availableAt : new Date(availableAt),
              updatedAt   : now,
              lastError   : error,
            },
            $inc   : { attempt: 1 },
            $unset : {
              owner      : '',
              token      : '',
              leaseUntil : '',
              expiresAt  : '',
            },
          },
          {
            returnDocument        : 'after',
            includeResultMetadata : false,
            session,
          },
        );
        if (!row)
          throw storeError('LEASE_LOST', 'The inbox lease is no longer owned by this execution');
        const publication = await this.enqueueOutbox({
          wire,
          route,
          messageId,
          availableAt,
          deadlineAt    : row.deadlineAt,
          session,
          publicationId : `retry:${row._id}:${row.retryGeneration || 0}:${row.attempt}`,
        });
        return {
          inbox  : this.document(row),
          outbox : publication,
        };
      },
    );
  }

  /**
   * Conserva el fallo y el mensaje original de forma durable; fragmenta tramas grandes y publica una
   * referencia acotada.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {*} options.id Identificador del registro persistido.
   * @param {string} options.token Token que acredita la propiedad vigente del arrendamiento.
   * @param {Function|string} options.handler Manejador o identificador de la operación procesada.
   * @param {string} options.messageId Identificador estable del mensaje entre sus intentos de entrega.
   * @param {Buffer|string} options.wire Representación serializada del mensaje.
   * @param {Buffer} options.rawWire Bytes originales de la trama rechazada.
   * @param {Error|Object} options.error Fallo que se clasifica, registra o propaga.
   * @param {Object} options.route Tipo y destino de la ruta de entrega.
   * @param {Object} options.failureRoute Ruta donde se publica la referencia de fallo.
   * @param {number} options.deadlineAt Fecha límite absoluta expresada en milisegundos desde Unix epoch.
   * @param {*} options.outboxId Identificador de la publicación vinculada al fallo persistido.
   * @param {boolean} [options.replayable] Indica si el fallo permite una nueva entrega.
   * @param {Object} options.session Sesión MongoDB que permite participar en la transacción vigente.
   * @returns {Promise<string>} Identificador del fallo conservado de forma durable.
   * @throws {Error} La promesa se rechaza
   * ante INVALID_RAW_WIRE.
   */
  async recordFailure({
    id,
    token,
    handler,
    messageId,
    wire,
    rawWire,
    error,
    route,
    failureRoute,
    deadlineAt,
    outboxId,
    replayable = true,
    session : existingSession,
  }) {
    this.assertReady();
    if (rawWire !== undefined && !(rawWire instanceof Uint8Array)) {
      throw storeError('INVALID_RAW_WIRE', 'Raw transport data must be a Buffer or Uint8Array');
    }
    const raw =
      rawWire === undefined
        ? undefined
        : Buffer.from(rawWire.buffer, rawWire.byteOffset, rawWire.byteLength);
    return this.transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (session) => {
        const now = new Date();
        let inboxRow;
        if (id) {
          inboxRow = await this.inbox.findOne(this.scoped({ _id: id }), { session });
          if (!inboxRow)
            throw storeError('INBOX_NOT_FOUND', 'The failed inbox execution does not exist');
          if (inboxRow.failureId && ['failed', 'uncertain'].includes(inboxRow.status))
            return inboxRow.failureId;
          if (!['processing', 'uncertain'].includes(inboxRow.status) || inboxRow.token !== token) {
            throw storeError(
              'LEASE_LOST',
              'The inbox execution can no longer be failed by this owner',
            );
          }
          /**
           * Una transacción revertida puede guardar su resultado si el token aún posee la fila. Una ejecución sin
           * transacción no puede acreditar un resultado cierto después de vencer su arrendamiento.
           */
          if (
            inboxRow.status === 'processing' &&
            inboxRow.execution !== 'transactional' &&
            inboxRow.leaseUntil <= now
          ) {
            throw storeError(
              'LEASE_LOST',
              'The inbox execution lease expired before failure recording',
            );
          }
        }
        const failureId = randomUUID();
        const uncertain = inboxRow?.status === 'uncertain' || error?.uncertain === true;
        const failure   = {
          _id        : randomUUID(),
          ...this.scope,
          failureId,
          handler    : handler || inboxRow?.handler,
          messageId  : messageId || inboxRow?.messageId,
          route,
          error,
          replayable : raw ? false : replayable,
          status     : uncertain ? 'uncertain' : 'failed',
          createdAt  : now,
          updatedAt  : now,
          audit      : [
            {
              action : 'failed',
              at     : now,
            },
          ],
        };
        if (raw) {
          /**
           * Conserva los bytes exactos de la trama rechazada. La división en fragmentos limita cada documento BSON
           * aunque la trama supere el tamaño admitido por el protocolo.
           */
          failure.rawSize = raw.length;
          failure.rawSha256 = createHash('sha256').update(raw).digest('hex');
          failure.rawStorage = raw.length > RAW_CHUNK_BYTES ? 'chunks' : 'inline';
          if (failure.rawStorage === 'inline') failure.rawWire = raw;
          else {
            failure.chunkCount = Math.ceil(raw.length / RAW_CHUNK_BYTES);
            for (let index = 0; index < failure.chunkCount; index++) {
              await this.failureChunks.insertOne(
                {
                  _id       : randomUUID(),
                  ...this.scope,
                  failureId,
                  index,
                  createdAt : now,
                  content   : raw.subarray(index * RAW_CHUNK_BYTES, (index + 1) * RAW_CHUNK_BYTES),
                },
                { session },
              );
            }
          }
        } else failure.wire = wire;
        if (id) failure.inboxId = id;
        if (outboxId) failure.outboxId = outboxId;
        const effectiveDeadline = deadlineAt ?? inboxRow?.deadlineAt;
        if (effectiveDeadline !== undefined && effectiveDeadline !== null)
          failure.deadlineAt = new Date(effectiveDeadline);
        await this.failures.insertOne(failure, { session });
        if (id) {
          const result = await this.inbox.updateOne(
            this.scoped({
              _id    : id,
              token,
              status : inboxRow.status,
            }),
            {
              $set   : {
                status    : uncertain ? 'uncertain' : 'failed',
                failureId,
                failedAt  : now,
                updatedAt : now,
                lastError : error,
              },
              $unset : {
                token      : '',
                owner      : '',
                leaseUntil : '',
                expiresAt  : '',
              },
            },
            { session },
          );
          if (result.matchedCount !== 1)
            throw storeError('LEASE_LOST', 'The inbox failure lost its execution lease');
        }
        if (failureRoute) {
          /**
           * El fallo persistido conserva la trama original. La cola de fallos recibe una referencia compacta para
           * evitar que la codificación de una trama grande exceda el límite BSON.
           */
          const notification = protocol
            .encode(
              protocol.createEnvelope({
                kind          : 'event',
                name          : 'messaging.failure',
                source        : this.scope.service,
                messageId     : failureId,
                correlationId : failureId,
                telemetry     : this.observer.captureCarrier(),
                payload       : {
                  failureId,
                  service   : this.scope.service,
                  messageId : failure.messageId,
                  handler   : failure.handler,
                  status    : failure.status,
                  error,
                  createdAt : now.toISOString(),
                  ...(raw
                    ? {
                        rawSize    : failure.rawSize,
                        rawSha256  : failure.rawSha256,
                        rawStorage : failure.rawStorage,
                      }
                    : {}),
                },
              }),
            )
            .toString();
          await this.enqueueOutbox({
            wire          : notification,
            route         : failureRoute,
            messageId     : failureId,
            publicationId : `failure:${failureId}`,
            session,
          });
        }
        return failureId;
      },
      { session: existingSession },
    );
  }

  /**
   * Comprueba que el fallo admita reprocesamiento y vuelve a encolar la entrega conservada.
   *
   * @param {Object} options Opciones y dependencias de esta operación.
   * @param {string} options.failureId Identificador del fallo persistido que se desea reprocesar.
   * @returns {Promise<Object>} Datos de la entrega reprogramada a partir del fallo persistido.
   */
  async replayFailed({ failureId }) {
    this.assertReady();
    return this.transaction(
      /**
       * Ejecuta la continuación local y propaga el resultado al flujo que la invoca.
       * @param {Object} session Sesión que agrupa las operaciones de persistencia.
       * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      async (session) => {
        const now     = new Date();
        const failure = await this.failures.findOne(this.scoped({ failureId }), { session });
        if (!failure)
          throw storeError('FAILURE_NOT_FOUND', 'The failure does not exist in this service');
        if (failure.status !== 'failed')
          throw storeError('REPLAY_NOT_ALLOWED', 'Only failed, certain executions can be replayed');
        if (failure.replayable === false)
          throw storeError(
            'REPLAY_NOT_ALLOWED',
            'This message must be repeated explicitly by its original requester',
          );
        if (failure.deadlineAt && failure.deadlineAt <= now)
          throw storeError('DEADLINE_EXCEEDED', 'An expired message cannot be replayed');
        if (!failure.route)
          throw storeError('REPLAY_NOT_ALLOWED', 'The failure has no replay destination');
        protocol.decode(failure.wire);
        if (failure.inboxId) {
          const result = await this.inbox.updateOne(
            this.scoped({
              _id    : failure.inboxId,
              status : 'failed',
              failureId,
            }),
            {
              $set   : {
                status      : 'waiting',
                availableAt : now,
                updatedAt   : now,
                attempt     : 0,
              },
              $inc   : { retryGeneration: 1 },
              $unset : {
                failureId  : '',
                failedAt   : '',
                token      : '',
                owner      : '',
                leaseUntil : '',
                expiresAt  : '',
              },
            },
            { session },
          );
          if (result.matchedCount !== 1)
            throw storeError(
              'REPLAY_NOT_ALLOWED',
              'The inbox execution is completed, active, uncertain, or has already been replayed',
            );
        }
        if (failure.outboxId) {
          const result = await this.outbox.updateOne(
            this.scoped({
              _id    : failure.outboxId,
              status : 'failed',
              failureId,
            }),
            {
              $set : {
                status     : 'replayed',
                replayedAt : now,
                updatedAt  : now,
                expiresAt  : new Date(now.getTime() + this.retentionMs),
              },
            },
            { session },
          );
          if (result.matchedCount !== 1)
            throw storeError('REPLAY_NOT_ALLOWED', 'The original publication is no longer failed');
        }
        const updated = await this.failures.updateOne(
          this.scoped({
            failureId,
            status : 'failed',
          }),
          {
            $set  : {
              status     : 'replayed',
              replayedAt : now,
              updatedAt  : now,
              expiresAt  : new Date(now.getTime() + this.retentionMs),
            },
            $push : {
              audit : {
                action : 'replayed',
                at     : now,
              },
            },
          },
          { session },
        );
        if (updated.matchedCount !== 1)
          throw storeError('REPLAY_NOT_ALLOWED', 'The failure has already been replayed');
        const outbox = await this.enqueueOutbox({
          wire          : failure.wire,
          route         : failure.route,
          messageId     : failure.messageId,
          publicationId : `replay:${failureId}`,
          availableAt   : now,
          deadlineAt    : failure.deadlineAt,
          session,
        });
        return {
          failureId,
          messageId     : failure.messageId,
          publicationId : outbox.publicationId,
          status        : 'queued',
        };
      },
    );
  }

  /** Lee un cursor acotado y libera sus recursos incluso ante timeout o cancelación.
   * @param {*} collection Valor de collection utilizado por esta operación.
   * @param {*} pipeline Valor de pipeline utilizado por esta operación.
   * @param {Object} options Opciones que delimitan el comportamiento de la operación.
   * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async _statsAggregate(collection, pipeline, options) {
    options.signal?.throwIfAborted();
    const cursor = collection.aggregate(pipeline, options);
    try {
      return await cursor.toArray();
    } finally {
      await cursor.close();
    }
  }

  /** Opciones exclusivas de lecturas de diagnóstico; no alteran operaciones de negocio.
   * @param {Object} [options] Colaboradores u opciones: signal, timeoutMS, maxTimeMS.
   * @returns {Object} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  _statsOptions({ signal, timeoutMS = 1500, maxTimeMS = timeoutMS } = {}) {
    return {
      signal,
      timeoutMS,
      maxTimeMS,
      timeoutMode : 'cursorLifetime',
    };
  }

  /**
   * Cuenta y obtiene la antigüedad únicamente de publicaciones activas usando el índice existente.
   * El recorrido puede crecer con pendientes reales, nunca con los registros históricos completados.
   * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async operationalStats(options = {}) {
    this.assertReady();
    const rows          = await this._statsAggregate(
      this.outbox,
      [
        { $match: this.scoped({ status: { $in: ['pending', 'publishing'] } }) },
        {
          $group : {
            _id    : '$status',
            count  : { $sum: 1 },
            oldest : { $min: '$createdAt' },
          },
        },
      ],
      {
        ...this._statsOptions(options),
        hint : {
          namespace   : 1,
          service     : 1,
          status      : 1,
          availableAt : 1,
          leaseUntil  : 1,
        },
      },
    );
    const outbox        = {
      pending    : 0,
      publishing : 0,
    };
    let oldestPendingAt = null;
    for (const row of rows) {
      outbox[row._id] = row.count;
      if (row.oldest && (!oldestPendingAt || row.oldest < oldestPendingAt))
        oldestPendingAt = row.oldest;
    }
    return {
      outbox,
      oldestPendingAt,
      oldestPendingAgeMs : oldestPendingAt ? Math.max(0, Date.now() - oldestPendingAt.getTime()) : 0,
    };
  }

  /**
   * Conserva el contrato de estadísticas completas; el muestreador solicita sólo el histórico.
   * Espera todas las consultas incluso si una falla para no solapar trabajos del siguiente ciclo.
   * @param {Object} [options] Opciones que delimitan el comportamiento de la operación.
   * @returns {Promise<Object>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
   */
  async stats(options = {}) {
    this.assertReady();
    const queryOptions = this._statsOptions(options);
    const jobs         = ['outbox', 'inbox', 'failures'].map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} collection Valor de collection utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (collection) =>
        this._statsAggregate(
          this[collection],
          [
            { $match: this.scoped() },
            {
              $group : {
                _id   : '$status',
                count : { $sum: 1 },
              },
            },
          ],
          queryOptions,
        ),
    );
    if (!options.historicalOnly) jobs.push(this.operationalStats(options));
    const outcomes = await Promise.allSettled(jobs);
    const failure  = outcomes.find(
      /**
       * Determina si el elemento corresponde al recurso buscado.
       * @param {*} result Valor de result utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (result) => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
    const [outbox, inbox, failures, operational] = outcomes.map(
      /**
       * Proyecta cada elemento en la estructura requerida por la operación.
       * @param {*} result Valor de result utilizado por esta operación.
       * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
       */
      (result) => result.value,
    );
    /**
     * Ejecuta counts dentro del flujo de store.
     * @param {Object[]} rows Filas obtenidas de persistencia o de una consulta.
     * @returns {*} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
     */
    const counts                                 = (rows) =>
      Object.fromEntries(
        rows.map(
          /**
           * Proyecta cada elemento en la estructura requerida por la operación.
           * @param {*} row Valor de row utilizado por esta operación.
           * @returns {Array<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
           */
          (row) => [row._id, row.count],
        ),
      );
    return {
      outbox   : counts(outbox),
      inbox    : counts(inbox),
      failures : counts(failures),
      ...(!options.historicalOnly && {
        oldestPendingAt    : operational.oldestPendingAt,
        oldestPendingAgeMs : operational.oldestPendingAgeMs,
      }),
    };
  }
}

module.exports = {
  MongoStore,
  storeError,
};
