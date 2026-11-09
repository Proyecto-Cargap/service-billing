/** @file Adaptación de referencias canónicas de Customer, Directory y Security sin acceso a sus bases. */
'use strict';
const { ApplicationError } = require('../../shared/application-error');
/** @param {Object} messaging Transporte abierto. @returns {Object} Puertos de consulta conservando contexto autenticado. */
function billingReferences(messaging) {
  /** @param {string} service Productor. @param {string} action Acción. @param {Object} data Entrada cerrada. @returns {Promise<Object>} Datos canónicos o fallo explícito. */
  async function request(service, action, data) {
    let response;
    try {
      response = await messaging.request(service, action, data, { timeoutMs: 15000 });
    } catch {
      throw new ApplicationError(503, 'BILLING_REFERENCE_UNAVAILABLE');
    }
    if (!response || response.statusCode < 200 || response.statusCode >= 300)
      throw new ApplicationError(
        response?.statusCode || 503,
        response?.descriptionCode || 'BILLING_REFERENCE_UNAVAILABLE',
      );
    return response.data;
  }
  return {
    /** @param {string} supplierCode Identidad canónica. @returns {Promise<Object>} Proveedor visible sin acceso directo a sus datos. */
    supplier(supplierCode) {
      return request('service-supplier', 'supplier-get-one', { supplierCode });
    },
    /** @param {string} code Proyecto visible. @returns {Promise<Object>} Proyecto sujeto a su autorización canónica. */
    project(code) {
      return request('service-projects', 'project-get-one', { code });
    },
    /** @param {Object} input SKU, lista y moneda. @returns {Promise<Object>} Copia comercial acreditada por Product. */
    product(input) {
      return request('service-product', 'product-sale-resolve', input);
    },
    /** @param {string} customerCode Identidad Customer. @returns {Promise<Object>} Cliente visible para el actor. */
    customer(customerCode) {
      return request('service-customer', 'customer-get-one', { customerCode });
    },
    /** @param {Object} query Catálogo y filtro. @returns {Promise<Object>} Página con vigencias. */
    catalog(query) {
      return request('service-directory', 'fiscal-catalog-get-list', query);
    },
    /** @param {Object[]} values Claves SAT. @returns {Promise<Object>} Validez de todos los elementos. */
    values(values) {
      return request('service-directory', 'fiscal-values-validate', { values });
    },
    /** @param {Object} data Preferencias fiscales. @returns {Promise<Object>} Compatibilidad SAT. */
    profile(data) {
      return request('service-directory', 'fiscal-profile-validate', data);
    },
    /** @param {string} workspace Espacio. @param {string} userCode Identidad del autor. @returns {Promise<Object|null>} Contexto de ejecución vigente. */
    async principal(workspace, userCode, delegation) {
      if (delegation) {
        let principal;
        try {
          principal = await request('service-security', 'oauth-principal-resolve', {
            ...delegation,
            workspace,
          });
        } catch (error) {
          if ([401, 403, 404].includes(error.statusCode)) return null;
          throw error;
        }
        if (principal.userCode !== userCode || principal.workspace !== workspace) return null;
        return {
          workspace,
          user       : { userCode },
          policies   : principal.policies,
          workspaces : principal.workspaces,
          scopes     : principal.scopes,
          delegation,
        };
      }
      const result    = await request('service-security', 'workspace-principals-get-list', {
        workspace,
        userCodes : [userCode],
      });
      const principal = result.items?.[0];
      return principal
        ? {
            workspace,
            user     : { userCode },
            policies : principal.policies,
          }
        : null;
    },
    /** @param {Object} actor Identidad resuelta desde Security. @param {Function} work Trabajo diferido. @returns {Promise<*>} Resultado aislado al contexto. */
    run(actor, work) {
      return messaging.runWithContext(actor, work);
    },
  };
}
module.exports = { billingReferences };
