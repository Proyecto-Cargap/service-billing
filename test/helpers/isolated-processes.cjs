/** @file Procesos y puertos temporales de integración; opera únicamente sobre recursos creados por la prueba. */
'use strict';
const net = require('node:net');
/**
 * Reserva y libera un puerto efímero de loopback para un proceso exclusivo de esta prueba.
 * @returns {Promise<number>} Puerto disponible en 127.0.0.1.
 */
async function freePort() {
  const server = net.createServer();
  /** @param {Function} resolve Continuación de escucha.
   * @param {Function} reject Fallo al reservar el puerto.
   * @returns {void} Instala los eventos antes de abrir el socket local.
   */
  function listen(resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }
  await new Promise(listen);
  const port = server.address().port;
  /** @param {Function} resolve Continuación después de liberar el puerto.
   * @returns {void} Cierra únicamente el socket temporal creado por esta función.
   */
  function close(resolve) {
    server.close(resolve);
  }
  await new Promise(close);
  return port;
}
/**
 * Espera brevemente entre comprobaciones de disponibilidad sin bloquear el hilo JavaScript.
 * @param {number} milliseconds Duración acotada de la espera.
 * @returns {Promise<void>} Finaliza después del intervalo.
 */
function delay(milliseconds) {
  /** @param {Function} resolve Continuación de la espera.
   * @returns {void} Programa un único temporizador de prueba.
   */
  function wait(resolve) {
    setTimeout(resolve, milliseconds);
  }
  return new Promise(wait);
}
/**
 * Detiene exclusivamente el grupo de procesos creado por esta prueba y espera su salida.
 * @param {Object|undefined} child Proceso propio iniciado con detached=true.
 * @returns {Promise<void>} Finaliza tras el cierre o la terminación acotada del proceso propio.
 */
async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  /** @param {string} signal Señal de cierre del grupo exclusivo.
   * @returns {void} Ignora únicamente la ausencia de un proceso ya terminado.
   */
  function signal(signal) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  signal('SIGTERM');
  for (
    let attempt = 0;
    attempt < 50 && child.exitCode === null && child.signalCode === null;
    attempt++
  )
    await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGKILL');
    for (
      let attempt = 0;
      attempt < 20 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await delay(100);
  }
}
module.exports = {
  freePort,
  delay,
  stopProcess,
};
