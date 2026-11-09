/** @file Diagnóstico y transición explícita del PAC por emisor a cuenta global, sin llamadas fiscales ni regeneraciones. */
'use strict';
const { billingSecrets }      = require('../server/adapters/crypto/billing-secrets');
const { binding, pacBinding } = require('../server/adapters/pac/billing-pac');
const migrationId             = 'billing-global-pac';
/** @param {Object} data Copia consistente de emisores, documentos, operaciones y cuenta global. @param {Object} options Custodia, selecciones explícitas y reloj. @returns {Object} Escrituras privadas y diagnóstico público sin secretos ni huellas de claves. */
function prepareMigration(
  data,
  { secrets, selections = {}, activeEnvironment = '', now = Date.now() },
) {
  const errors = [],
    accounts   = [],
    revisions  = [],
    issuers    = [],
    documents  = [],
    operations = [];
  const identities = new Set(),
    legacyByIssuer = new Map();
  for (const issuer of data.issuers) {
    const identity = `${issuer.workspace}:${issuer.taxId}`;
    if (identities.has(identity))
      errors.push(`RFC duplicado: ${identity}; resolver manualmente sin fusionar emisores.`);
    identities.add(identity);
    if (
      !Object.hasOwn(issuer, 'environment') &&
      !Object.hasOwn(issuer, 'template') &&
      !issuer.secretEnvelope
    )
      continue;
    const next = {
      ...issuer,
      revision      : issuer.revision + 1,
      updateDate    : now,
      csdConfigured : !!issuer.csdEnvelope,
    };
    delete next.environment;
    delete next.template;
    delete next.configured;
    delete next.secretEnvelope;
    if (issuer.secretEnvelope) {
      try {
        if (!['development', 'production'].includes(issuer.environment)) throw new Error();
        const value = secrets.open(
          issuer.secretEnvelope,
          `billing:${issuer.workspace}:${issuer.code}:${issuer.environment}`,
        );
        if (!/^[A-Za-z0-9]{32}$/.test(value.apiKey) || !value.keyPEM || !value.cerPEM)
          throw new Error();
        const revision = {
          code         : `BIL-pac-revision-migration-${issuer.code}`,
          workspace    : 'allWorkspaces',
          environment  : issuer.environment,
          creationDate : now,
          userCreate   : 'migration',
        };
        revision.secretEnvelope = secrets.seal({ apiKey: value.apiKey }, pacBinding(revision));
        revisions.push(revision);
        accounts.push({
          issuerCode  : issuer.code,
          environment : issuer.environment,
          apiKey      : value.apiKey,
          code        : revision.code,
        });
        legacyByIssuer.set(`${issuer.workspace}:${issuer.code}`, revision);
        next.csdEnvelope = secrets.seal(
          {
            keyPEM : value.keyPEM,
            cerPEM : value.cerPEM,
          },
          binding(issuer),
        );
        next.csdConfigured = true;
      } catch {
        errors.push(`Custodia no acreditada: ${issuer.code}.`);
      }
    } else if (issuer.configured) errors.push(`CSD configurado sin custodia: ${issuer.code}.`);
    issuers.push(next);
  }
  const byEnvironment = {};
  for (const environment of ['development', 'production']) {
    const candidates = accounts.filter(
      /** @param {Object} account Cuenta privada. @returns {boolean} Pertenece al ambiente. */
      (account) => account.environment === environment,
    );
    if (!candidates.length) continue;
    const selected = selections[environment]
      ? candidates.find(
          /** @param {Object} account Cuenta candidata. @returns {boolean} Selección explícita del operador. */
          (account) => account.issuerCode === selections[environment],
        )
      : candidates.every(
            /** @param {Object} account Cuenta candidata. @returns {boolean} Una sola cuenta aunque esté compartida por varios emisores. */
            (account) => account.apiKey === candidates[0].apiKey,
          )
        ? candidates[0]
        : null;
    if (!selected)
      errors.push(
        `Seleccionar cuenta de ${environment} mediante --select=${environment}:CODIGO_EMISOR.`,
      );
    else byEnvironment[environment] = selected.code;
  }
  for (const document of data.documents) {
    if (document.originalPacRevision) continue;
    const revision = legacyByIssuer.get(`${document.workspace}:${document.issuerCode}`);
    if (!revision) {
      if (document.uuid || document.activeOperation)
        errors.push(`No se acredita la cuenta original: ${document.code}.`);
      continue;
    }
    if (document.issuerSnapshot?.environment !== revision.environment) {
      errors.push(
        `Ambiente original incompatible: ${document.code}; requiere evidencia de su cuenta.`,
      );
      continue;
    }
    documents.push({
      ...document,
      originalPacRevision : revision.code,
      revision            : document.revision + 1,
      updateDate          : now,
    });
  }
  for (const operation of data.operations) {
    if (operation.kind === 'deliver' || operation.pacRevision) continue;
    const revision = legacyByIssuer.get(`${operation.workspace}:${operation.issuerCode}`);
    if (!revision) {
      errors.push(`No se acredita la cuenta de la operación: ${operation.code}.`);
      continue;
    }
    operations.push({
      ...operation,
      pacRevision : revision.code,
      revision    : operation.revision + 1,
      updateDate  : now,
    });
  }
  const environments = Object.keys(byEnvironment);
  const environment  = activeEnvironment || (environments.length === 1 ? environments[0] : '');
  if (accounts.length && !byEnvironment[environment])
    errors.push('Seleccionar ambiente activo mediante --active=development|production.');
  if (data.pac && issuers.length)
    errors.push(
      'Ya existe configuración global y quedan emisores antiguos; resolver la transición parcial antes de aplicar.',
    );
  const pac =
    accounts.length && !data.pac && byEnvironment[environment]
      ? {
          code                   : 'global',
          workspace              : 'allWorkspaces',
          environment,
          configCode             : byEnvironment[environment],
          revisionsByEnvironment : byEnvironment,
          revision               : 1,
          creationDate           : now,
          updateDate             : now,
          userCreate             : 'migration',
          userAssigned           : '',
        }
      : null;
  return {
    issuers,
    documents,
    operations,
    revisions,
    pac,
    report : {
      errors,
      ready             : errors.length === 0,
      activeEnvironment : pac?.environment || data.pac?.environment || null,
      candidates        : accounts.map(
        /** @param {Object} account Cuenta privada. @returns {Object} Identidad seleccionable sin credenciales. */
        ({ issuerCode, environment }) => ({
          issuerCode,
          environment,
        }),
      ),
      changes           : {
        issuers    : issuers.length,
        documents  : documents.length,
        operations : operations.length,
        revisions  : revisions.length,
      },
    },
  };
}
/** @param {Object} db Base seleccionada explícitamente. @param {Object} session Sesión opcional. @returns {Promise<Object>} Inventario completo dentro del mismo snapshot. */
async function inventory(db, session) {
  const options = session ? { session } : {};
  return {
    issuers    : await db.collection('BILLING_ISSUER').find({}, options).toArray(),
    documents  : await db.collection('BILLING_DOCUMENT').find({}, options).toArray(),
    operations : await db.collection('BILLING_OPERATION').find({}, options).toArray(),
    pac        : await db.collection('BILLING_PAC').findOne({ code: 'global' }, options),
  };
}
/** @param {Object} db Base explícita. @param {Object} client Cliente Mongo abierto. @param {Object} options Custodia y selección; apply habilita escrituras. @returns {Promise<Object>} Diagnóstico o confirmación idempotente, sin exponer el plan privado. */
async function migrate(db, client, options) {
  if (await db.collection('BILLING_MIGRATION').findOne({ _id: migrationId }))
    return {
      completed : true,
      changes   : 0,
    };
  if (!options.apply) return prepareMigration(await inventory(db), options).report;
  const session = client.startSession();
  try {
    return await session.withTransaction(
      /** @returns {Promise<Object>} Migra referencias y sobres juntos; cualquier conflicto revierte todo. */
      async () => {
        if (await db.collection('BILLING_MIGRATION').findOne({ _id: migrationId }, { session }))
          return {
            completed : true,
            changes   : 0,
          };
        const plan = prepareMigration(await inventory(db, session), options);
        if (!plan.report.ready) return plan.report;
        for (const [collection, records] of [
          ['BILLING_ISSUER', plan.issuers],
          ['BILLING_DOCUMENT', plan.documents],
          ['BILLING_OPERATION', plan.operations],
        ])
          for (const record of records) {
            const result = await db.collection(collection).replaceOne(
              {
                _id      : record._id,
                revision : record.revision - 1,
              },
              record,
              { session },
            );
            if (result.matchedCount !== 1) throw new Error('MIGRATION_REVISION_CONFLICT');
          }
        for (const revision of plan.revisions)
          await db.collection('BILLING_PAC_REVISION').insertOne(revision, { session });
        if (plan.pac) await db.collection('BILLING_PAC').insertOne(plan.pac, { session });
        await db.collection('BILLING_MIGRATION').insertOne(
          {
            _id         : migrationId,
            completedAt : options.now || Date.now(),
          },
          { session },
        );
        return {
          ...plan.report,
          completed : true,
        };
      },
    );
  } finally {
    await session.endSession();
  }
}
/** @returns {Promise<void>} Diagnostica por defecto; sólo --apply escribe en DB. Las claves se reciben por entorno y nunca se imprimen. */
async function main() {
  const { MongoClient } = require('mongoose').mongo;
  if (!process.env.DB) throw new Error('DB_REQUIRED');
  const selections      = {};
  let activeEnvironment = '';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--select=')) {
      const [environment, code] = arg.slice(9).split(':');
      if (!['development', 'production'].includes(environment) || !code)
        throw new Error('INVALID_SELECTION');
      selections[environment] = code;
    } else if (arg.startsWith('--active=')) activeEnvironment = arg.slice(9);
    else if (!['--apply', '--diagnose'].includes(arg)) throw new Error('INVALID_ARGUMENT');
  }
  const client = new MongoClient(process.env.DB);
  try {
    await client.connect();
    const report = await migrate(client.db(), client, {
      secrets : billingSecrets(process.env.BILLING_ENCRYPTION_KEY),
      selections,
      activeEnvironment,
      apply   : process.argv.includes('--apply'),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.ready === false) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
if (require.main === module)
  void main().catch(
    /** @returns {void} Error deliberadamente sanitizado: nunca vuelca URI, documentos ni secretos. */
    () => {
      console.error('MIGRATION_FAILED: revisar conexión, custodia y diagnóstico.');
      process.exitCode = 1;
    },
  );
module.exports = {
  prepareMigration,
  migrate,
};
