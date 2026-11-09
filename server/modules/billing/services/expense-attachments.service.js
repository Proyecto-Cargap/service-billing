/** @file Adopción recuperable de comprobantes: reserva durable, efecto documental y confirmación independiente. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} dependencies Puertos documentales y persistencia. @returns {Object} Transferencias privadas y limpieza de reservas abandonadas. */
function expenseAttachments({
  store,
  records,
  references,
  expenseFiles,
  expenses,
  context,
  clock,
  hash,
  uuid,
}) {
  /** @param {Object} data Pertenencia solicitada. @param {string} action Permiso. @returns {Promise<Object>} Registro del ámbito autenticado. */
  async function owner(data, action = 'view') {
    if (!['expense', 'expense-payment'].includes(data.resource))
      throw new ApplicationError(400, 'BILLING_INVALID_RESOURCE');
    return records.get(data.resource, data.code, action);
  }
  /** @param {Object} record Propietario. @param {string} fileId Identidad documental. @returns {Object} Archivo adoptado, nunca una referencia aportada por el cliente. */
  function file(record, fileId) {
    const result = record.files.find(
      /** @param {Object} item Referencia. @returns {boolean} Identidad exacta. */
      (item) => item.fileId === fileId,
    );
    if (!result) throw new ApplicationError(404, 'BILLING_FILE_NOT_FOUND');
    return result;
  }
  /** @param {Object} actor Contexto inicial. @param {string} scope Capacidad mínima. @returns {Promise<Object>} Identidad delegada revalidada después de un efecto externo. */
  async function revalidate(actor, scope) {
    if (!actor.delegation) return actor;
    const principal = await references.principal(
      actor.workspace,
      actor.user.userCode,
      actor.delegation,
    );
    if (!principal) throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
    if (!principal.scopes.includes(scope)) throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
    return {
      ...actor,
      ...principal,
    };
  }
  return {
    file,
    /** @param {Object} data Destino y huella. @returns {Promise<Object>} Metadatos para una capacidad de carga, sin escritura de negocio. */
    async prepareUpload(data) {
      const record = await owner(data, 'update');
      records.match(record, data.revision);
      if (!['draft', 'confirmed'].includes(record.status) || record.files.length >= 100)
        throw new ApplicationError(409, 'BILLING_FILES_LOCKED');
      return {
        name       : data.name,
        byteLength : data.byteLength,
        sha256     : data.sha256,
      };
    },
    /** @param {Object} data Transferencia desde Gateway acreditado. @returns {Promise<Object>} Archivo adoptado exactamente una vez por intención. */
    async upload(data) {
      const record = await owner(data, 'update'),
        actor      = context();
      const operationKey               = hash([
        actor.workspace,
        actor.user.userCode,
        actor.delegation || null,
        data.resource,
        data.code,
        data.idempotencyKey,
      ]);
      const { tempFilePath, ...input } = data;
      const fingerprint                = hash(input);
      const inspected                  = await expenseFiles.inspect(data);
      const job                        = await store.transaction(
        /** @param {Object} tx Transacción sin efectos documentales. @returns {Promise<Object>} Reserva estable y cercada. */
        async (tx) => {
          const existing = await tx.get('expense-file-job', { operationKey });
          if (existing) {
            if (existing.fingerprint !== fingerprint)
              throw new ApplicationError(409, 'BILLING_IDEMPOTENCY_CONFLICT');
            if (existing.status === 'ready') return existing;
            if (existing.status !== 'pending')
              throw new ApplicationError(409, 'BILLING_UPLOAD_EXPIRED');
            if (existing.leaseUntil > clock())
              throw new ApplicationError(409, 'BILLING_UPLOAD_PENDING');
          }
          const current = await records.get(data.resource, data.code, 'update', actor, tx);
          records.match(current, data.revision);
          if (!['draft', 'confirmed'].includes(current.status) || current.files.length >= 100)
            throw new ApplicationError(409, 'BILLING_FILES_LOCKED');
          const value = existing
            ? expenses.next(existing, { leaseUntil: clock() + 600000 })
            : {
                ...records.metadata('expense-file-job', actor),
                operationKey,
                fingerprint,
                resource   : data.resource,
                targetCode : data.code,
                status     : 'pending',
                leaseUntil : clock() + 600000,
                file       : {
                  ...inspected,
                  fileId       : uuid(),
                  creationDate : clock(),
                },
              };
          if (existing) await tx.replace('expense-file-job', existing, value);
          else await tx.insert('expense-file-job', value);
          return value;
        },
      );
      if (job.status === 'ready') return file(record, job.file.fileId);
      try {
        await expenseFiles.upload(record, data.resource, job.file, tempFilePath);
        const authorized = await revalidate(actor, 'billing:write');
        return await store.transaction(
          /** @param {Object} tx Transacción de adopción, auditoría y outbox. @returns {Promise<Object>} Referencia durable o conflicto recuperable. */
          async (tx) => {
            const current = await records.get(data.resource, data.code, 'update', authorized, tx);
            const pending = await tx.get('expense-file-job', { code: job.code });
            records.match(pending, job.revision);
            if (pending.status !== 'pending' || pending.leaseUntil <= clock())
              throw new ApplicationError(409, 'BILLING_UPLOAD_EXPIRED');
            if (!['draft', 'confirmed'].includes(current.status) || current.files.length >= 100)
              throw new ApplicationError(409, 'BILLING_FILES_LOCKED');
            await tx.replace(
              data.resource,
              current,
              expenses.next(current, { files: [...current.files, job.file] }),
            );
            await tx.replace(
              'expense-file-job',
              pending,
              expenses.next(pending, {
                status     : 'ready',
                leaseUntil : 0,
              }),
            );
            await records.audit(tx, authorized, data.resource, current.code, 'file-added');
            return job.file;
          },
        );
      } catch (error) {
        await store.transaction(
          /** @param {Object} tx Transacción de recuperación. @returns {Promise<void>} Libera sólo la reserva propia y conserva su identidad para reintentar. */
          async (tx) => {
            const pending = await tx.get('expense-file-job', { code: job.code });
            if (pending?.status === 'pending' && pending.revision === job.revision)
              await tx.replace(
                'expense-file-job',
                pending,
                expenses.next(pending, { leaseUntil: 0 }),
              );
          },
        );
        throw error;
      }
    },
    /** @param {Object} data Identidad del comprobante. @returns {Promise<Object>} Metadatos privados de descarga. */
    async prepareDownload(data) {
      const selected = file(await owner(data), data.fileId);
      return {
        fileName : selected.name,
        mimeType : selected.mimeType,
      };
    },
    /** @param {Object} data Identidad del comprobante. @returns {Promise<Object>} Transferencia privada con permisos actuales. */
    async read(data) {
      const record = await owner(data);
      const result = await expenseFiles.read(record, data.resource, file(record, data.fileId));
      try {
        await records.get(
          data.resource,
          data.code,
          'view',
          await revalidate(context(), 'billing:read'),
        );
        return result;
      } catch (error) {
        await expenseFiles.discardTransfer(result);
        throw error;
      }
    },
    /** @param {Object} options Señal de cierre. @returns {Promise<void>} Retira archivos no adoptados tras un día, conservando fallos para recuperación. */
    async tick(options = {}) {
      if (options.shouldStop?.()) return;
      const job = await store.claimExpenseCleanup(clock(), uuid());
      if (!job) return;
      try {
        await expenseFiles.remove(
          {
            code      : job.targetCode,
            workspace : job.workspace,
          },
          job.resource,
          job.file,
        );
        await store.replace(
          'expense-file-job',
          job,
          expenses.next(job, {
            status     : 'cleaned',
            leaseUntil : 0,
          }),
        );
      } catch (error) {
        await store.replace(
          'expense-file-job',
          job,
          expenses.next(job, { leaseUntil: clock() + 60000 }),
        );
        throw error;
      }
    },
  };
}
module.exports = { expenseAttachments };
