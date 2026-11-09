/** @file Dobles de puertos para probar facturación sin red, credenciales ni bases compartidas. */
'use strict';
const { AsyncLocalStorage }      = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const { composeBilling }         = require('../server/modules/billing/compositions/billing.composition');
const { Decimal }                = require('../server/modules/billing/services/amounts.service');
const { ApplicationError }       = require('../server/shared/application-error');
const { refreshDeadline }        = require('../server/modules/billing/policies/external-refresh.policy');
/** @param {Object} value Registro. @param {Object} filter Selector derivado del caso de uso. @returns {boolean} Coincidencia compatible con las consultas de la prueba. */
function matches(value, filter) {
  return Object.entries(filter).every(
    /** @param {Array} entry Campo y condición. @returns {boolean} Coincidencia exacta o rango. */
    ([key, expected]) => {
      if (key === '$and')
        return expected.every(
          /** @param {Object} condition Selector. @returns {boolean} Coincidencia. */ (condition) =>
            matches(value, condition),
        );
      if (key === '$or')
        return expected.some(
          /** @param {Object} condition Selector. @returns {boolean} Coincidencia. */ (condition) =>
            matches(value, condition),
        );
      if (key === 'allocations.expenseCode')
        return value.allocations?.some(
          /** @param {Object} allocation Aplicación. @returns {boolean} Gasto de origen. */ (
            allocation,
          ) => allocation.expenseCode === expected,
        );
      const current = key.split('.').reduce(
        /** @param {Object} node Nodo. @param {string} name Campo. @returns {*} Valor anidado. */
        (node, name) => node?.[name],
        value,
      );
      if (expected?.$regex !== undefined)
        return new RegExp(expected.$regex, expected.$options || '').test(String(current ?? ''));
      if (expected && typeof expected === 'object')
        return Object.entries(expected).every(
          /** @param {Array} condition Operador e importe. @returns {boolean} Predicado cerrado del doble. */
          ([operator, target]) =>
            ({
              $ne  : current !== target,
              $lte : current <= target,
              $lt  : current < target,
              $gte : current >= target,
              $gt  : current > target,
              $in  : Array.isArray(target) && target.includes(current),
            })[operator],
        );
      return current === expected;
    },
  );
}
/** @returns {Object} Almacén serializable con rollback para pruebas de aplicación, sin simular garantías del servidor Mongo. */
function memoryStore() {
  const transactions = new AsyncLocalStorage();
  let state  = {},
    sequence = 0,
    tail     = Promise.resolve();
  const store = {
    /** @param {number} now Reloj. @param {string} token Propiedad del intento. @returns {Promise<Object|null>} Reserva una sola limpieza del doble. */
    async claimExpenseCleanup(now, token) {
      const row = (state['expense-file-job'] || []).find(
        /** @param {Object} job Reserva documental. @returns {boolean} Vencida y recuperable. */
        (job) =>
          job.leaseUntil <= now &&
          (job.status === 'cleaning' ||
            (job.status === 'pending' && job.updateDate <= now - 86400000)),
      );
      if (!row) return null;
      Object.assign(row, {
        status       : 'cleaning',
        leaseUntil   : now + 360000,
        cleanupToken : token,
        updateDate   : now,
        revision     : row.revision + 1,
      });
      return structuredClone(row);
    },
    /** @returns {Promise<number|undefined>} Agenda del doble con los estados privados reales. */
    async nextOperationAt() {
      const dates = (state.operation || []).flatMap(
        /** @param {Object} row Intención persistida. @returns {number[]} Sólo estados recuperables. */
        (row) =>
          row.status === 'queued'
            ? [row.availableAt]
            : row.status === 'running'
              ? [row.leaseUntil]
              : [],
      );
      return dates.length ? Math.min(...dates) : undefined;
    },
    /** @param {Object} preferences Configuración por ambiente. @returns {Promise<Object|null>} Candidato único calculado con la política de negocio. */
    async nextExternalRefresh(preferences) {
      let next = null;
      for (const document of state.document || []) {
        const deadline = refreshDeadline(
          document,
          preferences[document.issuerSnapshot?.environment],
        );
        if (Number.isFinite(deadline) && (!next || deadline < next.deadline))
          next = {
            document : structuredClone(document),
            deadline,
          };
      }
      return next;
    },
    /** @param {string} resource Tipo. @param {Object} filter Ámbito de la lista. @returns {Promise<Object[]>} Totales de prueba con Decimal.js. */
    async expenseTotals(resource, filter) {
      const totals = new Map();
      for (const row of state[resource] || []) {
        if (row.status !== 'confirmed' || !matches(row, filter)) continue;
        const total = totals.get(row.currency) || {
          currency : row.currency,
          total    : '0',
          paid     : '0',
          balance  : '0',
        };
        for (const key of ['total', 'paid', 'balance'])
          total[key] = new Decimal(total[key])
            .plus(row[resource === 'expense-payment' && key === 'total' ? 'amount' : key] || '0')
            .toFixed(2);
        totals.set(row.currency, total);
      }
      return [...totals.values()];
    },
    /** @param {string} resource Catálogo. @param {Object} value Referencia. @returns {Promise<void>} Cerca la clasificación del doble serializable. */
    async guardExpenseReference(resource, value) {
      if (
        !(await store.get(resource, {
          code     : value.code,
          revision : value.revision,
          active   : true,
        }))
      )
        throw new ApplicationError(409, 'BILLING_CLASSIFICATION_INACTIVE');
    },
    /** @param {string} key Clave. @returns {Promise<Object|null>} Recibo confirmado. */
    async receiptRead(key) {
      return structuredClone(
        (state.receipts || []).find(
          /** @param {Object} item Recibo. @returns {boolean} Identidad exacta. */ (item) =>
            item._id === key,
        ) || null,
      );
    },
    /** @param {Object} receipt Recibo. @returns {Promise<void>} Confirmación atómica. */
    async receiptInsert(receipt) {
      state.receipts ||= [];
      if (
        state.receipts.some(
          /** @param {Object} item Recibo. @returns {boolean} Identidad repetida. */ (item) =>
            item._id === receipt._id,
        )
      )
        throw new ApplicationError(409, 'DUPLICATE_RECEIPT');
      state.receipts.push(structuredClone(receipt));
    },
    /** @param {string} resource Recurso. @param {Object} filter Ámbito. @returns {Promise<Object|null>} Copia de lectura. */
    async get(resource, filter) {
      return structuredClone(
        (state[resource] || []).find(
          /** @param {Object} item Registro. @returns {boolean} Coincidencia. */
          (item) => matches(item, filter),
        ) || null,
      );
    },
    /** @param {string} resource Tipo. @param {Object} filter Ámbito. @param {Object} query Página. @returns {Promise<Object>} Página estable. */
    async list(resource, filter, query = {}) {
      const items = (state[resource] || []).filter(
          /** @param {Object} item Registro. @returns {boolean} Coincidencia. */
          (item) => matches(item, filter),
        ),
        page      = query.page || 1,
        perPage   = query.perPage || 20;
      return {
        items      : structuredClone(items.slice((page - 1) * perPage, page * perPage)),
        pagination : {
          page,
          perPage,
          total : items.length,
        },
      };
    },
    /** @param {string} resource Tipo. @param {Object} value Alta. @returns {Promise<void>} Rechaza identidad e idempotencia duplicadas. */
    async insert(resource, value) {
      state[resource] ||= [];
      if (
        state[resource].some(
          /** @param {Object} item Registro. @returns {boolean} Clave única ya ocupada. */
          (item) =>
            item.workspace === value.workspace &&
            (item.code === value.code ||
              (value.idempotencyKey && item.idempotencyKey === value.idempotencyKey)),
        )
      )
        throw new ApplicationError(409, 'BILLING_DUPLICATE_OPERATION');
      state[resource].push(structuredClone(value));
    },
    /** @param {string} resource Tipo. @param {Object} previous Revisión. @param {Object} updated Siguiente revisión. @returns {Promise<void>} Escritura optimista. */
    async replace(resource, previous, updated) {
      const index = (state[resource] || []).findIndex(
        /** @param {Object} item Registro. @returns {boolean} Identidad y revisión exactas. */
        (item) =>
          item.code === previous.code &&
          item.workspace === previous.workspace &&
          item.revision === previous.revision,
      );
      if (index < 0) throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
      state[resource][index] = structuredClone(updated);
    },
    /** @param {Function} work Operaciones puras de persistencia. @returns {Promise<*>} Confirmación serializable o rollback. */
    async transaction(work) {
      if (transactions.getStore()) return work(store);
      const previous = tail;
      let release;
      tail = new Promise(
        /** @param {Function} resolve Liberación del turno. @returns {void} Instala la barrera. */
        (resolve) => {
          release = resolve;
        },
      );
      await previous;
      const snapshot = structuredClone(state),
        folio        = sequence;
      try {
        return await transactions.run(
          true,
          /** @returns {Promise<Object>} Unidad anidada. */ () => work(store),
        );
      } catch (error) {
        state = snapshot;
        sequence = folio;
        throw error;
      } finally {
        release();
      }
    },
    /** @param {Object} issuer Emisor observado. @returns {Promise<void>} Comprueba identidad y revisión en la transacción serial del doble. */
    async guardIssuer(issuer) {
      if (
        !(await store.get('issuer', {
          code      : issuer.code,
          workspace : issuer.workspace,
          revision  : issuer.revision,
        }))
      )
        throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
    },
    /** @returns {Promise<string>} Folio local de prueba. */
    async folio() {
      return String(++sequence);
    },
    /** @param {number} now Reloj. @param {string} token Cerco. @returns {Promise<Object|null>} Primera intención disponible. */
    async claim(now, token) {
      return store.transaction(
        /** @returns {Promise<Object|null>} Adquisición exclusiva del doble. */
        async () => {
          const previous = await store.get('operation', {
            status      : 'queued',
            availableAt : { $lte: now },
          });
          if (!previous) return null;
          const updated = {
            ...previous,
            status   : 'running',
            token,
            revision : previous.revision + 1,
          };
          await store.replace('operation', previous, updated);
          return updated;
        },
      );
    },
  };
  return store;
}
/** @param {Object} options Puerto de persistencia opcional para aceptación Mongo. @returns {Object} Aplicación completa con referencias y PAC controlables por cada prueba. */
function fixture(options = {}) {
  const execution = new AsyncLocalStorage();
  const store = options.store || memoryStore(),
    calls     = [],
    state     = {
      sat         : 'Vigente',
      pacError    : null,
      uploadError : false,
    },
    actor     = {
      workspace : 'W1',
      user      : { userCode: 'U1' },
      policies  : [],
    };
  for (const resource of [
    'sale',
    'sale-extraction',
    'issuer',
    'document',
    'receipt',
    'operation',
    'audit',
    'issuance',
    'cancellation',
    'delivery',
  ])
    for (const action of ['view', 'create', 'update', 'delete'])
      actor.policies.push(`billing.${resource}.${action}.workspace`);
  actor.policies.push('billing.pac.view.global', 'billing.pac.update.global');
  const customer   = {
    customerCode : 'CUS1',
    revision     : 1,
    state        : 'customer',
    fiscal       : {
      taxId     : 'AAA010101AAA',
      legalName : 'CLIENTE',
      taxRegime : '601',
      address   : {
        country    : 'México',
        postalCode : '01000',
      },
    },
  };
  const references = {
    /** @returns {Promise<Object>} Cliente canónico. */
    async customer() {
      return structuredClone(customer);
    },
    /** @param {Object} query Consulta. @returns {Promise<Object>} Referencias suficientes para las reglas verificadas. */
    async catalog(query) {
      return {
        items      :
          query.kind === 'currency'
            ? [
                {
                  code     : query.code,
                  decimals : 2,
                },
              ]
            : [
                {
                  code        : '1',
                  tax         : '002',
                  factor      : 'Tasa',
                  kind        : 'fixed',
                  max         : '0.16',
                  min         : '0',
                  transferred : true,
                  withheld    : false,
                },
              ],
        pagination : { total: 1 },
      };
    },
    /** @returns {Promise<Object>} Validez externa; sus reglas tienen pruebas propias en Directory. */
    async values() {
      return { valid: true };
    },
    /** @returns {Promise<Object>} Compatibilidad externa. */
    async profile() {
      return { valid: true };
    },
    /** @param {string} workspace Destino explícito. @returns {Promise<Object|null>} Permisos vigentes en los espacios de aceptación. */
    async principal(workspace) {
      if (state.revoked) return null;
      return ['W1', 'W2'].includes(workspace)
        ? {
            ...actor,
            scopes : [
              'billing:read',
              'billing:write',
              'billing:issuers',
              'billing:issue',
              'billing:cancel',
              'billing:send',
              'billing:receipts',
              'billing:reconcile',
            ],
            workspace,
          }
        : null;
    },
    /** @param {Object} context Contexto. @param {Function} work Trabajo. @returns {Promise<*>} Resultado aislado de prueba. */
    async run(context, work) {
      return execution.run(context, work);
    },
  };
  const pac        = {
    /** @param {string} envelope Reemplazo de prueba. @param {string} environment Ambiente. @param {string} code Identidad. @param {Object} previous Cuenta anterior. @returns {string} Custodia simulada sin secretos reales. */
    preparePac(envelope, environment, code, previous) {
      return envelope || previous?.secretEnvelope || 'test-pac';
    },
    /** @returns {Promise<Object>} Créditos simulados sin acceso al PAC real. */
    async credits() {
      return {
        code : '200',
        data : '42',
      };
    },
    /** @returns {Object} Custodia simulada sin credenciales reales. */
    prepareCsd() {
      return {
        csdEnvelope : 'encrypted',
        certificate : {
          serial     : '30001000000500003416',
          validFrom  : 0,
          validUntil : 9999999999999,
        },
      };
    },
    /** @param {Object} previous Emisor anterior. @param {Object} next Destino. @returns {string} Recifrado simulado o fallo inyectado. */
    rebindCsd(previous, next) {
      if (state.rebindError) throw new Error('REBIND_FAILED');
      return 'encrypted:' + next.workspace;
    },
    /** @param {Object} issuer Emisor. @param {Object} layout Layout calculado. @returns {Promise<Object>} Respuesta controlada del proveedor. */
    async issue(issuer, layout) {
      calls.push(structuredClone(layout));
      (state.pacCalls ||= []).push(structuredClone(issuer.pacConfig));
      if (state.pacError)
        throw new ApplicationError(502, 'BILLING_PAC_OUTCOME_UNKNOWN', { uncertain: true });
      if (state.pacResponse) return state.pacResponse;
      return {
        code : '200',
        data : JSON.stringify({
          uuid : randomUUID().toUpperCase(),
          xml  : '<test/>',
          pdf  : 'JVBERi0=',
        }),
      };
    },
    /** @param {Object} result Respuesta. @returns {Object} Decodificación simulada; el adaptador XML se prueba por separado. */
    decodeResult(result) {
      return JSON.parse(result.data);
    },
    /** @param {Object} issuer Emisor. @param {string} uuid UUID. @returns {Promise<Object>} Recuperación con la identidad indicada. */
    async recover(issuer, uuid) {
      return {
        code : '200',
        data : JSON.stringify({
          uuid,
          xml : '<test/>',
          pdf : 'JVBERi0=',
        }),
      };
    },
    /** @returns {Promise<Object>} Acuse de solicitud, sin implicar cancelación. */
    async cancel() {
      return {
        code   : '201',
        data   : '<acuse/>',
        status : 'success',
      };
    },
    /** @returns {Promise<Object>} Estado SAT controlado. */
    async status() {
      state.statusCalls = (state.statusCalls || 0) + 1;
      return {
        Estado             : state.sat,
        EsCancelable       : 'Cancelable sin aceptación',
        EstatusCancelacion : state.sat === 'Cancelado' ? 'Cancelado sin aceptación' : 'En proceso',
        CodigoEstatus      : 'S - Comprobante obtenido satisfactoriamente.',
      };
    },
    /** @returns {Promise<Object>} Acuse final. */
    async ack() {
      return {
        code : '200',
        data : '<acuse/>',
      };
    },
  };
  const files      = {
    /** @returns {Promise<boolean>} La referencia del doble ya está disponible. */
    async hasPdf() {
      return true;
    },
    /** @returns {Promise<string>} Evidencia sintética; la acreditación real se prueba en el adaptador. */
    async readXml() {
      return '<test/>';
    },
    /** @param {Object} document CFDI. @param {string} xml Evidencia. @param {string} fileId Referencia reservada. @returns {Promise<string>} PDF propio simulado con fallo de almacenamiento controlable. */
    async generatePdf(document, xml, fileId) {
      (state.pdfCalls ||= []).push({
        fileId,
        code : document.code,
        xml,
      });
      if (state.pdfBarrier) await state.pdfBarrier;
      if (state.pdfError || state.uploadError) throw new ApplicationError(503, 'FILES_UNAVAILABLE');
      return fileId;
    },
    /** @param {Object} document Comprobante. @param {string} kind Clase. @param {string} id Identidad estable. @returns {Promise<string>} Persistencia documental simulada. */
    async upload(document, kind, id) {
      if (state.uploadError) throw new ApplicationError(503, 'FILES_UNAVAILABLE');
      return id;
    },
    /** @returns {Promise<Object>} Temporal de prueba sin acceso a disco. */
    async read() {
      return {
        tempFilePath : '/tmp/test',
        fileName     : 'test.xml',
        mimeType     : 'application/xml',
      };
    },
  };
  const services   = composeBilling({
    store,
    expenseFiles : options.expenseFiles,
    references   : {
      ...references,
      ...options.references,
    },
    pac          : {
      ...pac,
      ...options.pac,
    },
    files        : {
      ...files,
      ...options.files,
    },
    delivery     : {
      /** @param {Object} document Archivo acreditado. @returns {Promise<void>} Transporte sustituido sin envío. */
      async send(document) {
        (state.delivered ||= []).push(structuredClone(document));
      },
    },
    /** @returns {Object} Actor de la prueba. */
    context      : () => execution.getStore() || actor,
    /** @returns {number} Fecha reproducible. */
    clock        : () => (options.clock ? options.clock() : Date.parse('2026-10-22T12:00:00Z')),
    /** @param {string} resource Tipo. @returns {string} Identidad única. */
    identifier   : (resource) => resource + '-' + randomUUID(),
    uuid         : randomUUID,
    /** @param {Object} value Entrada estable de prueba. @returns {string} Huella de contenido. */
    hash         : (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
  return {
    ...services,
    store,
    actor,
    customer,
    calls,
    state,
  };
}
const issuerInput = {
  workspace  : 'W1',
  name       : 'Emisor',
  taxId      : 'BBB010101BBB',
  legalName  : 'EMISOR',
  taxRegime  : '601',
  postalCode : '01000',
  series     : {
    I : 'F',
    E : 'NC',
    P : 'P',
  },
  active     : true,
};
const line        = {
  description    : 'Servicio',
  productService : '01010101',
  unit           : 'E48',
  unitName       : 'Servicio',
  quantity       : '1',
  unitPrice      : '100',
  discount       : '0',
  taxObject      : '02',
  taxes          : [
    {
      kind   : 'transferred',
      code   : '002',
      factor : 'Tasa',
      rate   : '0.16',
    },
  ],
};
/** @param {Object} app Aplicación. @returns {Promise<Object>} Emisor configurado con custodia simulada. */
async function issuer(app) {
  if (
    !(await app.store.get('pac', {
      workspace : 'allWorkspaces',
      code      : 'global',
    }))
  )
    await app.pacSettings.update({
      revision    : 0,
      environment : 'development',
      envelope    : 'test-pac',
    });
  const created = await app.records.create('issuer', {
    ...issuerInput,
    workspace : app.actor.workspace,
  });
  return app.records.setCsd({
    code     : created.code,
    revision : created.revision,
    envelope : 'sealed',
  });
}
/** @param {Object} app Aplicación. @param {Object} sender Emisor. @param {Object} changes Variaciones de prueba. @returns {Promise<Object>} Borrador calculado. */
async function draft(app, sender, changes = {}) {
  return app.records.create('document', {
    type          : 'I',
    issuerCode    : sender.code,
    customerCode  : 'CUS1',
    currency      : 'MXN',
    exchangeRate  : '1',
    paymentMethod : 'PPD',
    paymentForm   : '99',
    cfdiUse       : 'G03',
    date          : '2026-10-22T06:00:00',
    lines         : [line],
    notes         : '',
    ...changes,
  });
}
/** @param {Object} app Aplicación. @param {Object} document Borrador. @returns {Promise<Object>} Comprobante emitido usando el trabajador real con PAC simulado. */
async function issue(app, document) {
  await app.commands.enqueue('issue', {
    code           : document.code,
    revision       : document.revision,
    idempotencyKey : randomUUID(),
  });
  await app.effects.tick();
  return app.records.getOne('document', { code: document.code });
}
module.exports = {
  fixture,
  memoryStore,
  issuer,
  draft,
  issue,
  line,
};
