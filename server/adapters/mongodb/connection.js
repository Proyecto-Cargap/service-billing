/**
 * @file Adaptador de conexión Mongoose: apertura explícita y cierre coordinado de la base de datos del
 * servicio.
 */
'use strict';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
/**
 * Ejecuta verifiedConnection dentro del flujo de connection.
 * @returns {Promise<*>} Resultado que utiliza el flujo que invoca esta función; los fallos se propagan según el contrato del módulo.
 */
async function verifiedConnection() {
  await require('../../library/messaging/indexes').verifyIndexes(
    mongoose.connection.db,
    require('../../mongodb-indexes.json').collections,
  );
  return mongoose.connection;
}
let connecting;

/**
 * Abre la conexión Mongoose con la URI recibida o la configurada para el servicio.
 *
 * @param {string} [uri] URI que utiliza el adaptador para abrir la conexión MongoDB.
 * @returns {Promise<*>} Valores de salida de las ramas descritas; una salida sin expresión devuelve
 * undefined.
 * @throws {Error} La promesa se rechaza
 * cuando falla una comprobación explícita o se propaga un error de la operación.
 */
async function connect(uri = process.env.DB) {
  if (mongoose.connection.readyState === 1) return verifiedConnection();
  if (!uri) throw new Error('DB configuration is required');
  if (!connecting) {
    mongoose.set('strictQuery', false);
    connecting = mongoose
      .connect(uri, {
        autoIndex  : false,
        autoCreate : false,
      })
      .then(verifiedConnection)
      .finally(
        /**
         * Libera o restablece los recursos al terminar la operación.
         * @returns {void} Finaliza después de aplicar los efectos de la operación.
         */
        () => {
          connecting = undefined;
        },
      );
  }
  return connecting;
}
/**
 * Cierra la conexión Mongoose con la modalidad de liberación solicitada.
 *
 * @param {Object} [options] Opciones y dependencias de esta operación.
 * @param {boolean} [options.force] Solicita un cierre forzado cuando ha vencido el plazo de liberación.
 * @returns {Promise<void>} Finaliza cuando se completan los efectos de la operación.
 */
async function close({ force = false } = {}) {
  await mongoose.connection.close(force);
}
module.exports = {
  connect,
  close,
  connection : mongoose.connection,
};
