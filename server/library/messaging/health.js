/**
 * @file Comprobación técnica de MongoDB y mensajería, acompañada de la identidad de la versión cargada.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const fs = require('node:fs');

/**
 * Lee una vez la identidad de la versión desde la ruta proporcionada y congela sus metadatos.
 *
 * @param {string} releaseFile Ruta explícita al archivo con la identidad de la versión desplegada.
 * @returns {Object} Identidad inmutable de versión; los campos ausentes se representan con null.
 */
function captureIdentity(releaseFile) {
  const identity =
    releaseFile && fs.existsSync(releaseFile)
      ? JSON.parse(fs.readFileSync(releaseFile, 'utf8'))
      : {
          release : null,
          commit  : null,
        };
  return Object.freeze({
    release : identity.release ?? null,
    commit  : identity.commit ?? null,
  });
}

/**
 * Consulta la disponibilidad de mensajería y ejecuta un ping acotado de MongoDB para elaborar la
 * respuesta de salud.
 *
 * @param {Object} connection Conexión de base de datos o transporte utilizada por el módulo.
 * @param {Object} messaging Interfaz de mensajería de la instancia.
 * @param {Object} [release] Identidad de versión que acompaña la respuesta de salud.
 * @returns {Promise<Object>} Respuesta de salud con disponibilidad de las dependencias e identidad de la
 * versión.
 */
async function health(
  connection,
  messaging,
  release = {
    release : null,
    commit  : null,
  },
) {
  const state = messaging.getHealth();
  const data  = {
    release   : release.release,
    commit    : release.commit,
    database  : 'unavailable',
    messaging : state.messaging === 'ready' ? 'ready' : 'unavailable',
  };
  if (connection.readyState === 1 && state.database === 'ready') {
    try {
      await connection.db.command({ ping: 1 }, { timeoutMS: 1500 });
      data.database = 'ready';
    } catch {
      /**
       * Omite cadenas de conexión y errores internos del controlador al informar la salud.
       */
    }
  }
  return {
    statusCode      : data.database === 'ready' && data.messaging === 'ready' ? 200 : 503,
    descriptionCode : 'HEALTH',
    data,
  };
}

module.exports = health;
module.exports.captureIdentity = captureIdentity;
