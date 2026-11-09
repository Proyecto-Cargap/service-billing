/** @file Migra identidad y consecutivos de emisores con diagnóstico previo y Billing detenido; no mueve documentos ni secretos. */
'use strict';
const { MongoClient } = require('mongoose').mongo;
const definitions     = require('../server/mongodb-indexes.json').collections;
const migrationId     = 'issuer-workspaces';
/** @param {Object} data Inventario completo. @returns {Object} Consecutivos consolidados y errores sin contenido fiscal privado. */
function prepareMigration(data) {
  const codes  = new Set(),
    identities = new Set(),
    folios     = new Map(),
    errors     = [];
  for (const issuer of data.issuers) {
    if (!issuer.code || codes.has(issuer.code)) errors.push('BILLING_DUPLICATE_ISSUER_CODE');
    codes.add(issuer.code);
    const identity = JSON.stringify([issuer.workspace, issuer.taxId]);
    if (!issuer.workspace || identities.has(identity))
      errors.push('BILLING_DUPLICATE_ISSUER_IDENTITY');
    identities.add(identity);
  }
  /** @param {Object} record Contador o reserva documental. @returns {void} Conserva el máximo reservado, sin sumar secuencias de diferentes espacios. */
  function reserve(record) {
    const { issuerCode, environment, type, series } = record;
    const value                                     = Number(record.value);
    if (
      !codes.has(issuerCode) ||
      !['development', 'production'].includes(environment) ||
      !['I', 'E', 'P'].includes(type) ||
      typeof series !== 'string' ||
      !series ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      errors.push('BILLING_INVALID_FOLIO_RESERVATION');
      return;
    }
    const key      = JSON.stringify([issuerCode, environment, type, series]);
    const previous = folios.get(key);
    folios.set(key, {
      ...((previous?._id ?? record._id) === undefined ? {} : { _id: previous?._id ?? record._id }),
      issuerCode,
      environment,
      type,
      series,
      value : Math.max(value, previous?.value || 0),
    });
  }
  for (const folio of data.folios) reserve(folio);
  for (const document of data.documents) {
    if (!document.folio) continue;
    reserve({
      issuerCode  : document.issuerCode,
      environment : document.issuerSnapshot?.environment,
      type        : document.type,
      series      : document.series,
      value       : document.folio,
    });
  }
  return {
    folios : [...folios.values()],
    report : {
      ready    : !errors.length,
      errors   : [...new Set(errors)],
      issuers  : data.issuers.length,
      counters : folios.size,
    },
  };
}
/** @param {Object} db Base explícita. @param {Object|undefined} session Sesión transaccional. @returns {Promise<Object>} Inventario completo de identidad y reservas. */
async function inventory(db, session) {
  const options = session ? { session } : {};
  return {
    issuers   : await db.collection('BILLING_ISSUER').find({}, options).toArray(),
    folios    : await db.collection('BILLING_FOLIO').find({}, options).toArray(),
    documents : await db
      .collection('BILLING_DOCUMENT')
      .find({ folio: { $exists: true } }, options)
      .toArray(),
  };
}
/** @param {Object} db Base explícita. @param {Object} client Cliente abierto. @param {Object} options apply y stopped son confirmaciones operativas explícitas. @returns {Promise<Object>} Diagnóstico o transición idempotente; exige restauración de respaldo para volver al binario anterior. */
async function migrate(db, client, options = {}) {
  const marker   = db.collection('BILLING_MIGRATION');
  const existing = await marker.findOne({ _id: migrationId });
  if (!options.apply)
    return existing
      ? {
          completed      : !!existing.indexesAppliedAt,
          indexesPending : !existing.indexesAppliedAt,
          changes        : 0,
        }
      : prepareMigration(await inventory(db)).report;
  if (!options.stopped) throw new Error('BILLING_MUST_BE_STOPPED');
  if (!existing) {
    const session = client.startSession();
    try {
      await session.withTransaction(
        /** @returns {Promise<void>} Consolida contadores y marca la transición en una sola confirmación. */
        async () => {
          const plan = prepareMigration(await inventory(db, session));
          if (!plan.report.ready) throw new Error(plan.report.errors.join(','));
          await db.collection('BILLING_FOLIO').deleteMany({}, { session });
          if (plan.folios.length)
            await db.collection('BILLING_FOLIO').insertMany(plan.folios, { session });
          await marker.insertOne(
            {
              _id           : migrationId,
              dataAppliedAt : Date.now(),
            },
            { session },
          );
        },
      );
    } finally {
      await session.endSession();
    }
  }
  for (const name of ['BILLING_ISSUER', 'BILLING_FOLIO']) {
    const collection = db.collection(name);
    for (const { key, ...settings } of definitions[name])
      await collection.createIndex(key, settings);
    for (const index of await collection.listIndexes().toArray()) {
      const oldIssuer =
        name === 'BILLING_ISSUER' &&
        JSON.stringify(index.key) ===
          JSON.stringify({
            workspace : 1,
            code      : 1,
          });
      const oldFolio  = name === 'BILLING_FOLIO' && Object.hasOwn(index.key, 'workspace');
      if (oldIssuer || oldFolio) await collection.dropIndex(index.name);
    }
  }
  await marker.updateOne({ _id: migrationId }, { $set: { indexesAppliedAt: Date.now() } });
  return {
    completed : true,
    changes   : existing ? 0 : 1,
  };
}
/** @returns {Promise<void>} Ejecuta sólo sobre el destino explícito; por defecto produce diagnóstico sin escrituras. */
async function main() {
  if (!process.env.BILLING_MIGRATION_URI) throw new Error('BILLING_MIGRATION_URI_REQUIRED');
  const client = new MongoClient(process.env.BILLING_MIGRATION_URI);
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await migrate(client.db(), client, {
          apply   : process.argv.includes('--apply'),
          stopped : process.argv.includes('--billing-stopped'),
        }),
      ),
    );
  } finally {
    await client.close();
  }
}
if (require.main === module)
  main().catch(
    /** @returns {void} Señala fallo sin volcar URI, documentos ni excepciones del proveedor. */
    () => {
      console.error(
        'No se completó la transición de emisores. Ejecuta el diagnóstico y verifica el destino y los índices.',
      );
      process.exitCode = 1;
    },
  );
module.exports = {
  prepareMigration,
  migrate,
};
