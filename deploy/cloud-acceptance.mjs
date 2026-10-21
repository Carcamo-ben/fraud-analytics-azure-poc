import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { documents, SOURCE_AS_OF } from '../seed/fixtures.mjs';
import { GUID, MAX_BODY_BYTES, MAX_RESPONSE_BYTES, parseSourceSnapshotTime } from '../src/validation.mjs';
import { POLICY_SNAPSHOT, resolvePolicies, resolveComparison, policyCatalog } from '../src/knowledge/policies.mjs';
import { validatePlannerExecution } from '../src/model.mjs';
import { METRIC_VERSION, BROKER_RESPONSE_FIELDS, BROKER_RECEIPT_VERSION } from '../src/broker/metrics.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const ABSENT_TERM = 'zzzzunseededlexicaltermqqqq';
export const SUPPORTED_QUESTION = 'How did CAD fraud losses by channel change from August to September 2026?';
export const UNSUPPORTED_QUESTION = 'What is the weather forecast for Ottawa tomorrow?';
export const LOSS_REQUEST = {
  kind: 'loss_comparison', groupBy: 'channel',
  current: { start: '2026-09-01', end: '2026-10-01' },
  previous: { start: '2026-08-01', end: '2026-09-01' },
};
const ruleRequest = { ...LOSS_REQUEST, kind: 'rule_quality' };
const sourceId = 'azure-sql-synthetic-fraud-v1';
const analyst = { businessUnit: 'poc', roles: ['analyst'] };
const policyKey = item => `${item.policyId}|${item.version}`;
export const MAX_ACCEPTANCE_REQUESTS = 128;
const READINESS_ATTEMPTS = 12;
export const POLICY_ACCEPTANCE_PROBES = [
  { check: 'policy-historical-loss', query: { q: 'Net fraud loss KPI', subject: 'loss-kpi', asOf: '2026-08-31' }, status: 'resolved', versions: ['4.0'] },
  { check: 'policy-current-loss', query: { q: 'Net fraud loss KPI', subject: 'loss-kpi', asOf: '2026-09-01' }, status: 'resolved', versions: ['4.1'] },
  { check: 'policy-before-exclusive-boundary', query: { q: 'R017', subject: 'r017-rule', asOf: '2026-09-11' }, status: 'resolved', versions: ['2.2'] },
  { check: 'policy-exclusive-boundary', query: { q: 'R017', subject: 'r017-rule', asOf: '2026-09-12' }, status: 'resolved', versions: ['2.3'] },
  { check: 'policy-future-draft-excluded', query: { q: 'R017', subject: 'r017-rule', asOf: '2026-09-19' }, status: 'resolved', versions: ['2.3'] },
  { check: 'policy-overlap-conflict', query: { q: 'Fictional policy overlap', subject: 'overlap-demo', asOf: '2026-09-15' }, status: 'conflict', versions: [] },
  { check: 'policy-expired-gap', query: { q: 'Fictional expired policy', subject: 'expired-demo', asOf: '2026-09-01' }, status: 'no-applicable-policy', versions: [] },
  { check: 'policy-scoped-qc-exception', query: { q: 'R017', subject: 'r017-rule', asOf: '2026-09-22', province: 'QC' }, status: 'resolved', versions: ['2.4-qc'] },
  { check: 'policy-scoped-default-outside-qc', query: { q: 'R017', subject: 'r017-rule', asOf: '2026-09-22', province: 'ON' }, status: 'resolved', versions: ['2.3'] },
  { check: 'policy-historical-current-acl', query: { q: 'Restricted governance appendix', subject: 'restricted-governance', asOf: '2026-08-31' }, status: 'no-applicable-policy', versions: [] },
];
const REQUIRED_POLICY_CHECKS = Object.freeze(['knowledge-private-ready', 'policy-snapshot-catalog',
  ...POLICY_ACCEPTANCE_PROBES.map(item => item.check),
  'archived-answer-roundtrip', 'archived-rule-answer-roundtrip', 'archived-natural-language-question-and-plan']);
