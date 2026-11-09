/** @file Autorización por recurso y workspace concreto, sin confiar en identidades del cuerpo. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} actor Contexto autenticado. @param {string} resource Recurso. @param {string} action Acción. @returns {Object} Selector obligatorio. */
function billingAccess(actor, resource, action) {
  if (!actor?.user?.userCode) throw new ApplicationError(401, 'UNAUTHORIZED');
  if (['expense-category', 'cost-center'].includes(resource)) {
    if (!actor.policies?.includes(`billing.${resource}.${action}.global`))
      throw new ApplicationError(403, 'FORBIDDEN');
    return { workspace: 'allWorkspaces' };
  }
  if (resource === 'issuer') {
    if (actor.policies?.includes(`billing.issuer.${action}.global`))
      return actor.delegation ? { workspace: { $in: [actor.workspace, 'allWorkspaces'] } } : {};
    if (!actor.workspace || actor.workspace === 'allWorkspaces')
      throw new ApplicationError(400, 'BILLING_WORKSPACE_REQUIRED');
    if (actor.policies?.includes(`billing.issuer.${action}.workspace`))
      return { workspace: { $in: [actor.workspace, 'allWorkspaces'] } };
    throw new ApplicationError(403, 'FORBIDDEN');
  }
  if (!actor.workspace || actor.workspace === 'allWorkspaces')
    throw new ApplicationError(400, 'BILLING_WORKSPACE_REQUIRED');
  const scopes = ['global', 'workspace', 'owner', 'assigned'].filter(
    /** @param {string} scope Ámbito. @returns {boolean} Permiso concedido al principal vigente. */
    (scope) => actor.policies?.includes(`billing.${resource}.${action}.${scope}`),
  );
  if (scopes.includes('global') || scopes.includes('workspace'))
    return { workspace: actor.workspace };
  if (scopes.includes('owner') && scopes.includes('assigned'))
    return {
      workspace : actor.workspace,
      $or       : [{ userCreate: actor.user.userCode }, { userAssigned: actor.user.userCode }],
    };
  if (scopes.includes('owner'))
    return {
      workspace  : actor.workspace,
      userCreate : actor.user.userCode,
    };
  if (scopes.includes('assigned'))
    return {
      workspace    : actor.workspace,
      userAssigned : actor.user.userCode,
    };
  throw new ApplicationError(403, 'FORBIDDEN');
}
/** @param {Object} actor Identidad vigente. @param {string} resource Intención fiscal. @param {string} action Verbo. @param {Object} record Registro destinatario. @param {boolean} issuerTarget Indica una intención sobre el emisor compartido, sin ampliar el ámbito documental. @returns {void} Acredita el alcance sobre el objetivo, no sólo la existencia del permiso. */
function billingPermit(actor, resource, action, record, issuerTarget = false) {
  const filter = billingAccess(actor, resource, action);
  if (
    (filter.workspace &&
      !(typeof filter.workspace === 'object'
        ? filter.workspace.$in.includes(record.workspace)
        : record.workspace === filter.workspace ||
          (issuerTarget && record.workspace === 'allWorkspaces'))) ||
    (filter.userCreate && record.userCreate !== filter.userCreate) ||
    (filter.userAssigned && record.userAssigned !== filter.userAssigned) ||
    (filter.$or &&
      record.userCreate !== actor.user.userCode &&
      record.userAssigned !== actor.user.userCode)
  )
    throw new ApplicationError(403, 'FORBIDDEN');
}
/** @param {Object} actor Contexto autenticado. @param {string} action Alta o modificación. @param {string} workspace Destino solicitado. @returns {void} Autoriza la asignación sin usar propietario ni asignado. */
function issuerAssignment(actor, action, workspace) {
  billingAccess(actor, 'issuer', action);
  if (typeof workspace !== 'string' || !workspace.trim() || workspace !== workspace.trim())
    throw new ApplicationError(400, 'BILLING_WORKSPACE_REQUIRED');
  if (actor.delegation && workspace !== actor.workspace && workspace !== 'allWorkspaces')
    throw new ApplicationError(403, 'FORBIDDEN');
  if (
    !actor.policies.includes(`billing.issuer.${action}.global`) &&
    workspace !== actor.workspace &&
    workspace !== 'allWorkspaces'
  )
    throw new ApplicationError(403, 'FORBIDDEN');
}
module.exports = {
  billingAccess,
  billingPermit,
  issuerAssignment,
};
