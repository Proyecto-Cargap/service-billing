/** @file Replica set MongoDB temporal con puerto, conexión, datos y cierre exclusivos de la prueba. */
'use strict';
const fs                               = require('node:fs/promises');
const os                               = require('node:os');
const path                             = require('node:path');
const { spawn }                        = require('node:child_process');
const { freePort, delay, stopProcess } = require('./isolated-processes.cjs');

/**
 * Prepara persistencia transaccional sin usar cadenas de conexión de otros ambientes.
 * @param {Object} options Binario mongod explícito y módulo mongoose usado por esta prueba.
 * @returns {Promise<Object>} Conexión propia y cierre idempotente que elimina exclusivamente sus datos temporales.
 * @throws {Error} Propaga el fallo de arranque, elección primaria o conexión, después de liberar recursos propios.
 */
async function startIsolatedMongo({ binary, mongoose }) {
  await fs.access(binary, fs.constants.X_OK);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solid-mongo-'));
  const port      = await freePort();
  let child;
  let admin;
  let connection;
  let startupError;
  let stopped = false;
  /** @param {Error} error Fallo al crear el proceso temporal.
   * @returns {void} Conserva el diagnóstico para rechazar el arranque y cerrar recursos.
   */
  function failed(error) {
    startupError = error;
  }
  /** @returns {Promise<void>} Cierra conexiones, proceso y archivos pertenecientes exclusivamente a esta prueba. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      await connection?.close();
    } finally {
      try {
        await admin?.close();
      } finally {
        await stopProcess(child);
        await fs.rm(directory, {
          recursive : true,
          force     : true,
        });
      }
    }
  }
  try {
    child = spawn(
      binary,
      [
        '--dbpath',
        directory,
        '--port',
        String(port),
        '--bind_ip',
        '127.0.0.1',
        '--replSet',
        'solid',
        '--wiredTigerCacheSizeGB',
        '0.25',
        '--wiredTigerEngineConfigString',
        'log=(file_max=1MB)',
        '--setParameter',
        'diagnosticDataCollectionEnabled=false',
        '--logpath',
        path.join(directory, 'mongo.log'),
      ],
      {
        detached : true,
        stdio    : 'ignore',
      },
    );
    child.on('error', failed);
    const uri = `mongodb://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error('ISOLATED_MONGO_FAILED');
      const candidate = new mongoose.mongo.MongoClient(`${uri}/?directConnection=true`, {
        serverSelectionTimeoutMS : 100,
      });
      try {
        admin = await candidate.connect();
        break;
      } catch {
        await candidate.close();
      }
    }
    if (!admin) throw new Error('ISOLATED_MONGO_TIMEOUT');
    await admin.db('admin').command({
      replSetInitiate : {
        _id     : 'solid',
        members : [
          {
            _id  : 0,
            host : `127.0.0.1:${port}`,
          },
        ],
      },
    });
    let primary = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      primary = (await admin.db('admin').command({ hello: 1 })).isWritablePrimary;
      if (primary) break;
      await delay(50);
    }
    if (!primary) throw new Error('ISOLATED_MONGO_PRIMARY_TIMEOUT');
    connection = await mongoose
      .createConnection(`${uri}/solid_integration?replicaSet=solid`, {
        serverSelectionTimeoutMS : 5000,
      })
      .asPromise();
    return {
      connection,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { startIsolatedMongo };