const assertText = (value, label, max = 1000) =>
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} must be a bounded nonempty string.`);
const sameInstant = (actual, expected, label) => {
  assertText(actual, label, 40);
  const time = parseSourceSnapshotTime(actual);
  assert(Number.isFinite(time), `${label} must be a real UTC snapshot calendar instant.`);
  assert.equal(time, parseSourceSnapshotTime(expected), `${label} must match the seeded source timestamp.`);
};

// Serialize starts across all three services, including readiness retries. Proxy calls
// add at most one request per backend per external request. Six seconds also leaves
// headroom below the public demo's shared 12/minute knowledge/analysis budget.
export function createPacer({ clock = Date.now, sleep = delay, intervalMs = 6000 } = {}) {
  let last = -Infinity;
  let pending = Promise.resolve();
  return () => {
    const next = pending.then(async () => {
      const wait = last + intervalMs - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
    });
    pending = next.catch(() => {});
    return next;
  };
}

export async function boundedResponseJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('Response exceeds the acceptance byte budget.');
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    return { nonJson: true };
  }
  assert(response.body, 'JSON response body is required.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the acceptance byte budget.');
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createHttpCaller({ fetchImpl = fetch, pace = createPacer(), maxRequests = MAX_ACCEPTANCE_REQUESTS } = {}) {
  assert(Number.isInteger(maxRequests) && maxRequests > 0 && maxRequests <= MAX_ACCEPTANCE_REQUESTS, 'Acceptance request cap must be bounded.');
  let started = 0;
  return async (url, options = {}) => {
    assert(!options.body || (typeof options.body === 'string' && Buffer.byteLength(options.body) <= MAX_BODY_BYTES), 'Request exceeds the acceptance byte budget.');
    assert(started < maxRequests, 'Acceptance HTTP request cap reached; no further network request was issued.');
    started++;
    const correlationId = randomUUID();
    await pace();
    const response = await fetchImpl(url, {
      ...options, headers: { ...options.headers, 'x-correlation-id': correlationId },
      signal: AbortSignal.timeout(120000), redirect: 'manual',
    });
    return {
      status: response.status, correlationId,
      responseTraceId: response.headers.get('x-correlation-id'),
      value: await boundedResponseJson(response),
    };
  };
}

export function assertHttp(result, status = 200) {
  assert.equal(result.status, status, `Expected HTTP ${status}; observed HTTP ${result.status}.`);
  assert(GUID.test(result.correlationId || ''), 'Request correlation ID must be a UUID.');
  assert.equal(result.responseTraceId, result.correlationId, 'Response must preserve the request correlation ID.');
  assert(result.value && typeof result.value === 'object' && !result.value.nonJson, 'Response must contain JSON, not a redirect or sign-in page.');
}

export function assertApiError(result, status, code, relevantMessage) {
  assertHttp(result, status);
  assert.equal(result.value.error?.code, code, `Expected error code ${code}.`);
  assertText(result.value.error?.message, 'Error message');
  assert.match(result.value.error.message, relevantMessage, 'Error message must explain the expected rejection.');
  assert.equal(result.value.error.traceId, result.correlationId, 'Error must preserve the request trace ID.');
  for (const field of ['answerId', 'answer', 'table', 'metrics', 'evidenceUrl']) {
    assert(!Object.hasOwn(result.value, field), 'A refusal must not contain a successful or fallback answer.');
  }
}

export function assertInvalidRequest(result, relevantMessage) {
  assertApiError(result, 400, 'INVALID_REQUEST', relevantMessage);
}

export function validatePolicyResolution(resolution, { query, request, asOf } = {}) {
  assert.equal(resolution?.registry, 'synthetic-policy-manifest', 'Policy resolution must identify the synthetic manifest authority.');
  assert.equal(resolution.policySetVersion, POLICY_SNAPSHOT.policySetVersion, 'Policy set must match this release, not the legacy corpus.');
  assert.equal(resolution.snapshotHash, POLICY_SNAPSHOT.snapshotHash, 'Policy snapshot must match this release.');
  assertText(resolution.evaluatedAt, 'Policy evaluation timestamp', 40);
  assert(Number.isFinite(Date.parse(resolution.evaluatedAt)), 'Policy evaluation timestamp must be valid.');
  assert(['resolved', 'conflict', 'no-applicable-policy'].includes(resolution.status), 'Policy resolution status must be explicit.');
  assert(Array.isArray(resolution.decisions) && resolution.decisions.length <= 128, 'Policy decisions must be bounded.');
  assert(Array.isArray(resolution.conflicts) && resolution.conflicts.length <= 128, 'Policy conflicts must be bounded.');
  if (request) {
    assert(Array.isArray(resolution.segments) && resolution.segments.length <= 32, 'Both actual periods must have bounded policy segments.');
    assert.deepEqual(resolution, resolveComparison(POLICY_SNAPSHOT, analyst, request, resolution.evaluatedAt), 'Comparison resolution must preserve the actual periods, scoped decisions, conflicts and snapshot.');
  } else {
    assert(!resolution.periods && !resolution.segments, 'Comparison citations require the actual typed request, not a single as-of date.');
    assert.equal(resolution.asOf, query?.asOf ?? asOf, 'Policy resolution must use the requested as-of date.');
    if (query) assert.deepEqual(resolution, resolvePolicies(POLICY_SNAPSHOT, analyst, query, resolution.evaluatedAt), 'Policy resolution must match authoritative approved, effective, current-ACL decisions.');
    else {
      const conflicts = [];
      for (const decision of resolution.decisions) {
        const scope = decision.scope ?? {};
        const scoped = resolvePolicies(POLICY_SNAPSHOT, analyst, {
          q: '', asOf, subject: decision.subject,
          ...(scope.channel !== '*' ? { channel: scope.channel } : {}),
          ...(scope.province !== '*' ? { province: scope.province } : {}),
        }, resolution.evaluatedAt);
        const expected = scoped.decisions.find(item => isDeepStrictEqual(item.scope, scope));
        assert.deepEqual(decision, expected, 'Every policy decision must match current analyst-authorized effective metadata.');
        conflicts.push(...scoped.conflicts.filter(item => isDeepStrictEqual(item.scope, scope)));
      }
      assert.deepEqual(resolution.conflicts, conflicts, 'Conflict metadata must match the authorized scoped decisions.');
      const status = resolution.decisions.some(item => item.status === 'conflict') ? 'conflict'
        : !resolution.decisions.length || resolution.decisions.some(item => item.status === 'no-applicable-policy') ? 'no-applicable-policy' : 'resolved';
      assert.equal(resolution.status, status, 'Resolution summary must agree with its scoped decisions.');
    }
  }
  return resolution;
}

export function validatePolicyCatalog(value) {
  assert.equal(value?.status, 'available', 'Policy catalog must be available.');
  assert.equal(value.synthetic, true, 'Policy catalog must identify fictional synthetic data.');
  assertText(value.evaluatedAt, 'Catalog evaluation timestamp', 40);
  assert(Number.isFinite(Date.parse(value.evaluatedAt)), 'Catalog evaluation timestamp must be valid.');
  assert.deepEqual(value, policyCatalog(POLICY_SNAPSHOT, analyst, value.evaluatedAt),
    'Catalog must match this complete release and current analyst ACLs without bodies or restricted metadata.');
  return { registry: value.registry, policySetVersion: value.policySetVersion, snapshotHash: value.snapshotHash,
    authorizedVersions: value.policies.length, authorizedScenarios: value.scenarios.length };
}

export function validateCitations(knowledge, asOf, { requireSources = false, query, request } = {}) {
  assert.equal(knowledge?.status, 'available', 'Knowledge must be available; dependency failure is not an empty result.');
  assert(['hybrid', 'keyword-only'].includes(knowledge.mode), 'Retrieval must declare its actual supported mode.');
  assert(Array.isArray(knowledge.sources) && knowledge.sources.length <= 4, 'Knowledge sources must be a bounded array.');
  if (requireSources) assert(knowledge.sources.length > 0, 'Expected at least one live source citation.');
  const resolution = validatePolicyResolution(knowledge.policyResolution, { query, request, asOf });
  const ids = new Set();
  let excerptChars = 0;
  for (const source of knowledge.sources) {
    for (const [key, max] of Object.entries({ citationId: 100, policyId: 100, documentId: 100, title: 180, version: 30, effectiveFrom: 10, chunkId: 100, excerpt: 1100 })) {
      assertText(source[key], `Citation ${key}`, max);
    }
    const doc = documents.find(item => item.docId === source.documentId && item.version === source.version && item.chunkId === source.chunkId);
    assert(doc && doc.allowedRoles.includes('analyst'), 'Only exact seeded analyst-authorized document/version/chunk identities may be returned.');
    assert.equal(source.policyId, doc.policyId, 'Citation policy ID must match the seeded version.');
    assert.equal(source.title, doc.title, 'Citation title must match the seeded document.');
    assert.equal(source.version, doc.version, 'Citation version must match the seeded document.');
    assert.equal(source.chunkId, doc.chunkId, 'Citation chunk ID must match the seeded document.');
    assert.equal(source.effectiveFrom, doc.effectiveFrom.slice(0, 10), 'Citation effective date must match the seeded document.');
    assert.equal(source.effectiveTo, doc.effectiveTo?.slice(0, 10) ?? null, 'Citation exclusive end must match the seeded document.');
    assert.equal(doc.approvalStatus, 'approved', 'Only approved policy content may be cited.');
    const decisions = resolution.decisions.filter(item => item.status === 'resolved' && policyKey(item) === policyKey(source));
    assert(decisions.length > 0, 'Citations must belong to a resolved version, never a conflicted or inapplicable candidate.');
    const appliesTo = decisions.map(item => ({
      ...(item.period ? { period: item.period, start: item.start, end: item.end } : { asOf: resolution.asOf }), scope: item.scope,
    }));
    assert.deepEqual(source.appliesTo, appliesTo, 'Citation applicability must bind exactly the resolved dates and scopes.');
    for (const applicability of appliesTo) {
      const day = applicability.start ?? applicability.asOf;
      assert(source.effectiveFrom <= day, 'Future-effective definitions must not be returned.');
      assert(source.effectiveTo === null || day < source.effectiveTo, 'Expired definitions must not be returned at the exclusive end.');
      if (applicability.end) assert(source.effectiveTo === null || applicability.end <= source.effectiveTo, 'A citation cannot extend beyond its exclusive effective end.');
      const { scope } = applicability;
      const resolved = resolvePolicies(POLICY_SNAPSHOT, analyst, {
        q: '', subject: doc.scopeSubject, asOf: day,
        ...(scope.channel !== '*' ? { channel: scope.channel } : {}),
        ...(scope.province !== '*' ? { province: scope.province } : {}),
      }, resolution.evaluatedAt);
      assert(resolved.decisions.some(item => item.status === 'resolved' && policyKey(item) === policyKey(source) &&
        isDeepStrictEqual(item.scope, scope)), 'Citation scope must be authorized and resolved by the current manifest.');
    }
    assert.equal(source.excerpt, doc.content.slice(0, source.excerpt.length), 'Citation excerpt must come from the identified seeded chunk.');
    assert.equal(source.citationId, `cite-${sha256(`${doc.docId}|${doc.version}|${doc.chunkId}`).slice(0, 20)}`, 'Citation ID must bind its document, version and chunk.');
    assert(!ids.has(source.citationId), 'Citations must not contain duplicate IDs.');
    ids.add(source.citationId);
    excerptChars += source.excerpt.length;
  }
  assert(excerptChars <= 4000, 'Combined citation excerpts must remain bounded.');
  const resolvedVersions = new Set(resolution.decisions.filter(item => item.status === 'resolved').map(policyKey)).size;
  const citedVersions = new Set(knowledge.sources.map(policyKey)).size;
  assert.deepEqual(knowledge.sourceCoverage, { allPolicyMetadataEvaluated: true, maxSources: 4,
    resolvedVersions, citedVersions, omittedResolvedVersions: resolvedVersions - citedVersions }, 'Source coverage must distinguish complete policy decisions from bounded excerpts.');
  return knowledge.sources.map(({ citationId, policyId, documentId, version, effectiveFrom, effectiveTo, chunkId, appliesTo }) =>
    ({ citationId, policyId, documentId, version, effectiveFrom, effectiveTo, chunkId, appliesTo }));
}

export function validateAbsentTerm(knowledge) {
  assert(!documents.some(doc => `${doc.title} ${doc.content}`.toLowerCase().includes(ABSENT_TERM)), 'Absent-term probe must not occur in the seeded corpus.');
  const citations = validateCitations(knowledge, '2026-09-30', { query: { q: ABSENT_TERM, asOf: '2026-09-30' } });
  assert.equal(knowledge.policyResolution.status, 'no-applicable-policy', 'An unrecognized policy subject must not acquire a governing version through relevance.');
  assert.equal(citations.length, 0, 'An unrecognized policy subject must be empty in both retrieval modes.');
  return {
    query: ABSENT_TERM, asOf: '2026-09-30', mode: knowledge.mode, sourceCount: citations.length, citations,
    emptyResultObserved: citations.length === 0,
    interpretation: 'The service returned an available no-applicable-policy result for an unrecognized subject, not an outage or fabricated semantic policy. Browser empty-state rendering remains unverified.',
  };
}

export function validatePolicyProbe(value, probe) {
  const citations = validateCitations(value, probe.query.asOf, { query: probe.query, requireSources: probe.status === 'resolved' });
  assert.equal(value.policyResolution.status, probe.status, 'Policy scenario must have its expected authoritative outcome.');
  const versions = [...new Set(value.policyResolution.decisions.filter(item => item.status === 'resolved').map(item => item.version))].sort();
  assert.deepEqual(versions, [...probe.versions].sort(), 'Scenario must select the expected approved version, not the newest publication.');
  if (probe.status !== 'resolved') assert.equal(value.sources.length, 0, 'Unresolved scenario must not cite a governing candidate.');
  return { query: probe.query, status: value.policyResolution.status, versions, citations,
    policySetVersion: value.policyResolution.policySetVersion, snapshotHash: value.policyResolution.snapshotHash,
    conflicts: value.policyResolution.conflicts };
}

export function evidencePath(answer) {
  assert(GUID.test(answer?.answerId || ''), 'Answer ID must be a UUID.');
  assert.equal(answer.evidenceUrl, `/api/evidence/${answer.answerId}`, 'Evidence URL must be the same-origin answer-specific API path.');
  return answer.evidenceUrl;
}

export function validateProvenance(answer, result, mode, modelDeployment, request) {
  assertHttp(result);
  assert.equal(answer.synthetic, true, 'Answer must identify synthetic data.');
  evidencePath(answer);
  const provenance = answer.provenance;
  assert.equal(provenance?.mode, mode, 'Execution mode must reflect the requested execution path.');
  assert.equal(provenance.traceId, result.correlationId, 'Answer trace must match the request and response correlation IDs.');
  assert.equal(provenance.sourceId, sourceId, 'Answer must identify the synthetic Azure SQL source.');
  sameInstant(provenance.sourceAsOf, SOURCE_AS_OF, 'Source as-of timestamp');
  assertText(provenance.generatedAt, 'Generated timestamp', 40);
  assert(Number.isFinite(Date.parse(provenance.generatedAt)), 'Generated timestamp must be valid.');
  assert.equal(provenance.metricVersion, METRIC_VERSION, 'Metric version must match this release.');
  assert.equal(provenance.templateVersion, 'reporting-select-1.0.0', 'Query template version must be explicit.');
  assert(/^[a-f0-9]{64}$/.test(provenance.brokerResponseSha256 ?? ''), 'Broker response digest must be explicit.');
  assert.equal(provenance.promptVersion, mode === 'guided' ? 'not-used-guided-v1' : 'planner-v1', 'Prompt version must identify guided versus model execution.');
  const actualRequest = request ?? (answer.metrics?.some(item => item.key === 'focusRule') ? ruleRequest : LOSS_REQUEST);
  if (mode === 'guided') {
    assert(!Object.hasOwn(provenance, 'modelDeployment'), 'Guided execution must not claim model planning.');
    assert(!Object.hasOwn(provenance, 'plannerExecution'), 'Guided execution must not claim a model completion.');
  }
  else {
    assertText(modelDeployment, 'Configured model deployment');
    assert.equal(provenance.modelDeployment, modelDeployment, 'Natural-language provenance must identify the API-reported model deployment.');
    validatePlannerExecution(provenance.plannerExecution, { request: actualRequest, deployment: modelDeployment });
  }
  assert(Array.isArray(answer.narrative?.caveats) && answer.narrative.caveats.length > 0, 'Answer must include metric caveats.');
  validateCitations(answer.knowledge, undefined, { requireSources: true, request: actualRequest });
  const resolution = answer.knowledge.policyResolution;
  assert.equal(provenance.policySetVersion, resolution.policySetVersion, 'Answer provenance must preserve the evaluated policy set.');
  assert.equal(provenance.policySnapshotHash, resolution.snapshotHash, 'Answer provenance must preserve the evaluated snapshot.');
  assert.equal(provenance.policyEvaluatedAt, resolution.evaluatedAt, 'Answer provenance must preserve policy evaluation time.');
}

function metric(answer, key, value, format) {
  assert(Array.isArray(answer.metrics), 'Answer metrics must be an array.');
  const matches = answer.metrics.filter(item => item.key === key);
  assert.equal(matches.length, 1, `Expected exactly one ${key} metric.`);
  assert.equal(matches[0].value, value, `${key} must equal the independently recomputed value.`);
  assert.equal(matches[0].format, format, `${key} must use the correct unit.`);
  if (format === 'currency') assert.equal(matches[0].currency, 'CAD', `${key} must be labeled CAD.`);
  return matches[0];
}

function column(answer, key, format) {
  assert(Array.isArray(answer.table?.columns), 'Table columns must be an array.');
  const matches = answer.table.columns.filter(item => item.key === key);
  assert.equal(matches.length, 1, `Expected exactly one ${key} table column.`);
  assert.equal(matches[0].format, format, `${key} table column must use the correct unit.`);
  if (format === 'currency') assert.equal(matches[0].currency, 'CAD', `${key} table column must be labeled CAD.`);
}

export function validateLossAnswer(answer) {
  const expected = {
    'Card-not-present': [930000, 690000],
    'Digital wallet': [110000, 90000],
    'Card-present': [200000, 220000],
  };
  assert(Array.isArray(answer.table?.rows) && answer.table.rows.length === 3, 'Expected all three seeded channel loss rows; missing data is not zero.');
  assert.equal(new Set(answer.table.rows.map(row => row.group)).size, 3, 'Each channel must occur once.');
  for (const row of answer.table.rows) {
    assert(Object.hasOwn(expected, row.group), 'Unexpected loss channel.');
    const [current, previous] = expected[row.group];
    assert.equal(row.currentLoss, current, 'Current channel loss must match the seed.');
    assert.equal(row.previousLoss, previous, 'Previous channel loss must match the seed.');
    assert.equal(row.delta, round(current - previous), 'Channel loss delta must equal current minus previous.');
    assert.equal(row.deltaPercent, round((current - previous) / previous * 100), 'Channel relative change must use the previous loss denominator.');
  }
  const current = answer.table.rows.reduce((sum, row) => sum + row.currentLoss, 0);
  const previous = answer.table.rows.reduce((sum, row) => sum + row.previousLoss, 0);
  metric(answer, 'currentLoss', current, 'currency');
  metric(answer, 'previousLoss', previous, 'currency');
  metric(answer, 'lossDelta', current - previous, 'currency');
  metric(answer, 'lossChangePercent', round((current - previous) / previous * 100), 'percent');
  for (const key of ['currentLoss', 'previousLoss', 'delta']) column(answer, key, 'currency');
  column(answer, 'deltaPercent', 'percent');
  assert.match(answer.narrative.caveats.join(' '), /not daily-normalized/i, 'Loss definition must describe calendar-period totals.');
  return { currentLossCad: current, previousLossCad: previous, deltaCad: current - previous, changePercent: 24, rows: answer.table.rows };
}

export function validateRuleRates(row) {
  for (const period of ['current', 'previous']) {
    const denominator = row[`${period}Adjudicated`], numerator = row[`${period}FalsePositives`];
    assert(Number.isSafeInteger(denominator) && denominator >= 0, 'Adjudicated denominator must be a nonnegative integer.');
    assert(Number.isSafeInteger(numerator) && numerator >= 0 && numerator <= denominator, 'False positives must be a count within the adjudicated denominator.');
    assert.equal(row[`${period}Share`], denominator === 0 ? null : round(numerator / denominator * 100), 'FP share must use adjudicated alerts; a zero denominator is undefined, not zero.');
  }
  assert.equal(row.shareChangePp, row.currentAdjudicated === 0 || row.previousAdjudicated === 0 ? null
    : round((row.currentFalsePositives / row.currentAdjudicated - row.previousFalsePositives / row.previousAdjudicated) * 100),
  'Share change must use underlying count ratios, not rounded display rates or percent change.');
}

export function validateRuleAnswer(answer) {
  assert(Array.isArray(answer.table?.rows) && answer.table.rows.length === 9, 'Expected three seeded rules across three channels.');
  const keys = new Set();
  for (const row of answer.table.rows) {
    assert(['Card-not-present', 'Digital wallet', 'Card-present'].includes(row.group), 'Unexpected rule channel.');
    assert(['R017', 'R042', 'R063'].includes(row.ruleId), 'Rule IDs must match actual seeded IDs (without an inserted hyphen).');
    const key = `${row.ruleId}|${row.group}`;
    assert(!keys.has(key), 'Rule/channel rows must be unique.');
    keys.add(key);
    validateRuleRates(row);
  }
  const totals = {};
  for (const [id, expected] of Object.entries({
    R017: [18000, 13680, 15000, 10200], R042: [12000, 7800, 10000, 6000], R063: [6000, 1800, 5000, 1750],
  })) {
    const rows = answer.table.rows.filter(row => row.ruleId === id);
    const values = ['currentAdjudicated', 'currentFalsePositives', 'previousAdjudicated', 'previousFalsePositives']
      .map(key => rows.reduce((sum, row) => sum + row[key], 0));
    assert.deepEqual(values, expected, 'Rule count totals must match the seeded adjudicated cohorts.');
    totals[id] = { currentAdjudicated: values[0], currentFalsePositives: values[1], previousAdjudicated: values[2], previousFalsePositives: values[3] };
  }
  metric(answer, 'focusRule', 'R017', 'text');
  const current = metric(answer, 'currentFpShare', 76, 'percent');
  assert.match(current.detail || '', /FP \/ \(TP \+ FP\).*adjudicated/i, 'FP metric must expose its actual denominator.');
  metric(answer, 'previousFpShare', 68, 'percent');
  metric(answer, 'fpShareChangePp', 8, 'percentagePoints');
  metric(answer, 'currentAdjudicated', 18000, 'number');
  metric(answer, 'currentFalsePositives', 13680, 'number');
  column(answer, 'currentShare', 'percent');
  column(answer, 'previousShare', 'percent');
  column(answer, 'shareChangePp', 'percentagePoints');
  assert.match(answer.narrative.caveats.join(' '), /not population false-positive rate/i, 'Answer must not claim a population false-positive rate.');
  return { totals, focusRule: 'R017', currentSharePercent: 76, previousSharePercent: 68, shareChangePercentagePoints: 8 };
}

export function validateEvidence(artifact, answer, request, subjectOid, question) {
  assert.equal(artifact?.schemaVersion, 'evidence-v1', 'Evidence schema version is required.');
  assert(GUID.test(subjectOid || ''), 'Expected evidence owner must be a valid delegated user OID.');
  assert.equal(artifact.subjectOid, subjectOid.toLowerCase(), 'Evidence must belong to the delegated test user.');
  assert.deepEqual(artifact.answer, answer, 'Archived answer must exactly preserve the returned answer, provenance, metrics and citations.');
  assert.deepEqual(artifact.request, request, 'Archived typed request must preserve the actual periods and grouping.');
  for (const key of ['sourceId', 'sourceAsOf', 'generatedAt', 'traceId', 'metricVersion', 'templateVersion', 'promptVersion', 'mode',
    'policySetVersion', 'policySnapshotHash', 'policyEvaluatedAt']) {
    assertText(artifact.answer?.provenance?.[key], `Archived provenance ${key}`);
  }
  assert.equal(artifact.answer.provenance.sourceId, sourceId, 'Archived evidence must identify the approved synthetic source.');
  sameInstant(artifact.answer.provenance.sourceAsOf, SOURCE_AS_OF, 'Archived source timestamp');
  evidencePath(artifact.answer);
  assert(Array.isArray(artifact.brokerEvidenceIds) && artifact.brokerEvidenceIds.length > 0 && artifact.brokerEvidenceIds.length <= 100, 'Evidence must include bounded broker result identifiers.');
  assert(artifact.brokerEvidenceIds.every(id => /^sql:[a-f0-9]{64}$/.test(id)), 'Broker evidence IDs must be SHA-256 SQL result references.');
  assert.deepEqual(artifact.suppressionPolicy, { version: 'cohort-10-total-withholding-v1', threshold: 10 }, 'Evidence must retain the cohort suppression policy.');
  const receipt = artifact.brokerReceipt, broker = receipt?.response;
  assert.equal(receipt?.schemaVersion, BROKER_RECEIPT_VERSION, 'Evidence must retain the original approved broker response.');
  assert(broker && typeof broker === 'object' && !Array.isArray(broker), 'Broker receipt response must be an object.');
  assert.deepEqual(Object.keys(broker).sort(), [...BROKER_RESPONSE_FIELDS].sort(), 'Broker receipt must contain only the approved response schema.');
  assert.equal(receipt.responseSha256, sha256(JSON.stringify(broker)), 'Broker receipt digest must bind its actual JSON object.');
  assert.equal(answer.provenance.brokerResponseSha256, receipt.responseSha256, 'Returned answer must identify the archived broker response.');
  assert.deepEqual(broker.params, request, 'Broker receipt must bind the actual typed request.');
  assert.deepEqual(broker.metrics, answer.metrics, 'Displayed metrics must preserve the original broker metrics.');
  assert.deepEqual(broker.table, answer.table, 'Displayed breakdown must preserve the original broker table.');
  for (const key of ['headline', 'text', 'investigationSteps']) {
    assert.deepEqual(broker.narrative?.[key], answer.narrative?.[key], `Displayed narrative ${key} must preserve broker facts.`);
  }
  assert(Array.isArray(broker.narrative?.caveats), 'Broker receipt must preserve source caveats.');
  assert.deepEqual(answer.narrative.caveats.slice(0, broker.narrative.caveats.length), broker.narrative.caveats, 'Web caveats may append but never rewrite broker caveats.');
  for (const key of ['sourceId', 'metricVersion', 'templateVersion']) {
    assert.equal(broker[key], answer.provenance[key], `Broker receipt ${key} must match returned provenance.`);
  }
  sameInstant(broker.sourceAsOf, answer.provenance.sourceAsOf, 'Broker receipt source timestamp');
  assert.deepEqual(broker.evidenceIds, artifact.brokerEvidenceIds, 'Original broker result IDs must be preserved.');
  assert.deepEqual(broker.suppressionPolicy, artifact.suppressionPolicy, 'Original suppression policy must be preserved.');
  if (question) {
    assert.equal(artifact.questionSha256, sha256(question), 'Evidence question hash must bind the unchanged natural-language question.');
    validatePlannerExecution(artifact.answer.provenance.plannerExecution, {
      request, question, deployment: artifact.answer.provenance.modelDeployment,
    });
  } else {
    assert(!Object.hasOwn(artifact, 'questionSha256'), 'Guided evidence must not claim a natural-language question.');
    assert(!Object.hasOwn(artifact.answer.provenance, 'plannerExecution'), 'Guided evidence must not claim a model completion.');
  }
  const citations = validateCitations(artifact.answer.knowledge, undefined, { requireSources: true, request });
  const resolution = artifact.answer.knowledge.policyResolution;
  assert.deepEqual(artifact.policyEvaluation, {
    knowledgeStatus: 'available', periods: { previous: request.previous, current: request.current },
    policySetVersion: resolution.policySetVersion, snapshotHash: resolution.snapshotHash, evaluatedAt: resolution.evaluatedAt,
    status: resolution.status, registry: resolution.registry,
  }, 'Evidence must preserve the actual policy periods, snapshot, evaluation time and outcome.');
  assert.equal(answer.provenance.policySetVersion, resolution.policySetVersion, 'Archived policy set provenance must agree with the resolution.');
  assert.equal(answer.provenance.policySnapshotHash, resolution.snapshotHash, 'Archived snapshot provenance must agree with the resolution.');
  assert.equal(answer.provenance.policyEvaluatedAt, resolution.evaluatedAt, 'Archived policy evaluation time must agree with the resolution.');
  return {
    answerId: answer.answerId, evidenceUrl: answer.evidenceUrl, request: artifact.request,
    provenance: answer.provenance, brokerEvidenceIds: artifact.brokerEvidenceIds,
    citations, policyEvaluation: artifact.policyEvaluation,
    ...(question ? { questionSha256: artifact.questionSha256 } : {}),
  };
}

function story(id, title, unverifiedCriteria) {
  return { id, title, observations: [], unverifiedCriteria };
}

export function createReport() {
  return {
    synthetic: true, liveAzure: false, generatedAt: new Date().toISOString(), trace: randomUUID(),
    checks: [], failures: [], acceptedAnswerIds: [],
    policyRelease: {
      registry: 'synthetic-policy-manifest', policySetVersion: POLICY_SNAPSHOT.policySetVersion,
      snapshotHash: POLICY_SNAPSHOT.snapshotHash, indexName: POLICY_SNAPSHOT.indexName,
      requiredChecks: [...REQUIRED_POLICY_CHECKS],
      status: 'not-verified',
    },
    verificationScope: 'Live authenticated HTTP contracts and stored answer roundtrips; not a completed browser walkthrough or independent infrastructure audit.',
    stories: [
      story('FI-01', 'Compare calendar-month CAD losses', [
        'Browser scenario selection, CAD rendering, and visible failure/no-data behavior require an interactive private-network walkthrough.',
        'Zero/negative prior-loss baselines and suppressed cohorts are not present in the seeded channel comparison.',
      ]),
      story('FI-02', 'Inspect rule false-positive share', [
        'The seeded live cohort has nonzero adjudicated denominators; zero-denominator presentation is not exercised by this cloud run.',
        'Browser rendering and absence of invented browser rows/recommendations require an interactive walkthrough.',
      ]),
      story('FI-03', 'Look up an effective definition', [
        'Browser source expansion, empty-state rendering and dependency-outage behavior require an interactive walkthrough.',
        'Current ACL exclusion of historical/current documents and metadata is checked for the default analyst only; cross-principal entitlement isolation requires separate verification.',
        'Conflict retrieval is exercised independently; the default analytics policies resolve, so this run does not inject a numerical answer with conflicting policy metadata.',
      ]),
      story('FI-04', 'Reconstruct an answer from evidence', [
        'Drawer fetches, download contents and denied/error UI behavior require an interactive walkthrough.',
        'An HTTP roundtrip does not verify retention duration, immutability, lifecycle policy, disaster recovery, or cross-user isolation.',
        'SQL result references are not independent database execution logs or retained source snapshots.',
        'Current policy-owner revocation and a denied historical evidence read require separately authorized cross-principal testing; this run never changes access.',
      ]),
      story('FI-05', 'Observe invalid-request rejection', [
        'Inspect backend traces for the recorded correlation IDs to establish zero database reads/writes before rejection; HTTP 400 alone cannot prove this.',
        'The browser boundary form and unexpected-success/error presentation require an interactive walkthrough.',
      ]),
      story('FI-06', 'Ask a bounded question in natural language', [
        'Verify Canada residency and actual regional model invocation using deployed resource configuration and service/model telemetry; API provenance alone is insufficient.',
        'Disabled composer, unchanged browser submission, model-outage behavior and no client fallback require an interactive walkthrough.',
      ]),
    ],
    limits: [
      'Small seeded synthetic Azure SQL Database only; no original SQL MI/Oracle connection or 1 TB performance test.',
      'Requires an actual delegated token for the configured default analyst and the real web managed identity for private backend calls.',
      'Interactive browser access requires provisioned private networking.',
      'No outage injection, production data changes, SQL mutations or alternate-principal authentication are performed.',
      `HTTP starts are serialized at least 6 seconds apart with at most ${MAX_ACCEPTANCE_REQUESTS} requests and ${READINESS_ATTEMPTS} attempts per readiness probe; unrelated traffic can still consume quota.`,
      'New policy readiness requires the exact manifest/index snapshot; the deployed legacy six-chunk corpus is not accepted as this release.',
    ],
  };
}

export function finalizeReport(report) {
  report.policyReleaseVerified = report.liveAzure === true && report.failures.length === 0 &&
    report.policyRelease?.snapshotHash === POLICY_SNAPSHOT.snapshotHash &&
    report.policyRelease?.policySetVersion === POLICY_SNAPSHOT.policySetVersion &&
    REQUIRED_POLICY_CHECKS.every(check => report.checks.includes(check));
  if (report.policyRelease) report.policyRelease.status = report.policyReleaseVerified ? 'api-verified' : 'not-verified';
  report.allApiChecksPassed = report.policyReleaseVerified && report.stories.every(item => item.observations.length > 0 && item.observations.every(check => check.status === 'passed'));
  for (const item of report.stories) {
    item.status = item.observations.some(check => check.status === 'failed') ? 'failed'
      : !item.observations.length || item.observations.some(check => check.status === 'blocked') ? 'blocked'
        : item.unverifiedCriteria.length ? 'partial' : 'verified';
  }
  report.allStoriesVerified = report.stories.every(item => item.status === 'verified');
  report.outcome = report.allApiChecksPassed ? (report.allStoriesVerified ? 'passed' : 'partial') : 'failed';
  return report;
}

function observation(result) {
  if (!result) return { responseReceived: false };
  const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
  return {
    httpStatus: result.status, requestCorrelationId: result.correlationId, responseTraceId: result.responseTraceId,
    ...(result.value?.error ? {
      error: {
        code: bounded(result.value.error.code, 100),
        message: bounded(result.value.error.message, 1000),
        traceId: bounded(result.value.error.traceId, 80),
      },
    } : {}),
  };
}

export async function runCloudAcceptance(cfg, userToken) {
  if (cfg.publicDemoEnabled === true) {
    assert(GUID.test(cfg.publicDemoUserOid || '') && cfg.publicDemoUserOid !== cfg.allowedUserOid, 'Public acceptance needs its distinct synthetic identity.');
    cfg = { ...cfg, allowedUserOid: cfg.publicDemoUserOid };
  }
  const { ManagedIdentityCredential } = await import('@azure/identity');
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const report = createReport();
  const web = cfg.apps.find(app => app.role === 'web');
  const broker = cfg.apps.find(app => app.role === 'broker');
  const knowledge = cfg.apps.find(app => app.role === 'knowledge');
  const call = createHttpCaller();
  const secrets = [userToken];
  const redact = value => {
    let text = String(value ?? '').replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  };
  const cleanObject = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
  const failureReason = error => error instanceof assert.AssertionError
    ? redact(error.message.split('\n')[0]).slice(0, 500)
    : 'Transport, JSON budget/parsing, credentials or live dependency operation failed; inspect private service telemetry without exposing bearer tokens.';
  const record = async (storyId, name, operation) => {
    const item = report.stories.find(entry => entry.id === storyId);
    const entry = { check: name, status: 'failed', observed: {} };
    if (item) item.observations.push(entry);
    try {
      const value = await operation(entry);
      entry.status = 'passed';
      report.checks.push(name);
      return value;
    } catch (error) {
      entry.reason = failureReason(error);
      report.failures.push({ storyId: storyId ?? null, check: name, reason: entry.reason, observed: entry.observed });
      return undefined;
    }
  };
  const blocked = (storyId, name, reason) => report.stories.find(item => item.id === storyId).observations.push({ check: name, status: 'blocked', reason });
  const requestCheck = (storyId, name, url, options, validate) => record(storyId, name, async entry => {
    entry.endpoint = new URL(url).pathname;
    entry.method = options.method || 'GET';
    const result = await call(url, options);
    entry.observed = observation(result);
    const details = await validate(result);
    entry.observed = { ...entry.observed, ...details };
    return result.value;
  });
  try {
    assert(web && broker && knowledge, 'Web, broker and knowledge app configuration is required.');
    for (const app of [web, broker, knowledge]) {
      const url = new URL(app.url);
      assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'App URL must be a configured HTTPS origin.');
      assert(GUID.test(app.clientId || ''), 'Configured app managed identity client ID is required.');
    }
    assert(GUID.test(cfg.allowedUserOid || ''), 'Configured delegated analyst OID is required.');
    assert(GUID.test(cfg.authClientId || ''), 'Configured application audience is required.');
    const credential = new ManagedIdentityCredential({ clientId: web.clientId });
    const callerToken = (await credential.getToken(`api://${cfg.authClientId}/.default`, { abortSignal: AbortSignal.timeout(30000) }))?.token;
    assert(callerToken, 'A real web managed-identity token is required.');
    secrets.push(callerToken);
    const apiHeaders = { Authorization: `Bearer ${callerToken}`, 'x-fraud-user-oid': cfg.allowedUserOid, 'Content-Type': 'application/json' };
    const ready = app => record(null, `${app.role}-private-ready`, async entry => {
      for (let i = 0; i < READINESS_ATTEMPTS; i++) {
        const result = await call(`${app.url}/health/ready`, { headers: apiHeaders });
        entry.observed = { ...observation(result), attempts: i + 1 };
        if (result.status === 200) {
          assertHttp(result);
          assert(['ready', 'keyword-only'].includes(result.value.service?.status), 'Private service must report an actual ready dependency.');
          if (app.role === 'knowledge') {
            assert.equal(result.value.service.policySetVersion, POLICY_SNAPSHOT.policySetVersion, 'Private knowledge readiness must identify this policy release.');
            assert.equal(result.value.service.snapshotHash, POLICY_SNAPSHOT.snapshotHash, 'Private knowledge readiness must verify the complete matching index snapshot.');
            entry.observed.policySetVersion = result.value.service.policySetVersion;
            entry.observed.snapshotHash = result.value.service.snapshotHash;
          }
          return true;
        }
        assert(![401, 403, 429].includes(result.status), 'Private readiness rejected or rate-limited its managed-identity caller.');
        await delay(5000);
      }
      assert.fail('Private service did not become ready within the bounded retry window.');
    });
    const brokerReady = await ready(broker);
    const knowledgeReady = await ready(knowledge);
    assert(brokerReady && knowledgeReady, 'Matching private broker and policy knowledge readiness is required; no old-schema fallback is accepted.');
    await requestCheck(null, 'broker-unauthenticated-denied', `${broker.url}/v1/analytics/query`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      result => {
        assert([401, 403].includes(result.status), 'Unauthenticated broker request must be denied.');
        return { proves: 'Authentication rejection only, not invalid-input policy.' };
      });
    assert(cfg.publicDemoEnabled === true || (typeof userToken === 'string' && userToken.length > 0), 'A real delegated test-user token is required in private mode.');
    const headers = { ...(cfg.publicDemoEnabled === true ? {} : { Authorization: `Bearer ${userToken}` }), 'Content-Type': 'application/json' };
    const post = body => ({ method: 'POST', headers, body: JSON.stringify(body) });
    const status = await record(null, cfg.publicDemoEnabled === true ? 'anonymous-synthetic-real-dependency-status' : 'authenticated-real-dependency-status', async entry => {
      for (let i = 0; i < READINESS_ATTEMPTS; i++) {
        const result = await call(`${web.url}/api/status`, { headers });
        entry.observed = { ...observation(result), attempts: i + 1, capabilities: result.value?.capabilities, services: result.value?.services };
        assert(![401, 403, 429].includes(result.status), 'Status rejected or rate-limited the delegated analyst token.');
        if (result.status === 200) {
          assertHttp(result);
          assert.equal(result.value.synthetic, true, 'Status must explicitly identify synthetic data.');
          if (['guided', 'knowledge', 'naturalLanguage', 'evidence'].every(key => result.value.capabilities?.[key] === true)) {
            assert.equal(result.value.source?.type, 'azure-sql-database', 'Live status must identify the actual Azure SQL source type.');
            sameInstant(result.value.source?.asOf, SOURCE_AS_OF, 'Status source timestamp');
            assertText(result.value.model?.deployment, 'Live status model deployment');
            assertText(result.value.model?.version, 'Live status model version');
            assert(Array.isArray(result.value.limitations) && result.value.limitations.length > 0, 'Live status must expose its limitations.');
            return result.value;
          }
        }
        await delay(5000);
      }
      assert.fail('All four live capabilities did not become ready within the bounded retry window.');
    });
    if (!status) {
      for (const item of report.stories) blocked(item.id, 'live-readiness-required', 'Authenticated status did not establish all required live dependencies; no fallback was run.');
    } else {
      report.liveAzure = true;
      report.source = status.source;
      report.model = status.model;
      report.capabilities = status.capabilities;
      report.apiLimitations = status.limitations;
      const catalog = await requestCheck('FI-03', 'policy-snapshot-catalog', `${web.url}/api/policies`, { headers }, result => {
        assertHttp(result);
        const details = validatePolicyCatalog(result.value);
        report.policyRelease.catalog = details;
        return details;
      });
      assert(catalog, 'The complete current-ACL policy catalog and matching snapshot are required for this release.');
      await requestCheck(null, 'published-six-story-catalog', `${web.url}/api/user-stories`, { headers }, result => {
        assertHttp(result);
        assert(Array.isArray(result.value.stories), 'Deployed story catalog must contain its story array.');
        assert.deepEqual(result.value.stories.map(item => item.id).sort(), report.stories.map(item => item.id).sort(), 'Deployed catalog must contain FI-01 through FI-06 exactly once.');
        report.catalog = { version: result.value.version, storyIds: result.value.stories.map(item => item.id) };
        return report.catalog;
      });
      const scenarios = await requestCheck('FI-01', 'server-provided-guided-scenarios', `${web.url}/api/scenarios`, { headers }, result => {
        assertHttp(result);
        assert(Array.isArray(result.value) && result.value.length <= 20, 'Server scenarios must be a bounded array.');
        for (const expected of [LOSS_REQUEST, ruleRequest]) {
          const found = result.value.filter(item => item.request?.kind === expected.kind);
          assert.equal(found.length, 1, 'The required guided scenario must occur once.');
          assert.deepEqual(found[0].request, expected, 'Server scenario must use the expected exclusive calendar-month periods and channel grouping.');
        }
        return { scenarios: result.value.map(({ id, request }) => ({ id, request })) };
      });
      const analyze = (storyId, name, request, validator) => requestCheck(storyId, name, `${web.url}/api/analyze`, post(request), result => {
        validateProvenance(result.value, result, 'guided', undefined, request);
        return { request, answerId: result.value.answerId, provenance: result.value.provenance, ...validator(result.value) };
      });
      let loss, rule;
      if (scenarios) {
        loss = await analyze('FI-01', 'live-sql-period-comparison-and-citations', scenarios.find(item => item.request.kind === 'loss_comparison').request, validateLossAnswer);
        rule = await analyze('FI-02', 'live-rule-quality-and-denominator', scenarios.find(item => item.request.kind === 'rule_quality').request, validateRuleAnswer);
      } else {
        blocked('FI-01', 'guided-loss', 'Server-provided scenario contract failed.');
        blocked('FI-02', 'guided-rule-quality', 'Server-provided scenario contract failed.');
      }
      await requestCheck('FI-01', 'missing-month-is-no-data-not-zero', `${web.url}/api/analyze`, post({
        ...LOSS_REQUEST, current: { start: '2026-10-01', end: '2026-11-01' }, previous: LOSS_REQUEST.current,
      }), result => {
        assertApiError(result, 422, 'NO_DATA', /complete|missing/i);
        return { proves: 'Valid but unseeded October request produces NO_DATA, not a successful zero or sample answer.' };
      });

      const retrieve = (name, q, asOf, validate) => requestCheck('FI-03', name,
        `${web.url}/api/knowledge?${new URLSearchParams({ q, asOf })}`, { headers }, result => {
          assertHttp(result);
          const citations = validateCitations(result.value, asOf, { query: { q, asOf } });
          return { query: q, asOf, mode: result.value.mode, citations, sourceCount: citations.length, ...validate(result.value) };
        });
      for (const probe of POLICY_ACCEPTANCE_PROBES) {
        await requestCheck('FI-03', probe.check, `${web.url}/api/knowledge?${new URLSearchParams(probe.query)}`, { headers }, result => {
          assertHttp(result);
          return validatePolicyProbe(result.value, probe);
        });
      }
      await retrieve('pre-corpus-date-is-actually-empty', 'R017', '2026-06-30', value => {
        assert.equal(value.sources.length, 0, 'Before all seeded effective dates, the real retrieval result must be empty.');
        return { proves: 'Available no-applicable-policy result before all approved effective dates, not a dependency outage.' };
      });
      await retrieve('analyst-restricted-document-excluded', 'SYNTHETIC RESTRICTED DOCUMENT policy-owner-only appendix', '2026-09-30', value => {
        assert(value.sources.every(source => source.documentId !== 'synthetic-restricted-policy'), 'Default analyst must not retrieve the restricted seeded document.');
        return { assumedPrincipalRole: 'Default analyst, not PolicyOwner.' };
      });
      await retrieve('absent-lexical-term-retrieval-observed', ABSENT_TERM, '2026-09-30', value => {
        const observed = validateAbsentTerm(value);
        return observed;
      });

      const archive = async (name, answer, request, question) => {
        if (!answer) return blocked('FI-04', name, 'No validated successful answer exists for this evidence roundtrip.');
        const archived = await requestCheck('FI-04', name, `${web.url}${evidencePath(answer)}`, { headers }, result => {
          assertHttp(result);
          return validateEvidence(result.value, answer, request, cfg.allowedUserOid, question);
        });
        if (archived) report.acceptedAnswerIds.push(answer.answerId);
      };
      await archive('archived-answer-roundtrip', loss, LOSS_REQUEST);
      await archive('archived-rule-answer-roundtrip', rule, ruleRequest);

      for (const [name, request, message] of [
        ['unsupported-grouping', { ...LOSS_REQUEST, groupBy: 'customer' }, /unsupported.*(metric|grouping)/i],
        ['personal-data-projection-fields', { ...LOSS_REQUEST, select: ['email', 'accountNumber'] }, /documented request fields/i],
        ['write-intent-fields', { ...LOSS_REQUEST, operation: 'update', write: true }, /documented request fields/i],
        ['role-override-fields', { ...LOSS_REQUEST, roles: ['PolicyOwner'] }, /documented request fields/i],
        ['raw-sql-field', { ...LOSS_REQUEST, raw_sql: 'not-permitted' }, /documented request fields/i],
        ['unsupported-operation-kind', { ...LOSS_REQUEST, kind: 'update_rule' }, /unsupported.*(metric|grouping)/i],
      ]) {
        await requestCheck('FI-05', `invalid-request-${name}`, `${web.url}/api/analyze`, post(request), result => {
          assertInvalidRequest(result, message);
          return { request, proves: 'Exactly HTTP 400 + INVALID_REQUEST; backend pre-query proof remains unverified.' };
        });
      }
      if (report.stories.find(item => item.id === 'FI-05').observations.every(item => item.status === 'passed')) report.checks.push('live-write-projection-and-role-override-refusals');

      const natural = await requestCheck('FI-06', 'canadian-model-planning-with-live-governed-results', `${web.url}/api/ask`, post({ question: SUPPORTED_QUESTION }), result => {
        validateProvenance(result.value, result, 'natural-language', status.model.deployment, LOSS_REQUEST);
        const totals = validateLossAnswer(result.value);
        if (loss) {
          assert.deepEqual(result.value.metrics, loss.metrics, 'Natural-language and guided metric results must match.');
          assert.deepEqual(result.value.table, loss.table, 'Natural-language and guided table results must match.');
        } else report.stories.find(item => item.id === 'FI-06').unverifiedCriteria.push('Guided-versus-natural-language comparison was blocked because guided loss validation failed.');
        return { question: SUPPORTED_QUESTION, answerId: result.value.answerId, provenance: result.value.provenance, ...totals };
      });
      await archive('archived-natural-language-question-and-plan', natural, LOSS_REQUEST, SUPPORTED_QUESTION);
      await requestCheck('FI-06', 'unsupported-natural-language-question-refused', `${web.url}/api/ask`, post({ question: UNSUPPORTED_QUESTION }), result => {
        assertApiError(result, 422, 'UNSUPPORTED_QUESTION', /outside.*bounded|clarification|unsupported/i);
        return { question: UNSUPPORTED_QUESTION, proves: 'A benign out-of-domain question receives the planner refusal contract, not an authentication, input-filter, dependency or fallback success response.' };
      });
    }
  } catch (error) {
    report.failures.push({ storyId: null, check: 'acceptance-prerequisites', reason: failureReason(error) });
    for (const item of report.stories) if (!item.observations.length) blocked(item.id, 'acceptance-prerequisites', 'Live prerequisites failed; this story was not exercised.');
  }
  const completed = cleanObject(finalizeReport(report));
  const bytes = Buffer.from(JSON.stringify(completed, null, 2));
  assert(bytes.length <= 524288, 'Acceptance report exceeds its bounded payload budget.');
  fs.writeFileSync('cloud-acceptance.json', bytes);
  const adminCredential = new ManagedIdentityCredential({ clientId: cfg.bootstrap.clientId });
  const blob = new BlobServiceClient(cfg.storageUrl, adminCredential, { retryOptions: { maxTries: 2, tryTimeoutInMs: 10000 } })
    .getContainerClient('artifacts').getBlockBlobClient('acceptance/latest.json');
  await blob.uploadData(bytes, {
    abortSignal: AbortSignal.timeout(30000),
    blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
  });
  console.log(JSON.stringify({
    liveAzure: completed.liveAzure, checksPassed: completed.checks.length, allApiChecksPassed: completed.allApiChecksPassed,
    policyReleaseVerified: completed.policyReleaseVerified,
    allStoriesVerified: completed.allStoriesVerified, outcome: completed.outcome, report: 'artifacts/acceptance/latest.json',
  }));
  if (!completed.allApiChecksPassed) process.exitCode = 1;
  return completed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCloudAcceptance(JSON.parse(process.env.POC_CONFIG), process.env.POC_USER_TOKEN); }
  catch {
    console.error('Cloud acceptance could not complete or publish its private report. No success is recorded; inspect private telemetry without exposing tokens.');
    process.exitCode = 1;
  }
}
