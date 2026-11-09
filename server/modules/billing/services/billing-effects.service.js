/** @file Ejecución durable de efectos fiscales; conserva respuestas antes de archivos y concilia sin repetir timbrados. */
'use strict';
const { refreshDeadline }              = require('../policies/external-refresh.policy');
const { ApplicationError }             = require('../../../shared/application-error');
const { billingAccess, billingPermit } = require('../policies/billing-access.policy');
const { amount }                       = require('./amounts.service');
const { invoiceLayout, paymentLayout } = require('./cfdi-layout.service');
const REJECTED_ISSUE                   = new Set([
  '300',
  '301',
  '302',
  '303',
  '304',
  '305',
  '306',
  '308',
  '401',
  '402',
  '701',
]);
/** @param {Object} options Persistencia, PAC, archivos, entrega y referencias sustituibles. @returns {Object} Procesador de una intención a la vez. */
function billingEffects({
  store,
  records,
  references,
  pac,
  pacSettings,
  pdf,
  files,
  delivery,
  clock,
  identifier,
  uuid,
  ledger,
}) {
  /** @param {Object} current Registro. @param {Object} changes Cambios. @returns {Object} Siguiente revisión. */
  function next(current, changes) {
    return {
      ...current,
      ...changes,
      revision   : current.revision + 1,
      updateDate : clock(),
    };
  }
  /** @param {Object} tx Transacción. @param {Object} document CFDI E. @param {boolean} release Sólo libera reserva cuando no hubo timbrado. @returns {Promise<void>} Aplica crédito o libera su reserva una sola vez. */
  async function credit(tx, document, release = false) {
    if (document.type !== 'E') return;
    const invoice = await tx.get('document', {
      code      : document.relatedDocumentCode,
      workspace : document.workspace,
    });
    if (!invoice) throw new ApplicationError(409, 'BILLING_CREDIT_TARGET_MISSING');
    const changes = {
      creditReserved : amount(invoice.creditReserved || '0')
        .minus(document.total)
        .toFixed(invoice.currencyDecimals),
    };
    if (amount(invoice.creditReserved || '0').lt(document.total))
      throw new ApplicationError(409, 'BILLING_CREDIT_RESERVATION_MISSING');
    if (!release) {
      changes.balance = amount(invoice.balance)
        .minus(document.total)
        .toFixed(invoice.currencyDecimals);
      changes.credited = amount(invoice.credited)
        .plus(document.total)
        .toFixed(invoice.currencyDecimals);
      const remaining = structuredClone(invoice.remainingTaxes || invoice.taxes);
      for (const tax of document.taxes) {
        const found = remaining.find(
          /** @param {Object} value Grupo fiscal. @returns {boolean} Identidad fiscal equivalente. */
          (value) =>
            value.kind === tax.kind &&
            value.code === tax.code &&
            value.factor === tax.factor &&
            (value.factor === 'Exento' || amount(value.rate).eq(tax.rate)),
        );
        if (!found || amount(found.base).lt(tax.base) || amount(found.amount).lt(tax.amount))
          throw new ApplicationError(409, 'BILLING_CREDIT_TAX_MISMATCH');
        found.base = amount(found.base).minus(tax.base).toFixed(6);
        found.amount = amount(found.amount).minus(tax.amount).toFixed(6);
      }
      changes.remainingTaxes = remaining;
    }
    const updatedInvoice = next(invoice, changes);
    await tx.replace('document', invoice, updatedInvoice);
    await ledger.credit(tx, updatedInvoice);
  }
  /** @param {Object} tx Transacción. @param {Object} document Comprobante global. @returns {Promise<void>} Libera referencias sólo tras rechazo confirmado o cancelación SAT. */
  async function releaseGlobal(tx, document) {
    await ledger.release(tx, document);
    if (!document.globalInfo) return;
    for (const businessCode of document.globalInfo.operationCodes) {
      const item = await tx.get('global-operation', {
        workspace    : document.workspace,
        documentCode : document.code,
        businessCode,
        active       : true,
      });
      if (item) await tx.replace('global-operation', item, next(item, { active: false }));
    }
  }
  /** @param {Object} claimed Trabajo adquirido con cerco. @param {Object} actor Identidad vigente. @returns {Promise<void>} Efecto y finalización; errores dejan evidencia recuperable. */
  async function execute(claimed, actor) {
    let operation        = claimed,
      effectStarted      = false,
      confirmedRejection = false;
    const resource = operation.kind === 'authorize' ? 'issuer' : 'document';
    /** @param {Object} changes Datos privados o estado del intento. @returns {Promise<void>} Persiste antes de continuar al siguiente efecto. */
    async function saveOperation(changes) {
      const updated = next(operation, changes);
      await store.replace('operation', operation, updated);
      operation = updated;
    }
    /** @param {Function} work Mutación pura de persistencia. @returns {Promise<*>} Resultado protegido contra trabajadores vencidos. */
    async function transaction(work) {
      return store.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<*>} Sólo el dueño vigente puede confirmar. */
        async (tx) => {
          const active = await tx.get('operation', {
            code      : operation.code,
            workspace : operation.workspace,
          });
          if (
            !active ||
            active.status !== 'running' ||
            active.token !== operation.token ||
            active.revision !== operation.revision
          )
            throw new ApplicationError(409, 'BILLING_OPERATION_LEASE_LOST');
          return work(tx);
        },
      );
    }
    /** @param {Object} changes Cambios documentales. @returns {Promise<Object>} Documento actualizado bajo cerco. */
    async function updateDocument(changes) {
      return transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Actualiza una revisión observada. */
        async (tx) => {
          const document = await tx.get('document', {
            code      : operation.targetCode,
            workspace : operation.workspace,
          });
          if (!document) throw new ApplicationError(404, 'BILLING_NOT_FOUND');
          const updated = next(document, changes);
          await tx.replace('document', document, updated);
          return updated;
        },
      );
    }
    /** @param {Object} document CFDI con layout persistido. @param {Object} result XML acreditado. @returns {Promise<Object>} Registro fiscal y saldo confirmados antes de las transferencias documentales. */
    async function applyIssue(document, result) {
      return transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Efecto fiscal exactamente una vez aunque se repita la conciliación. */
        async (tx) => {
          const current = await tx.get('document', {
            code      : document.code,
            workspace : document.workspace,
          });
          if (current.uuid && current.uuid !== result.uuid)
            throw new ApplicationError(409, 'BILLING_UUID_CONFLICT');
          if (current.issueOperation && current.issueOperation !== operation.code) {
            const original = await tx.get('operation', {
              code      : current.issueOperation,
              workspace : current.workspace,
            });
            if (original && ['uncertain', 'failed'].includes(original.status))
              await tx.replace(
                'operation',
                original,
                next(original, {
                  status      : 'succeeded',
                  error       : '',
                  recoveredBy : operation.code,
                }),
              );
          }
          if (current.ledgerApplied) return current;
          await credit(tx, current);
          let updated = next(current, {
            uuid           : result.uuid,
            status         : 'issued',
            ledgerApplied  : true,
            balance        : current.type === 'I' ? current.total : '0',
            remainingTaxes : structuredClone(current.taxes),
            error          : '',
            fileIds        : current.fileIds || {
              xml : uuid(),
              pdf : uuid(),
              ack : uuid(),
            },
          });
          updated = await ledger.issued(tx, updated);
          await tx.replace('document', current, updated);
          await records.audit(tx, actor, 'document', current.code, 'issued');
          return updated;
        },
      );
    }
    try {
      const policy        =
        operation.authorization ||
        {
          issue     : 'issuance',
          cancel    : 'cancellation',
          reconcile : 'operation',
          deliver   : 'delivery',
          authorize : 'cancellation',
        }[operation.kind];
      const requiredScope = {
        issuance     : 'billing:issue',
        cancellation : 'billing:cancel',
        operation    : 'billing:reconcile',
        delivery     : 'billing:send',
      }[policy];
      if (operation.delegation && !actor.scopes?.includes(requiredScope))
        throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
      billingAccess(actor, policy, policy === 'operation' ? 'update' : 'create');
      /** @returns {Promise<void>} Revalida la concesión inmediatamente antes de iniciar un efecto externo. */
      async function authorizeEffect() {
        if (!operation.delegation) return;
        const live = await references.principal(
          operation.workspace,
          operation.userCreate,
          operation.delegation,
        );
        if (!live) throw new ApplicationError(401, 'OAUTH_CONNECTION_REVOKED');
        if (!live.scopes?.includes(requiredScope))
          throw new ApplicationError(403, 'MCP_SCOPE_REQUIRED');
        billingAccess(live, policy, policy === 'operation' ? 'update' : 'create');
        const current =
          resource === 'document'
            ? await records.get('document', operation.targetCode, 'view', live)
            : operation;
        await records.historicalIssuer(current, live);
        billingPermit(live, policy, policy === 'operation' ? 'update' : 'create', current);
      }
      let document =
        resource === 'document'
          ? await records.get('document', operation.targetCode, 'view', actor)
          : null;
      if (
        operation.externalRefresh &&
        !(await pacSettings.refresh(document.issuerSnapshot.environment)).enabled
      ) {
        throw new ApplicationError(409, 'BILLING_EXTERNAL_REFRESH_DISABLED');
      }
      const issuer = await records.historicalIssuer(document || operation, actor);
      if (operation.kind !== 'deliver') {
        if (!operation.pacRevision)
          throw new ApplicationError(409, 'BILLING_PAC_REVISION_REQUIRED');
        issuer.pacConfig = await pacSettings.resolve('', operation.pacRevision);
      }
      billingPermit(
        actor,
        policy,
        policy === 'operation' ? 'update' : 'create',
        document || {
          ...issuer,
          workspace : operation.workspace,
        },
      );
      if (operation.kind === 'issue') {
        if (document.status !== 'queued' || document.activeOperation !== operation.code)
          throw new ApplicationError(409, 'BILLING_DOCUMENT_CHANGED');
        if (!issuer.csdConfigured || !issuer.active || issuer.certificate.validUntil <= clock())
          throw new ApplicationError(409, 'BILLING_ISSUER_NOT_READY');
        for (const key of ['taxId', 'legalName', 'taxRegime', 'postalCode'])
          if (issuer[key] !== document.issuerSnapshot[key])
            throw new ApplicationError(409, 'BILLING_ISSUER_SNAPSHOT_CHANGED');
        const receipt =
          document.type === 'P'
            ? await store.get('receipt', {
                code      : document.receiptCode,
                workspace : document.workspace,
              })
            : null;
        const layout  =
          document.type === 'P'
            ? paymentLayout(document, issuer, receipt)
            : invoiceLayout(document, issuer);
        document = await updateDocument({
          expectedLayout : layout,
          issueOperation : operation.code,
        });
        await authorizeEffect();
        await saveOperation({ effectStarted: true });
        effectStarted = true;
        const response = await pac.issue(issuer, layout);
        await saveOperation({
          response,
          providerCode : response.code,
        });
        if (REJECTED_ISSUE.has(response.code)) {
          confirmedRejection = true;
          throw new ApplicationError(422, 'BILLING_PAC_REJECTED');
        }
        const result = pac.decodeResult(response, layout);
        document = await applyIssue(document, result);
        const stored = { ...document.files };
        if (!stored.xml)
          stored.xml = await files.upload(document, 'xml', document.fileIds.xml, result.xml);
        document = await updateDocument({ files: stored });
        stored.pdf = await pdf.ensure(document, result.xml);
        document = await updateDocument({
          files           : stored,
          activeOperation : '',
          error           : stored.pdf ? '' : 'BILLING_PDF_PENDING',
        });
      } else if (operation.kind === 'reconcile') {
        let result;
        if (!document.expectedLayout)
          throw new ApplicationError(409, 'BILLING_RECOVERY_LAYOUT_MISSING');
        const original = document.issueOperation
          ? await store.get('operation', {
              code      : document.issueOperation,
              workspace : document.workspace,
            })
          : null;
        if (original?.response && !REJECTED_ISSUE.has(original.response.code)) {
          try {
            result = pac.decodeResult(
              original.response,
              document.expectedLayout,
              document.uuid || operation.input.uuid,
            );
          } catch {
            /* La consulta por UUID permite recuperar una respuesta incompleta. */
          }
        }
        if (!result) {
          const response = await pac.recover(issuer, document.uuid || operation.input.uuid);
          await saveOperation({
            response,
            providerCode : response.code,
          });
          result = pac.decodeResult(
            response,
            document.expectedLayout,
            document.uuid || operation.input.uuid,
          );
        }
        document = await applyIssue(document, result);
        const stored = { ...document.files };
        if (!stored.xml)
          stored.xml = await files.upload(document, 'xml', document.fileIds.xml, result.xml);
        document = await updateDocument({ files: stored });
        stored.pdf = await pdf.ensure(document, result.xml);
        document = await updateDocument({ files: stored });
        const status = await pac.status(issuer, document);
        await saveOperation({ satResponse: status });
        document = await applyStatus(document, status, transaction, actor);
      } else if (operation.kind === 'cancel') {
        document = await updateDocument({ status: 'cancel-requested' });
        await authorizeEffect();
        await saveOperation({ effectStarted: true });
        effectStarted = true;
        const response = await pac.cancel(issuer, document, operation);
        await saveOperation({
          response,
          providerCode : response.code,
        });
        const status = await pac.status(issuer, document);
        await saveOperation({ satResponse: status });
        document = await applyStatus(document, status, transaction, actor);
        if (
          status.Estado === 'Vigente' &&
          [
            '203',
            '204',
            '205',
            '206',
            '207',
            '208',
            '209',
            '210',
            '211',
            '212',
            '300',
            '301',
            '302',
            '303',
            '304',
            '305',
            '310',
            '311',
            '312',
          ].includes(response.code)
        ) {
          confirmedRejection = true;
          await updateDocument({
            status                 : 'issued',
            externalRefreshRetryAt : 0,
            activeOperation        : '',
          });
          throw new ApplicationError(422, 'BILLING_PAC_CANCELLATION_REJECTED');
        }
      } else if (operation.kind === 'authorize') {
        const pending = await pac.pending(issuer);
        if (
          pending.code !== '100' ||
          !pending.data
            .split(',')
            .map(
              /** @param {string} value UUID del PAC. @returns {string} Identidad normalizada. */
              (value) => value.trim().toUpperCase(),
            )
            .includes(operation.input.uuid.toUpperCase())
        )
          throw new ApplicationError(409, 'BILLING_CANCELLATION_NOT_PENDING');
        await authorizeEffect();
        await saveOperation({ effectStarted: true });
        effectStarted = true;
        const response = await pac.authorize(issuer, operation.input);
        await saveOperation({
          response,
          providerCode : response.code,
        });
        if (response.code !== '200')
          throw new ApplicationError(502, 'BILLING_AUTHORIZATION_UNCONFIRMED', { uncertain: true });
      } else if (operation.kind === 'deliver') {
        await pdf.ensure(document);
        document = await records.get('document', document.code, 'view', actor);
        if (!document.files.xml || !document.files.pdf || document.status === 'cancelled')
          throw new ApplicationError(409, 'BILLING_FILES_NOT_READY');
        await authorizeEffect();
        await saveOperation({ effectStarted: true });
        effectStarted = true;
        await delivery.send(document, operation);
        await updateDocument({
          deliveryStatus    : 'sent',
          deliveryOperation : '',
        });
      }
      if (document?.status === 'cancelled' && !document.files.ack) {
        const ack = await pac.ack(issuer, document.uuid);
        if (ack.data?.trim().startsWith('<')) {
          const fileId = await files.upload(document, 'ack', document.fileIds.ack, ack.data);
          document = await updateDocument({
            files : {
              ...document.files,
              ack : fileId,
            },
          });
        }
      }
      if (document && operation.kind !== 'deliver') await updateDocument({ activeOperation: '' });
      await saveOperation({
        status : 'succeeded',
        error  : '',
      });
    } catch (error) {
      const current   =
        resource === 'document'
          ? await store.get('document', {
              code      : operation.targetCode,
              workspace : operation.workspace,
            })
          : null;
      const uncertain =
        !confirmedRejection &&
        (effectStarted || operation.effectStarted || error.uncertain) &&
        !current?.ledgerApplied;
      operation = await transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Registra el resultado sin borrar evidencia fiscal ni repetir el efecto. */
        async (tx) => {
          const current =
            resource === 'document'
              ? await tx.get('document', {
                  code      : operation.targetCode,
                  workspace : operation.workspace,
                })
              : null;
          if (current) {
            const changes = {
              error :
                current.ledgerApplied &&
                (!current.files.pdf || current.error === 'BILLING_PDF_PENDING')
                  ? 'BILLING_PDF_PENDING'
                  : error.descriptionCode || 'BILLING_OPERATION_FAILED',
            };
            if (operation.kind === 'issue' && !current.ledgerApplied) {
              changes.status = uncertain ? 'uncertain' : 'draft';
              if (!uncertain) {
                changes.activeOperation = '';
                await credit(tx, current, true);
                if (current.type === 'E')
                  await ledger.credit(
                    tx,
                    await tx.get('document', {
                      workspace : current.workspace,
                      code      : current.relatedDocumentCode,
                    }),
                  );
                await releaseGlobal(tx, current);
              }
            } else if (operation.kind === 'deliver')
              changes.deliveryStatus = effectStarted ? 'uncertain' : 'failed';
            else {
              changes.activeOperation = '';
              if (current.status === 'cancel-requested') {
                changes.externalRefreshBlocked = error.statusCode === 403;
                changes.externalRefreshRetryAt =
                  error.descriptionCode === 'BILLING_EXTERNAL_REFRESH_DISABLED'
                    ? 0
                    : clock() + 300000;
              }
            }
            await tx.replace('document', current, next(current, changes));
          }
          const updated = next(operation, {
            status :
              uncertain ||
              (!confirmedRejection &&
                effectStarted &&
                ['cancel', 'authorize', 'deliver'].includes(operation.kind))
                ? 'uncertain'
                : 'failed',
            error  : error.descriptionCode || 'BILLING_OPERATION_FAILED',
          });
          await tx.replace('operation', operation, updated);
          return updated;
        },
      );
    }
  }
  /** @param {Object} document CFDI confirmado. @param {Object} response Estado SAT. @param {Function} transaction Transacción cercada del intento. @param {Object} actor Principal vigente. @returns {Promise<Object>} Cambio fiscal basado exclusivamente en el estado SAT. */
  async function applyStatus(document, response, transaction, actor) {
    if (!['Vigente', 'Cancelado'].includes(response.Estado))
      throw new ApplicationError(502, 'BILLING_SAT_STATE_UNCONFIRMED');
    return transaction(
      /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Cancelación y ajustes derivados atómicos. */
      async (tx) => {
        const current = await tx.get('document', {
          code      : document.code,
          workspace : document.workspace,
        });
        const sat     = {
          state         : response.Estado,
          cancelability : response.EsCancelable,
          cancellation  : response.EstatusCancelacion,
          checkedAt     : clock(),
        };
        let status    = current.status;
        if (response.Estado === 'Cancelado') {
          status = 'cancelled';
          if (current.status !== 'cancelled') {
            if (current.type === 'E') {
              const invoice    = await tx.get('document', {
                  code      : current.relatedDocumentCode,
                  workspace : current.workspace,
                }),
                remainingTaxes = structuredClone(invoice.remainingTaxes);
              for (const tax of current.taxes) {
                const found = remainingTaxes.find(
                  /** @param {Object} value Grupo fiscal. @returns {boolean} Grupo compatible con la devolución de crédito. */
                  (value) =>
                    value.kind === tax.kind &&
                    value.code === tax.code &&
                    value.factor === tax.factor &&
                    (value.factor === 'Exento' || amount(value.rate).eq(tax.rate)),
                );
                if (!found) throw new ApplicationError(409, 'BILLING_CREDIT_TAX_MISMATCH');
                found.base = amount(found.base).plus(tax.base).toFixed(6);
                found.amount = amount(found.amount).plus(tax.amount).toFixed(6);
              }
              await tx.replace(
                'document',
                invoice,
                next(invoice, {
                  balance  :
                    invoice.status === 'cancelled'
                      ? '0'
                      : amount(invoice.balance)
                          .plus(current.total)
                          .toFixed(invoice.currencyDecimals),
                  credited : amount(invoice.credited)
                    .minus(current.total)
                    .toFixed(invoice.currencyDecimals),
                  remainingTaxes,
                }),
              );
            }
            if (current.type === 'E')
              await ledger.credit(
                tx,
                await tx.get('document', {
                  workspace : current.workspace,
                  code      : current.relatedDocumentCode,
                }),
              );
            await releaseGlobal(tx, current);
            await records.audit(tx, actor, 'document', current.code, 'sat-cancelled');
          }
        } else if (response.EstatusCancelacion === 'Solicitud rechazada') status = 'issued';
        const updated = next(current, {
          status,
          sat,
          activeOperation        : '',
          externalRefreshRetryAt : 0,
          externalRefreshBlocked : false,
          ...(status === 'cancelled' && current.type === 'I'
            ? {
                balance : '0',
                error   :
                  (!current.saleCodes?.length && amount(current.paid).gt(0)) ||
                  amount(current.credited).gt(0)
                    ? 'BILLING_EXTERNAL_CANCELLATION_WITH_DEPENDENCIES'
                    : '',
              }
            : {}),
        });
        await tx.replace('document', current, updated);
        return updated;
      },
    );
  }
  /** @returns {Promise<Object>} Configuración actual de ambos ambientes, independiente de revisiones históricas del PAC. */
  async function refreshPreferences() {
    return {
      development : await pacSettings.refresh('development'),
      production  : await pacSettings.refresh('production'),
    };
  }
  /** @returns {Promise<void>} Programa una consulta SAT vencida sin duplicar la intención activa del comprobante. */
  async function enqueueExternalRefresh() {
    const preferences = await refreshPreferences();
    const candidate   = await store.nextExternalRefresh(preferences);
    if (!candidate || candidate.deadline > clock()) return;
    const document = candidate.document;
    await store.transaction(
      /** @param {Object} tx Unidad transaccional. @returns {Promise<void>} Reserva una conciliación con los permisos actuales del solicitante original. */
      async (tx) => {
        const current = await tx.get('document', {
          code      : document.code,
          workspace : document.workspace,
        });
        if (
          !current ||
          current.activeOperation ||
          current.status !== 'cancel-requested' ||
          current.revision !== document.revision
        )
          return;
        const preference = await pacSettings.refresh(current.issuerSnapshot.environment, tx);
        const due        = refreshDeadline(current, preference);
        if (!Number.isFinite(due) || due > clock()) return;
        const actor = {
            workspace : current.workspace,
            user      : { userCode: current.cancelRequestedBy || current.userCreate },
            ...(current.cancelDelegation ? { delegation: current.cancelDelegation } : {}),
          },
          operation = {
            ...records.metadata('operation', actor),
            kind            : 'reconcile',
            authorization   : 'cancellation',
            targetCode      : current.code,
            issuerCode      : current.issuerCode,
            pacRevision     : (await pacSettings.resolve(current.issuerSnapshot.environment, '', tx))
              .code,
            status          : 'queued',
            error           : '',
            idempotencyKey  : 'sat:' + current.code + ':' + current.revision,
            input           : { code: current.code },
            availableAt     : clock(),
            externalRefresh : true,
          };
        await tx.insert('operation', operation);
        await tx.replace(
          'document',
          current,
          next(current, {
            activeOperation              : operation.code,
            externalRefreshLastStartedAt : clock(),
            externalRefreshRetryAt       : 0,
          }),
        );
      },
    );
  }
  return {
    /** @returns {Promise<number|undefined>} Siguiente intención, lease vencido o consulta externa habilitada. */
    async nextAt() {
      const operation = await store.nextOperationAt();
      const external  = await store.nextExternalRefresh(await refreshPreferences());
      const deadline  = Math.min(operation ?? Infinity, external?.deadline ?? Infinity);
      return Number.isFinite(deadline) ? deadline : undefined;
    },
    /** @param {Object} options Señal de cierre entre efectos. @returns {Promise<void>} Adquiere como máximo una intención y revalida identidad antes de ejecutarla. */
    async tick(options = {}) {
      if (options.shouldStop?.()) return;
      const operation = await store.claim(clock(), identifier('lease'));
      if (!operation) {
        await enqueueExternalRefresh();
        return;
      }
      let actor;
      try {
        actor = await references.principal(
          operation.workspace,
          operation.userCreate,
          operation.delegation,
        );
      } catch {
        // No se inició ningún efecto; la disponibilidad de Security se vuelve a consultar después.
        await store.replace(
          'operation',
          operation,
          next(operation, {
            status      : 'queued',
            availableAt : clock() + 60000,
            error       : 'BILLING_IDENTITY_UNAVAILABLE',
          }),
        );
        return;
      }
      if (!actor) {
        await execute(operation, {
          workspace : operation.workspace,
          user      : { userCode: operation.userCreate },
          policies  : [],
        });
        return;
      }
      await references.run(
        actor,
        /** @returns {Promise<void>} Ejecuta efectos bajo la identidad vigente del solicitante. */
        () => execute(operation, actor),
      );
    },
  };
}
module.exports = { billingEffects };
