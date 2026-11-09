/** @file Cuenta PAC global con revisiones privadas inmutables y resolución por ambiente histórico. */
'use strict';
const { ApplicationError }                  = require('../../../shared/application-error');
const { refreshValue, refreshEnvironments } = require('../policies/external-refresh.policy');
/** @param {Object} options Persistencia, custodia, contexto y reloj inyectados. @returns {Object} Configuración pública y resolución interna para operaciones autorizadas. */
function billingPacSettings({ store, pac, context, clock, identifier }) {
  const scope = {
    workspace : 'allWorkspaces',
    code      : 'global',
  };
  /** @param {string} action Permiso administrativo. @returns {Object} Actor autenticado sin exigir workspace concreto. */
  function authorize(action) {
    const actor = context();
    if (!actor?.user?.userCode) throw new ApplicationError(401, 'UNAUTHORIZED');
    if (!actor.policies?.includes(`billing.pac.${action}.global`))
      throw new ApplicationError(403, 'FORBIDDEN');
    return actor;
  }
  /** @param {Object|null} record Configuración privada. @returns {Object} Estado público sin sobres ni historial de credenciales. */
  function present(record) {
    return {
      code                         : 'global',
      environment                  : record?.environment || 'development',
      apiKeyConfigured             : !!record?.configCode,
      revision                     : record?.revision || 0,
      creationDate                 : record?.creationDate || 0,
      updateDate                   : record?.updateDate || 0,
      externalRefresh              : refreshEnvironments(record)[record?.environment || 'development'],
      externalRefreshByEnvironment : refreshEnvironments(record),
    };
  }
  /** @param {string} environment Ambiente del comprobante, vacío para el activo. @param {string} code Revisión fijada por una operación. @param {Object} source Unidad de lectura o transacción. @returns {Promise<Object>} Revisión cifrada; nunca selecciona otro ambiente como sustituto. */
  async function resolve(environment = '', code = '', source = store) {
    if (!code) {
      const active = await source.get('pac', scope);
      code = environment ? active?.revisionsByEnvironment?.[environment] : active?.configCode;
    }
    const value = code
      ? await source.get('pac-revision', {
          workspace : scope.workspace,
          code,
        })
      : null;
    if (!value || (environment && value.environment !== environment))
      throw new ApplicationError(409, 'BILLING_PAC_NOT_CONFIGURED');
    return value;
  }
  return {
    resolve,
    /** @param {string} environment Ambiente acreditado del comprobante. @param {Object} source Unidad de persistencia. @returns {Promise<Object>} Preferencia vigente; una operación histórica no reactiva una opción deshabilitada. */
    async refresh(environment, source = store) {
      const record = await source.get('pac', scope);
      return {
        ...refreshEnvironments(record)[environment],
        changedAt : record?.externalRefreshChangedAt?.[environment] || 0,
      };
    },
    /** @returns {Promise<Object>} Única configuración pública para cualquier workspace autorizado. */
    async getOne() {
      authorize('view');
      return present(await store.get('pac', scope));
    },
    /** @param {Object} data Revisión, ambiente y reemplazo cifrado opcional. @returns {Promise<Object>} Guarda sin condicionar el ambiente a documentos u operaciones existentes. */
    async update(data) {
      const actor = authorize('update');
      return store.transaction(
        /** @param {Object} tx Unidad atómica. @returns {Promise<Object>} Historial y puntero activo confirmados juntos. */
        async (tx) => {
          const previous = await tx.get('pac', scope);
          if ((previous?.revision || 0) !== data.revision)
            throw new ApplicationError(409, 'BILLING_REVISION_CONFLICT');
          const priorCode =
            previous?.revisionsByEnvironment?.[data.environment] || previous?.configCode;
          const prior     = priorCode ? await resolve('', priorCode, tx) : null;
          const code = identifier('pac-revision'),
            now      = clock();
          const refresh        =
            data.externalRefresh == null
              ? refreshEnvironments(previous)[data.environment]
              : refreshValue(data.externalRefresh);
          const beforeRefresh  = refreshEnvironments(previous)[data.environment];
          const refreshChanged =
            refresh.enabled !== beforeRefresh.enabled ||
            refresh.intervalSeconds !== beforeRefresh.intervalSeconds;
          const revision       = {
            code,
            workspace      : scope.workspace,
            environment    : data.environment,
            secretEnvelope : pac.preparePac(data.envelope, data.environment, code, prior),
            creationDate   : now,
            userCreate     : actor.user.userCode,
          };
          await tx.insert('pac-revision', revision);
          const updated = {
            ...scope,
            environment                  : data.environment,
            configCode                   : code,
            revisionsByEnvironment       : {
              ...previous?.revisionsByEnvironment,
              [data.environment] : code,
            },
            revision                     : data.revision + 1,
            creationDate                 : previous?.creationDate || now,
            updateDate                   : now,
            userCreate                   : previous?.userCreate || actor.user.userCode,
            userAssigned                 : '',
            externalRefreshByEnvironment : {
              ...refreshEnvironments(previous),
              [data.environment] : refresh,
            },
            externalRefreshChangedAt     : {
              ...previous?.externalRefreshChangedAt,
              [data.environment] : refreshChanged
                ? now
                : previous?.externalRefreshChangedAt?.[data.environment] || 0,
            },
          };
          if (previous) await tx.replace('pac', previous, updated);
          else await tx.insert('pac', updated);
          await tx.insert('audit', {
            code         : identifier('audit'),
            workspace    : scope.workspace,
            userCreate   : actor.user.userCode,
            userAssigned : '',
            creationDate : now,
            updateDate   : now,
            revision     : 1,
            resource     : 'pac',
            targetCode   : 'global',
            action       : 'configuration-updated',
            reason       : '',
          });
          return present(updated);
        },
      );
    },
    /** @returns {Promise<Object>} Créditos de la cuenta global activa sin requerir un emisor o CSD. */
    async credits() {
      authorize('view');
      const response = await pac.credits(await resolve());
      if (response.code !== '200' || !/^\d+$/.test(response.data))
        throw new ApplicationError(502, 'BILLING_PAC_CREDITS_UNAVAILABLE');
      let detail;
      try {
        detail = response.detail ? JSON.parse(response.detail) : {};
      } catch {
        throw new ApplicationError(502, 'BILLING_INVALID_PAC_RESPONSE');
      }
      const credits    = Number(response.data),
        primaryCredits = Number(detail.CreditosSP || 0);
      if (
        ![credits, primaryCredits].every(
          /** @param {number} value Saldo del proveedor. @returns {boolean} Entero seguro no negativo. */
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new ApplicationError(502, 'BILLING_INVALID_PAC_RESPONSE');
      return {
        credits,
        primaryCredits,
      };
    },
  };
}
module.exports = { billingPacSettings };
