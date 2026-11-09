/** @file Persistencia MongoDB con workspace, revisiones, folios e invalidaciones documentales en el outbox transaccional. */
'use strict';
const { AsyncLocalStorage }     = require('node:async_hooks');
const { ApplicationError }      = require('../../../shared/application-error');
const { billingDocumentChange } = require('../presenters/billing-change.presenter');
const REALTIME_RESOURCES        = [
  'issuer',
  'document',
  'receipt',
  'operation',
  'audit',
  'sale',
  'expense',
  'expense-payment',
  'expense-category',
  'cost-center',
  'pac',
  'sale-extraction',
];
const RESOURCES                 = [
  'expense',
  'expense-payment',
  'expense-category',
  'cost-center',
  'expense-file-job',
  'sale',
  'sale-extraction',
  'issuer',
  'document',
  'receipt',
  'operation',
  'audit',
  'global-operation',
  'pac',
  'pac-revision',
];
/** @param {Object|null} value Documento técnico. @returns {Object|null} Registro plano. */
function plain(value) {
  if (!value) return null;
  const item = { ...value };
  delete item._id;
  return item;
}
/** @param {Object} dependencies Base y cliente abiertos, publicador durable obligatorio y sesión opcional interna. @returns {Object} Puerto sin conexiones implícitas. */
function createBillingStore({ db, client, publish, session, local = new AsyncLocalStorage() }) {
  if (typeof publish !== 'function') throw new TypeError('BILLING_EVENT_PUBLISHER_REQUIRED');
  /** @returns {Object} Sesión explícita o transacción exterior de esta instancia. */
  const options = () => {
    const current = session || local.getStore();
    return current ? { session: current } : {};
  };
  /** @param {string} resource Recurso canónico. @returns {Object} Colección propia. */
  function collection(resource) {
    if (!RESOURCES.includes(resource)) throw new TypeError('INVALID_BILLING_RESOURCE');
    return db.collection('BILLING_' + resource.replaceAll('-', '_').toUpperCase());
  }
  return {
    /** @returns {Promise<number|undefined>} Vencimiento de una reserva documental o de su limpieza interrumpida. */
    async nextExpenseCleanupAt() {
      const [row] = await collection('expense-file-job')
        .aggregate(
          [
            { $match: { status: { $in: ['pending', 'cleaning'] } } },
            {
              $project : {
                deadline : {
                  $max : [
                    { $ifNull: ['$leaseUntil', 0] },
                    {
                      $cond : [
                        { $eq: ['$status', 'pending'] },
                        { $add: ['$updateDate', 86400000] },
                        0,
                      ],
                    },
                  ],
                },
              },
            },
            { $sort: { deadline: 1 } },
            { $limit: 1 },
          ],
          options(),
        )
        .toArray();
      return row?.deadline;
    },
    /** @param {number} now Reloj acreditado. @param {string} token Cerco del efecto. @returns {Promise<Object|null>} Reclamación atómica de una sola reserva. */
    async claimExpenseCleanup(now, token) {
      return plain(
        await collection('expense-file-job').findOneAndUpdate(
          {
            leaseUntil : { $lte: now },
            $or        : [
              {
                status     : 'pending',
                updateDate : { $lte: now - 86400000 },
              },
              { status: 'cleaning' },
            ],
          },
          {
            $set : {
              status       : 'cleaning',
              leaseUntil   : now + 360000,
              cleanupToken : token,
              updateDate   : now,
            },
            $inc : { revision: 1 },
          },
          {
            returnDocument : 'after',
            sort           : {
              leaseUntil : 1,
              code       : 1,
            },
          },
        ),
      );
    },
    /** @returns {Promise<number|undefined>} Próxima operación aceptada o recuperación de un intento interrumpido. */
    async nextOperationAt() {
      const pending  = await collection('operation').findOne(
        { status: 'queued' },
        {
          projection : { availableAt: 1 },
          sort       : { availableAt: 1 },
        },
      );
      const running  = await collection('operation').findOne(
        { status: 'running' },
        {
          projection : { leaseUntil: 1 },
          sort       : { leaseUntil: 1 },
        },
      );
      const deadline = Math.min(pending?.availableAt ?? Infinity, running?.leaseUntil ?? Infinity);
      return Number.isFinite(deadline) ? deadline : undefined;
    },
    /** @param {Object} preferences Preferencias vigentes por ambiente. @returns {Promise<Object|null>} Un solo comprobante habilitado con su vencimiento efectivo. */
    async nextExternalRefresh(preferences) {
      let next = null;
      for (const environment of ['development', 'production']) {
        const preference = preferences[environment];
        if (!preference?.enabled) continue;
        const [row] = await collection('document')
          .aggregate(
            [
              {
                $match : {
                  status                       : 'cancel-requested',
                  activeOperation              : '',
                  'issuerSnapshot.environment' : environment,
                  externalRefreshBlocked       : { $ne: true },
                },
              },
              {
                $project : {
                  document : '$$ROOT',
                  deadline : {
                    $max : [
                      {
                        $add : [
                          {
                            $max : [
                              { $ifNull: ['$sat.checkedAt', { $ifNull: ['$creationDate', 0] }] },
                              { $ifNull: ['$externalRefreshLastStartedAt', 0] },
                              preference.changedAt || 0,
                            ],
                          },
                          preference.intervalSeconds * 1000,
                        ],
                      },
                      { $ifNull: ['$externalRefreshRetryAt', 0] },
                    ],
                  },
                },
              },
              {
                $sort : {
                  deadline        : 1,
                  'document.code' : 1,
                },
              },
              { $limit: 1 },
            ],
            options(),
          )
          .toArray();
        if (row && (!next || row.deadline < next.deadline))
          next = {
            document : plain(row.document),
            deadline : row.deadline,
          };
      }
      return next;
    },
    /** @param {string} resource Catálogo global. @param {Object} value Revisión leída. @returns {Promise<void>} Serializa nuevas referencias con su desactivación. */
    async guardExpenseReference(resource, value) {
      if (!options().session || !['expense-category', 'cost-center'].includes(resource))
        throw new TypeError('BILLING_TRANSACTION_REQUIRED');
      const result = await collection(resource).updateOne(
        {
          code     : value.code,
          revision : value.revision,
          active   : true,
        },
        { $inc: { referenceRevision: 1 } },
        options(),
      );
      if (result.matchedCount !== 1) throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
    },
    /** @param {string} key Identidad privada de la intención. @returns {Promise<Object|null>} Recibo confirmado. */
    receiptRead(key) {
      return db.collection('BILLING_OPERATION_RECEIPTS').findOne({ _id: key }, options());
    },
    /** @param {Object} receipt Respuesta e identidad de la intención. @returns {Promise<Object>} Recibo atómico con cambios y eventos. */
    receiptInsert(receipt) {
      if (!options().session) throw new TypeError('BILLING_TRANSACTION_REQUIRED');
      return db.collection('BILLING_OPERATION_RECEIPTS').insertOne({ ...receipt }, options());
    },

    /** @param {string} resource Recurso. @param {Object} filter Selector autorizado. @returns {Promise<Object|null>} Registro o ausencia real. */
    async get(resource, filter) {
      return plain(await collection(resource).findOne(filter, options()));
    },
    /** @param {string} resource Recurso. @param {Object} filter Selector autorizado. @param {Object} query Página acotada. @returns {Promise<Object>} Página estable y total del mismo ámbito. */
    async list(resource, filter, query = {}) {
      const page = query.page || 1,
        perPage  = query.perPage || 20;
      const items = await collection(resource)
        .find(filter, options())
        .sort({
          creationDate : -1,
          code         : 1,
        })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .toArray();
      return {
        items      : items.map(plain),
        pagination : {
          page,
          perPage,
          total : await collection(resource).countDocuments(filter, options()),
        },
      };
    },
    /** @param {string} resource Gastos o pagos. @param {Object} filter Ámbito y filtros acreditados. @returns {Promise<Object[]>} Importes confirmados agrupados sin aritmética binaria. */
    async expenseTotals(resource, filter) {
      if (!['expense', 'expense-payment'].includes(resource))
        throw new TypeError('INVALID_BILLING_RESOURCE');
      return collection(resource)
        .aggregate(
          [
            { $match: { $and: [filter, { status: 'confirmed' }] } },
            {
              $group : {
                _id     : '$currency',
                total   : { $sum: { $toDecimal: resource === 'expense' ? '$total' : '$amount' } },
                paid    : { $sum: { $toDecimal: { $ifNull: ['$paid', '0'] } } },
                balance : { $sum: { $toDecimal: { $ifNull: ['$balance', '0'] } } },
              },
            },
            { $sort: { _id: 1 } },
            {
              $project : {
                _id      : 0,
                currency : '$_id',
                total    : { $toString: '$total' },
                paid     : { $toString: '$paid' },
                balance  : { $toString: '$balance' },
              },
            },
          ],
          options(),
        )
        .toArray();
    },
    /** @param {string} resource Recurso. @param {Object} record Alta. @returns {Promise<void>} Confirma alta y aviso documental juntos; rechaza duplicados y revierte si falla el outbox. */
    async insert(resource, record) {
      if (REALTIME_RESOURCES.includes(resource) && !options().session)
        return this.transaction(
          /** @param {Object} tx Unidad de trabajo. @returns {Promise<void>} Alta y aviso atómicos incluso fuera de una transacción del caso de uso. */
          (tx) => tx.insert(resource, record),
        );
      try {
        await collection(resource).insertOne({ ...record }, options());
      } catch (error) {
        if (error.code === 11000)
          throw new ApplicationError(
            409,
            resource === 'expense' && error.keyPattern?.uuid
              ? 'BILLING_EXPENSE_XML_DUPLICATE'
              : 'BILLING_DUPLICATE_OPERATION',
          );
        throw error;
      }
      if (REALTIME_RESOURCES.includes(resource))
        await publish('billing.' + resource + '.changed', billingDocumentChange(record), options());
    },
    /** @param {string} resource Recurso. @param {Object} previous Revisión observada. @param {Object} next Revisión siguiente. @returns {Promise<void>} Escritura condicional y aviso documental atómicos; propaga conflictos y fallos del outbox. */
    async replace(resource, previous, next) {
      if (REALTIME_RESOURCES.includes(resource) && !options().session)
        return this.transaction(
          /** @param {Object} tx Unidad de trabajo. @returns {Promise<void>} Revisión y aviso confirmados juntos. */
          (tx) => tx.replace(resource, previous, next),
        );
      let result;
      try {
        result = await collection(resource).replaceOne(
          {
            code      : previous.code,
            workspace : previous.workspace,
            revision  : previous.revision,
          },
          { ...next },
          options(),
        );
      } catch (error) {
        if (error.code === 11000)
          throw new ApplicationError(
            409,
            resource === 'expense' && error.keyPattern?.uuid
              ? 'BILLING_EXPENSE_XML_DUPLICATE'
              : 'BILLING_DUPLICATE_OPERATION',
          );
        throw error;
      }
      if (result.matchedCount !== 1) throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
      if (REALTIME_RESOURCES.includes(resource))
        await publish(
          'billing.' + resource + '.changed',
          {
            ...billingDocumentChange(next),
            previousWorkspace : previous.workspace || 'allWorkspaces',
          },
          options(),
        );
    },
    /** @param {Object} issuer Emisor observado. @returns {Promise<void>} Serializa nuevas referencias con la reasignación dentro de la misma transacción, sin cambiar la revisión pública. */
    async guardIssuer(issuer) {
      if (!options().session) throw new TypeError('BILLING_TRANSACTION_REQUIRED');
      const result = await collection('issuer').updateOne(
        {
          code      : issuer.code,
          workspace : issuer.workspace,
          revision  : issuer.revision,
        },
        { $inc: { referenceRevision: 1 } },
        options(),
      );
      if (result.matchedCount !== 1) throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
    },
    /** @param {Function} work Caso de uso sin efectos externos. @returns {Promise<*>} Resultado confirmado o rollback completo. */
    async transaction(work) {
      if (options().session) return work(this);
      const owned = client.startSession();
      let result;
      try {
        await owned.withTransaction(
          /** @returns {Promise<void>} Ejecuta únicamente persistencia repetible. */
          async () => {
            result = await local.run(
              owned,
              /** @returns {Promise<Object>} Todos los colaboradores comparten el commit exterior. */ () =>
                work(
                  createBillingStore({
                    db,
                    client,
                    publish,
                    session : owned,
                    local,
                  }),
                ),
            );
          },
          { readConcern: { level: 'snapshot' } },
        );
        return result;
      } finally {
        await owned.endSession();
      }
    },
    /** @param {Object} issuer Emisor. @param {string} type Tipo CFDI. @returns {Promise<string>} Folio reservado atómicamente dentro de la transacción. */
    async folio(issuer, type) {
      const result = await db.collection('BILLING_FOLIO').findOneAndUpdate(
        {
          issuerCode  : issuer.code,
          environment : issuer.environment,
          type,
          series      : issuer.series[type],
        },
        { $inc: { value: 1 } },
        {
          ...options(),
          upsert         : true,
          returnDocument : 'after',
        },
      );
      return String(result.value);
    },
    /** @param {number} now Reloj. @param {string} token Cerco del trabajador. @returns {Promise<Object|null>} Trabajo exclusivo; nunca reejecuta automáticamente un envío incierto. */
    async claim(now, token) {
      const expired = await collection('operation').findOne({
        status     : 'running',
        leaseUntil : { $lte: now },
      });
      if (expired)
        await this.transaction(
          /** @param {Object} tx Transacción. @returns {Promise<void>} Vence el intento y su estado documental sin reenviar ningún efecto. */
          async (tx) => {
            const operation = await tx.get('operation', {
              code      : expired.code,
              workspace : expired.workspace,
            });
            if (!operation || operation.status !== 'running' || operation.leaseUntil > now) return;
            await tx.replace('operation', operation, {
              ...operation,
              status     : 'uncertain',
              error      : 'BILLING_WORKER_INTERRUPTED',
              updateDate : now,
              revision   : operation.revision + 1,
            });
            if (operation.kind === 'authorize') return;
            const document = await tx.get('document', {
              code      : operation.targetCode,
              workspace : operation.workspace,
            });
            if (!document) return;
            const changes = {};
            if (
              operation.kind === 'issue' &&
              document.activeOperation === operation.code &&
              !document.ledgerApplied
            )
              changes.status = 'uncertain';
            if (operation.kind === 'deliver' && document.deliveryOperation === operation.code)
              changes.deliveryStatus = 'uncertain';
            if (Object.keys(changes).length)
              await tx.replace('document', document, {
                ...document,
                ...changes,
                error      : 'BILLING_WORKER_INTERRUPTED',
                updateDate : now,
                revision   : document.revision + 1,
              });
          },
        );
      return this.transaction(
        /** @param {Object} tx Unidad de trabajo. @returns {Promise<Object|null>} Reclama y publica el cambio atómicamente. */
        (tx) => tx.claimQueued(now, token),
      );
    },
    /** @param {number} now Instante de reclamo. @param {string} token Fencing del trabajador. @returns {Promise<Object|null>} Operación reclamada con su aviso durable. */
    async claimQueued(now, token) {
      if (!options().session) throw new TypeError('BILLING_TRANSACTION_REQUIRED');
      const operation = plain(
        await collection('operation').findOneAndUpdate(
          {
            status      : 'queued',
            availableAt : { $lte: now },
          },
          {
            $set : {
              status     : 'running',
              token,
              leaseUntil : now + 1800000,
              updateDate : now,
            },
            $inc : { revision: 1 },
          },
          {
            ...options(),
            sort           : {
              creationDate : 1,
              code         : 1,
            },
            returnDocument : 'after',
          },
        ),
      );
      if (operation)
        await publish('billing.operation.changed', billingDocumentChange(operation), options());
      return operation;
    },
  };
}
module.exports = { createBillingStore };
