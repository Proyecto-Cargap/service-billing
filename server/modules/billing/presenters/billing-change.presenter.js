/** @file Invalidación documental mínima: identidad, revisión y metadatos de acceso sin contenido fiscal. */
'use strict';

/** @param {Object} document Comprobante persistido dentro de la transacción. @returns {Object} Aviso público sin importes, credenciales ni respuesta del PAC. */
function billingDocumentChange(document) {
  return {
    item : {
      code         : document.code,
      revision     : document.revision,
      workspace    : document.workspace || 'allWorkspaces',
      userCreate   : document.userCreate || '',
      userAssigned : document.userAssigned || '',
    },
  };
}

module.exports = { billingDocumentChange };
