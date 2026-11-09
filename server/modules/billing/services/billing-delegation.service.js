/** @file Acredita conexiones delegadas y confirma recibos con las mutaciones de Facturación. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const endpoints            = require('../../../contracts/service.json').endpoints;
/** @param {Object} dependencies Puertos de persistencia, identidad, reglas y reloj. @returns {Object} Ejecutor para las acciones canónicas registradas. */
function billingDelegation({ store, references, context, clock, hash, records }) {
  return {
    /** @param {string} name Acción explícita. @param {Object} data DTO validado. @param {Function} invoke Caso de uso canónico. @returns {Promise<Object>} Resultado autorizado y durable. */
    async execute(name, data, invoke) {
      const incoming = context();
      if (!incoming.delegation) return invoke(data);
      const spec = endpoints.find(
        /** @param {Object} endpoint Contrato. @returns {boolean} Coincide. */ (endpoint) =>
          endpoint.name === name,
      )?.delegation;
      if (!spec) throw new ApplicationError(403, 'BILLING_HUMAN_REQUIRED');
      const principal = await references.principal(
        incoming.workspace,
        incoming.user?.userCode,
        incoming.delegation,
      );
      if (!principal) throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
      if (!principal.scopes.includes(spec.scope))
        throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
      const actor = {
        ...incoming,
        ...principal,
      };
      return references.run(
        actor,
        /** @returns {Promise<Object>} Negocio y referencias bajo permisos vigentes. */ async () => {
          if (!spec.write) return invoke(data);
          const key = actor.operation?.idempotencyKey;
          if (typeof key !== 'string' || key.length < 16 || key.length > 128)
            throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED');
          const id = hash([actor.user.userCode, actor.workspace, actor.delegation, name, key]);
          // El caso de uso documental posee reserva y recibo propios; ningún efecto externo
          // se ejecuta dentro de una transacción Mongo que pueda repetirse.
          if (spec.externalEffect)
            return invoke({
              ...data,
              idempotencyKey : id,
            });
          const fingerprint = hash(data),
            policies        = hash([...actor.policies].sort());
          /** @param {Object} receipt Recibo. @returns {Promise<Object>} Resultado sólo bajo el acceso actual al recurso. */
          async function replay(receipt) {
            if (receipt.fingerprint !== fingerprint)
              throw new ApplicationError(409, 'IDEMPOTENCY_KEY_CONFLICT');
            if (receipt.policies !== policies)
              throw new ApplicationError(403, 'IDEMPOTENCY_PERMISSION_CHANGED');
            if (receipt.resource && receipt.targetCode)
              await records.get(receipt.resource, receipt.targetCode, 'view', actor);
            return receipt.response;
          }
          const existing = await store.receiptRead(id);
          if (existing) return replay(existing);
          try {
            return await store.transaction(
              /** @param {Object} tx Transacción compartida por casos de uso y eventos. @returns {Promise<Object>} Confirmación atómica. */ async (
                tx,
              ) => {
                const committed = await tx.receiptRead(id);
                if (committed) return replay(committed);
                const input    = data.idempotencyKey
                  ? {
                      ...data,
                      idempotencyKey : id,
                    }
                  : data;
                const response = await invoke(input);
                await tx.receiptInsert({
                  _id        : id,
                  fingerprint,
                  policies,
                  response,
                  resource   : spec.resource,
                  targetCode : data.code || response.code,
                  createdAt  : clock(),
                });
                return response;
              },
            );
          } catch (error) {
            const committed = await store.receiptRead(id);
            if (committed) return replay(committed);
            throw error;
          }
        },
      );
    },
  };
}
module.exports = { billingDelegation };
