/** @file Identidad y política de rutas de esta aplicación; la biblioteca no conoce su estructura. */
'use strict';
const { name, version, id } = require('../package.json');
const { createTelemetry }   = require('./library/telemetry/index');
const routeTemplates        = require('./telemetry-routes.json');

module.exports = createTelemetry({
  serviceName    : name,
  serviceVersion : version,
  serviceId      : id,
  environment    : process.env.ENV_NAME || 'development',
  routeTemplates,
});
