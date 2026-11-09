/**
 * @file Exportaciones públicas de la biblioteca autónoma de mensajería; importar el módulo no inicia
 * conexiones.
 * Biblioteca portable; las copias deben coincidir con su versión y manifiesto.
 */
'use strict';
const { MessagingRuntime }       = require('./runtime');
const { MessagingError }         = require('./errors');
const protocol                   = require('./protocol');
const { topology }               = require('./topology');
const { createMessagingService } = require('./service');
module.exports = {
  MessagingRuntime,
  MessagingError,
  protocol,
  topology,
  createMessagingService,
  runtimeVersion : '2.6.1',
};
