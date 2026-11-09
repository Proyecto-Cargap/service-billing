/** @file Prueba las escrituras reales del repositorio y su outbox con una unidad transaccional controlada. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  createBillingStore,
} = require('../server/modules/billing/repositories/billing-store.repository');
const document = {
  code         : 'D1',
  revision     : 1,
  workspace    : 'W1',
  userCreate   : 'U1',
  userAssigned : 'U2',
  total        : '116.00',
  credentials  : 'private-fixture',
};
/** @returns {Object} Repositorio productivo con doble Mongo que confirma o revierte documentos y outbox juntos. */
function fixture() {
  let committed     = {},
    failPublication = false,
    sessions        = 0;
  const db     = {
    /** @param {string} name Colección. @returns {Object} Operaciones con la misma sesión que el repositorio suministra. */
    collection(name) {
      return {
        /** @param {Object} value Registro. @param {Object} options Sesión activa. @returns {Promise<void>} Agrega al estado transaccional. */
        async insertOne(value, options = {}) {
          const state = options.session ? options.session.state : committed;
          state[name] ||= [];
          if (
            state[name].some(
              /** @param {Object} item Registro previo. @returns {boolean} Clave ocupada. */
              (item) => item.code && item.code === value.code,
            )
          )
            throw Object.assign(new Error('duplicate'), { code: 11000 });
          state[name].push(structuredClone(value));
        },
        /** @param {Object} filter Revisión esperada. @param {Object} value Siguiente registro. @param {Object} options Sesión. @returns {Promise<Object>} Coincidencia de la escritura condicional. */
        async replaceOne(filter, value, options = {}) {
          const state = options.session ? options.session.state : committed;
          const rows = state[name] || [],
            index    = rows.findIndex(
              /** @param {Object} item Registro almacenado. @returns {boolean} Identidad, workspace y revisión coinciden. */
              (item) =>
                Object.entries(filter).every(
                  /** @param {Array} field Campo y valor exigidos. @returns {boolean} Coincidencia exacta. */
                  ([key, expected]) => item[key] === expected,
                ),
            );
          if (index < 0) return { matchedCount: 0 };
          rows[index] = structuredClone(value);
          return { matchedCount: 1 };
        },
      };
    },
  };
  const client = {
    /** @returns {Object} Sesión aislada que sólo confirma tras resolver todo el callback. */
    startSession() {
      sessions++;
      return {
        state : null,
        /** @param {Function} work Escrituras. @returns {Promise<void>} Descarta el estado provisional si el callback falla. */
        async withTransaction(work) {
          this.state = structuredClone(committed);
          await work();
          committed = this.state;
        },
        /** @returns {Promise<void>} Libera exclusivamente el estado de la sesión. */
        async endSession() {
          this.state = null;
        },
      };
    },
  };
  const store  = createBillingStore({
    db,
    client,
    /** @param {string} name Evento. @param {Object} data Aviso. @param {Object} options Sesión Mongo. @returns {Promise<void>} Persiste el aviso dentro de la sesión recibida. */
    async publish(name, data, options) {
      assert.ok(options.session?.state);
      if (failPublication) throw new Error('outbox unavailable');
      await db.collection('outbox').insertOne(
        {
          name,
          data,
        },
        options,
      );
    },
  });
  return {
    store,
    /** @returns {Object} Instantánea confirmada. */
    snapshot() {
      return structuredClone(committed);
    },
    /** @returns {number} Sesiones creadas. */
    sessions() {
      return sessions;
    },
    /** @returns {void} Fuerza un fallo al persistir el aviso. */
    fail() {
      failPublication = true;
    },
  };
}
test('Alta y revisión documental confirman un aviso mínimo en la misma transacción' /** @returns {Promise<void>} Ejecuta el repositorio real y verifica ausencia de contenido fiscal en el aviso. */, async () => {
  const f = fixture();
  await f.store.insert('document', document);
  const next = {
    ...document,
    revision : 2,
    status   : 'issued',
  };
  await f.store.transaction(
    /** @param {Object} tx Unidad vigente. @returns {Promise<void>} La escritura anidada reutiliza la sesión. */
    async (tx) => {
      await tx.transaction(
        /** @param {Object} nested Misma unidad de trabajo. @returns {Promise<void>} Actualiza bajo la misma transacción. */
        (nested) => nested.replace('document', document, next),
      );
    },
  );
  assert.equal(f.sessions(), 2);
  const state = f.snapshot();
  assert.equal(state.BILLING_DOCUMENT[0].revision, 2);
  assert.deepEqual(
    state.outbox.map(
      /** @param {Object} event Aviso. @returns {Object} Contrato persistido. */
      (event) => event.data,
    ),
    [1, 2].map(
      /** @param {number} revision Revisión confirmada. @returns {Object} Lista explícita de campos públicos. */
      (revision) => ({
        ...(revision === 2 ? { previousWorkspace: 'W1' } : {}),
        item : {
          code         : 'D1',
          revision,
          workspace    : 'W1',
          userCreate   : 'U1',
          userAssigned : 'U2',
        },
      }),
    ),
  );
  assert.equal(state.outbox[0].name, 'billing.document.changed');
});
test('Rollback, conflicto y fallo de outbox no dejan cambios ni avisos parciales' /** @returns {Promise<void>} El fallo se propaga y el estado confirmado permanece íntegro. */, async () => {
  const f = fixture();
  await assert.rejects(
    f.store.transaction(
      /** @param {Object} tx Unidad. @returns {Promise<void>} Simula un fallo de negocio después de guardar. */
      async (tx) => {
        await tx.insert('document', document);
        throw new Error('rollback');
      },
    ),
    /rollback/,
  );
  assert.deepEqual(f.snapshot(), {});
  await f.store.insert('document', document);
  const before = f.snapshot();
  await assert.rejects(
    f.store.replace(
      'document',
      {
        ...document,
        revision : 99,
      },
      {
        ...document,
        revision : 100,
      },
    ),
    /BILLING_REVISION_CONFLICT/,
  );
  await assert.rejects(f.store.insert('document', document), /BILLING_DUPLICATE_OPERATION/);
  assert.deepEqual(f.snapshot(), before);
  f.fail();
  await assert.rejects(
    f.store.replace('document', document, {
      ...document,
      revision : 2,
    }),
    /outbox unavailable/,
  );
  assert.deepEqual(f.snapshot(), before);
});
test('Cada recurso público emite su propio aviso y la composición exige un publicador' /** @returns {Promise<void>} Evita avisos espurios y fallos silenciosos de configuración. */, async () => {
  const f = fixture();
  for (const resource of [
    'issuer',
    'operation',
    'audit',
    'expense-category',
    'cost-center',
    'pac',
    'sale-extraction',
  ]) {
    await f.store.insert(resource, document);
    assert.equal(f.snapshot().outbox.at(-1).name, 'billing.' + resource + '.changed');
  }
  const count = f.snapshot().outbox.length;
  await f.store.insert('expense-file-job', document);
  assert.equal(f.snapshot().outbox.length, count);
  assert.throws(
    /** @returns {Object} Construcción incompleta deliberada. */
    () =>
      createBillingStore({
        db     : {},
        client : {},
      }),
    /BILLING_EVENT_PUBLISHER_REQUIRED/,
  );
});
