import { createHash, randomUUID } from 'node:crypto';
import { boundedJson } from '../azure-http.mjs';
import { AppError, unavailable } from '../errors.mjs';
import { validateQuery, validateQuestion, validateKnowledgeQuery, parseSourceSnapshotTime, MAX_RESPONSE_BYTES } from '../validation.mjs';
import { PROMPT_VERSION, validatePlan, validatePlannerExecution } from '../model.mjs';
import { POLICY_SNAPSHOT } from '../knowledge/policies.mjs';
import { validateKnowledgeResponse, validatePolicyCatalogResponse } from '../knowledge/search.mjs';
import { METRIC_VERSION, TEMPLATE_VERSION, SOURCE_ID, BROKER_RESPONSE_FIELDS, BROKER_RECEIPT_VERSION } from '../broker/metrics.mjs';

const previous = { start: '2026-08-01', end: '2026-09-01' };
const current = { start: '2026-09-01', end: '2026-10-01' };
export const SCENARIOS = [
  { id: 'channel-loss', title: 'Explain the September loss change', question: 'Compare September 2026 net fraud losses with August 2026 by channel.', request: { kind: 'loss_comparison', groupBy: 'channel', current, previous } },
  { id: 'rule-quality', title: 'Investigate alert false-positive share', question: 'Compare September 2026 adjudicated-alert false-positive share with August 2026 by channel.', request: { kind: 'rule_quality', groupBy: 'channel', current, previous } },
];
const ready = (value) => ['ready', 'keyword-only'].includes(value?.status);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function createServiceCaller(config, credential, fetchImpl = fetch) {
  return async function call(baseUrl, path, { body, user, signal, traceId } = {}) {
    const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25000)]);
    const token = await credential.getToken(`${config.audience.replace(/\/$/, '')}/.default`, { abortSignal: boundedSignal });
    if (!token?.token) throw unavailable('Frontend managed identity');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: boundedSignal,
      headers: {
        authorization: `Bearer ${token.token}`, 'content-type': 'application/json',
        ...(user ? { 'x-fraud-user-oid': user.oid } : {}),
        ...(traceId ? { 'x-correlation-id': traceId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await boundedJson(response);
    if (!response.ok) {
      const allowedErrors = new Set(['NO_DATA', 'COHORT_SUPPRESSED', 'ROW_LIMIT']);
      if (response.status === 422 && allowedErrors.has(data.error?.code)) {
        const messages = {
          NO_DATA: 'Complete current and previous periods are not available. Missing data is not zero.',
          COHORT_SUPPRESSED: 'A required cohort has fewer than 10 members. All details and totals are withheld.',
          ROW_LIMIT: 'The request exceeds the approved reporting row limit.',
        };
        throw new AppError(422, data.error.code, messages[data.error.code]);
      }
      throw unavailable('Private backend service');
    }
    return data;
  };
}

export function createWebServices(config, { call, model, evidence, now = () => new Date(), policySnapshot = POLICY_SNAPSHOT,
  expectedBrokerSource = { id: SOURCE_ID, evidencePrefix: 'sql:' } }) {
  const sourceId = expectedBrokerSource?.id, evidencePrefix = expectedBrokerSource?.evidencePrefix;
  if (typeof sourceId !== 'string' || !sourceId || typeof evidencePrefix !== 'string' || !evidencePrefix) {
    throw unavailable('Configured broker source identity');
  }
  const sourceTime = parseSourceSnapshotTime(config.sourceAsOf);
  let statusCache;
  let statusPending;
  async function probeOne(callback) {
    try { return await callback(); }
    catch { return { status: 'unavailable', detail: 'Live dependency probe failed. No synthetic replacement is enabled.' }; }
  }
  async function status(user, signal) {
    if (!statusCache || statusCache.expires <= Date.now()) {
      if (!statusPending) {
        statusPending = (async () => {
          const [broker, knowledge, modelStatus, evidenceStatus] = await Promise.all([
            probeOne(() => call(config.brokerUrl, '/health/ready', { signal }).then((r) => r.service)),
            probeOne(() => call(config.knowledgeUrl, '/health/ready', { signal }).then((r) => r.service)),
            probeOne(() => model.probe(signal)),
            probeOne(() => evidence.probe(signal)),
          ]);
          statusCache = { expires: Date.now() + (config.publicDemo ? 300000 : 30000), services: { broker, knowledge, model: modelStatus, evidence: evidenceStatus } };
        })().finally(() => { statusPending = undefined; });
      }
      await statusPending;
    }
    const services = statusCache.services;
    return {
      synthetic: true,
      publicDemo: config.publicDemo === true,
      capabilities: {
        guided: ready(services.broker) && ready(services.evidence),
        naturalLanguage: ready(services.broker) && ready(services.evidence) && ready(services.model),
        knowledge: ready(services.knowledge), evidence: ready(services.evidence),
      },
      services,
      source: { type: 'azure-sql-database', label: 'Synthetic August–September 2026 data in real Azure SQL Database', asOf: config.sourceAsOf },
      model: { deployment: config.chatDeployment, version: config.modelVersion },
      user: { displayName: user.displayName ?? 'Authorized PoC analyst' },
      limitations: [
        'Synthetic proof of concept; not production SQL MI or Oracle data.',
        'No 1 TB throughput or production performance claim has been validated.',
        'Complete calendar-month comparisons only; at most 93 days across both periods.',
        'Cohorts below 10 cause the whole numerical answer and its totals to be withheld.',
        'Correlation is not causation; this application cannot update fraud rules.',
        `Readiness is based on live probes (cached for ${config.publicDemo ? 'five minutes' : '30 seconds'}); SQL write-denial acceptance is a separate deployment check.`,
        ...(config.publicDemo ? [
          'No sign-in. This public demo only exposes fictional synthetic aggregates and analyst-authorized synthetic documentation.',
          'Each question is standalone. Do not enter personal data, customer records or credentials.',
          'Shared limits: 12 analysis/knowledge requests per minute, two simultaneous requests, and 300 requests per UTC day on the single demo instance.',
          'Evidence is shared synthetic demo evidence, separate from authenticated analyst records. Request limits are not a monetary spending cap.',
        ] : []),
        ...(services.knowledge.status === 'keyword-only' ? ['Knowledge retrieval is explicitly keyword-only, not hybrid.'] : []),
      ],
    };
  }
  async function callKnowledge(path, context, validate) {
    const startedAt = now().getTime();
    const value = await call(config.knowledgeUrl, path, context);
    return validate(value, { startedAt, completedAt: now().getTime() });
  }
  async function knowledge(query, user, signal, traceId) {
    const validated = validateKnowledgeQuery(query);
    return callKnowledge('/v1/knowledge/search', { body: validated, user, signal, traceId },
      (value, evaluationWindow) => validateKnowledgeResponse(value, user, { snapshot: policySnapshot, query: validated, evaluationWindow }));
  }
  async function policies(user, signal, traceId) {
    return callKnowledge('/v1/knowledge/policies', { user, signal, traceId },
      (value, evaluationWindow) => validatePolicyCatalogResponse(value, user, policySnapshot, { evaluationWindow }));
  }
  async function analyze(value, user, { signal, traceId, mode = 'guided', question, plannerExecution } = {}) {
    const params = validateQuery(value);
    if (mode === 'natural-language') validatePlannerExecution(plannerExecution, {
      request: params, question, deployment: config.chatDeployment, configuredModelVersion: config.modelVersion ?? 'unverified',
    });
    const broker = structuredClone(await call(config.brokerUrl, '/v1/analytics/query', { body: params, user, signal, traceId }));
    if (!broker || typeof broker !== 'object' || Array.isArray(broker) ||
        Object.keys(broker).length !== BROKER_RESPONSE_FIELDS.length || BROKER_RESPONSE_FIELDS.some(field => !Object.hasOwn(broker, field)) ||
        !Array.isArray(broker.metrics) || !broker.table || !broker.narrative || broker.metricVersion !== METRIC_VERSION ||
        broker.templateVersion !== TEMPLATE_VERSION || !Array.isArray(broker.evidenceIds) || JSON.stringify(broker.params) !== JSON.stringify(params)) throw unavailable('Broker response contract');
    if (broker.sourceId !== sourceId || !Number.isFinite(sourceTime) || typeof broker.sourceAsOf !== 'string' ||
        parseSourceSnapshotTime(broker.sourceAsOf) !== sourceTime || broker.evidenceIds.length !== 1 ||
        typeof broker.evidenceIds[0] !== 'string' || !broker.evidenceIds[0].startsWith(evidencePrefix) ||
        !/^[a-f0-9]{64}$/.test(broker.evidenceIds[0].slice(evidencePrefix.length))) throw unavailable('Broker source provenance');
    const brokerReceipt = freeze({ schemaVersion: BROKER_RECEIPT_VERSION,
      responseSha256: createHash('sha256').update(JSON.stringify(broker)).digest('hex'), response: broker });
    let retrieved;
    try {
      retrieved = await callKnowledge('/v1/knowledge/compare', { body: params, user, signal, traceId },
        (value, evaluationWindow) => validateKnowledgeResponse(value, user, { snapshot: policySnapshot, request: params, evaluationWindow }));
    } catch (error) {
      const dependencyFailure = error instanceof AppError && error.status >= 500;
      const cancellation = ['AbortError', 'TimeoutError'].includes(error?.name);
      const networkFailure = error instanceof TypeError && /fetch failed|network/i.test(error.message);
      if (!dependencyFailure && !cancellation && !networkFailure) throw error;
      retrieved = { status: 'unavailable', sources: [], reasonCode: 'POLICY_CONTEXT_UNAVAILABLE' };
    }
    const answerId = randomUUID();
    const policyResolution = retrieved.policyResolution;
    const answer = freeze({
      answerId, synthetic: true,
      metrics: broker.metrics, table: broker.table,
      narrative: {
        ...broker.narrative,
        caveats: [
          ...broker.narrative.caveats,
          ...(mode === 'guided' ? ['Guided analysis: fixed typed request executed directly; no model planning was used.'] : ['Natural-language planning used the configured Canadian model; all numerical facts were computed by the reporting broker.']),
          ...(retrieved.status === 'unavailable' ? ['Knowledge service unavailable. No document context or citations were fabricated.'] : []),
          ...(retrieved.mode === 'keyword-only' ? ['Retrieved document context uses explicitly configured keyword-only search, not hybrid retrieval.'] : []),
          ...(policyResolution ? [
            'Policy context is entirely fictional, not actual Rogers policy or legal guidance. Current access controls apply to historical versions.',
            'Policy applicability is evaluated separately for actual previous and current periods, with exclusive end dates. Monthly aggregates cannot isolate sub-month policy effects or establish causality.',
          ] : []),
          ...(policyResolution?.status === 'conflict' ? ['Policy interpretation is withheld for conflicted subjects, scopes and date segments. Broker numerical metrics are preserved; no model selected a governing version.'] : []),
          ...(policyResolution?.status === 'no-applicable-policy' ? ['Policy interpretation is withheld wherever no authorized approved effective version applies. No old or future version was substituted.'] : []),
          ...(retrieved.sourceCoverage?.omittedResolvedVersions > 0 ? ['All applicable policy metadata was evaluated; excerpts are capped at four sources. Some resolved versions have metadata decisions but no returned excerpt.'] : []),
        ],
      },
      knowledge: retrieved,
      provenance: {
        sourceId: broker.sourceId, sourceAsOf: broker.sourceAsOf, generatedAt: now().toISOString(), traceId,
        metricVersion: broker.metricVersion, templateVersion: broker.templateVersion,
        brokerResponseSha256: brokerReceipt.responseSha256,
        promptVersion: mode === 'guided' ? 'not-used-guided-v1' : PROMPT_VERSION,
        ...(mode === 'natural-language' ? { modelDeployment: plannerExecution.deployment, plannerExecution } : {}),
        ...(policyResolution ? { policySetVersion: policyResolution.policySetVersion, policySnapshotHash: policyResolution.snapshotHash,
          policyEvaluatedAt: policyResolution.evaluatedAt } : {}),
        mode,
      },
      evidenceUrl: `/api/evidence/${answerId}`,
    });
    if (Buffer.byteLength(JSON.stringify(answer)) > MAX_RESPONSE_BYTES - 8192) throw unavailable('Answer byte budget');
    const artifact = freeze({
      answer, request: params, brokerEvidenceIds: broker.evidenceIds, suppressionPolicy: broker.suppressionPolicy,
      brokerReceipt,
      policyEvaluation: { knowledgeStatus: retrieved.status, periods: { previous: params.previous, current: params.current },
        ...(policyResolution ? { policySetVersion: policyResolution.policySetVersion, snapshotHash: policyResolution.snapshotHash,
          evaluatedAt: policyResolution.evaluatedAt, status: policyResolution.status, registry: policyResolution.registry } : { reasonCode: retrieved.reasonCode }) },
      ...(question ? { questionSha256: createHash('sha256').update(question).digest('hex') } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_RESPONSE_BYTES - 256) throw unavailable('Evidence byte budget');
    await evidence.put(user, answerId, artifact, signal);
    return answer;
  }
  return {
    status, knowledge, policies, analyze, evidence,
    async ask(question, user, context) {
      validateQuestion(question);
      const plan = await model.plan(question, context.signal);
      const request = validatePlan({ supported: true, request: plan?.request, reason: 'approved' });
      return analyze(request, user, { ...context, mode: 'natural-language', question, plannerExecution: plan.provenance });
    },
  };
}
