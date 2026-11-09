/** @file Custodia cifrada de credenciales PAC y CSD con vínculo a emisor, ambiente y workspace. */
'use strict';
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} = require('node:crypto');
const { ApplicationError } = require('../../shared/application-error');
/** @param {string} encoded Clave AES de 32 bytes en base64 suministrada por composición. @returns {Object} Sellado y apertura sin registrar secretos. */
function billingSecrets(encoded) {
  const key = Buffer.from(encoded || '', 'base64');
  /** @returns {void} Falla antes de aceptar secretos si la custodia no está configurada. */
  function ready() {
    if (key.length !== 32) throw new ApplicationError(503, 'BILLING_ENCRYPTION_NOT_CONFIGURED');
  }
  return {
    /** @param {Object} value Credenciales normalizadas. @param {string} binding Identidad del propietario. @returns {string} Sobre autenticado opaco. */
    seal(value, binding) {
      ready();
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(binding));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      return [
        'v1',
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join('.');
    },
    /** @param {string} envelope Sobre cifrado. @param {string} binding Propietario esperado. @returns {Object} Secretos exclusivos para el adaptador PAC. */
    open(envelope, binding) {
      ready();
      try {
        const [version, iv, tag, data, extra] = envelope.split('.');
        if (version !== 'v1' || extra || !data) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAAD(Buffer.from(binding));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return JSON.parse(
          Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
            'utf8',
          ),
        );
      } catch {
        throw new ApplicationError(400, 'BILLING_INVALID_CREDENTIAL_ENVELOPE');
      }
    },
  };
}
/** @param {Object} input Certificado y llave PEM o DER base64, contraseña. @param {string} taxId RFC del emisor. @param {number} now Reloj UTC. @returns {Object} PEM acreditado y metadatos públicos del CSD. */
function normalizeCsd(input, taxId, now) {
  try {
    const certificate = new X509Certificate(
      input.certificate.includes('BEGIN CERTIFICATE')
        ? input.certificate
        : Buffer.from(input.certificate, 'base64'),
    );
    const privateKey  = createPrivateKey(
      input.privateKey.includes('BEGIN')
        ? {
            key        : input.privateKey,
            passphrase : input.password || undefined,
          }
        : {
            key        : Buffer.from(input.privateKey, 'base64'),
            format     : 'der',
            type       : 'pkcs8',
            passphrase : input.password || undefined,
          },
    );
    const first = certificate.publicKey.export({
        type   : 'spki',
        format : 'der',
      }),
      second    = createPublicKey(privateKey).export({
        type   : 'spki',
        format : 'der',
      });
    if (
      first.length !== second.length ||
      !timingSafeEqual(first, second) ||
      !certificate.subject.includes(taxId) ||
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now
    )
      throw new Error();
    const serial = Buffer.from(certificate.serialNumber, 'hex').toString('ascii');
    if (!/^\d{20}$/.test(serial) || privateKey.asymmetricKeyType !== 'rsa') throw new Error();
    return {
      credentials : {
        keyPEM : privateKey
          .export({
            type   : 'pkcs8',
            format : 'pem',
          })
          .toString(),
        cerPEM : certificate.toString(),
      },
      certificate : {
        serial,
        validFrom  : Date.parse(certificate.validFrom),
        validUntil : Date.parse(certificate.validTo),
      },
    };
  } catch {
    throw new ApplicationError(400, 'BILLING_INVALID_CSD_OR_CREDENTIALS');
  }
}
module.exports = {
  billingSecrets,
  normalizeCsd,
};
