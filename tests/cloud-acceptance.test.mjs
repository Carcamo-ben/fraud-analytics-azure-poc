import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ABSENT_TERM, SUPPORTED_QUESTION, UNSUPPORTED_QUESTION, LOSS_REQUEST,
  assertApiError, assertHttp, assertInvalidRequest, boundedResponseJson, createHttpCaller,
  createPacer, createReport, evidencePath, finalizeReport, validateAbsentTerm,
  validateCitations, validateEvidence, validateLossAnswer, validateProvenance, validateRuleAnswer, validateRuleRates,
  validatePolicyCatalog, validatePolicyProbe, validatePolicyResolution, POLICY_ACCEPTANCE_PROBES, MAX_ACCEPTANCE_REQUESTS,
} from '../deploy/cloud-acceptance.mjs';
import { citationsFromResults } from '../src/knowledge/search.mjs';
import { validateQuestion, MAX_BODY_BYTES, MAX_RESPONSE_BYTES } from '../src/validation.mjs';
import { documents, SOURCE_AS_OF } from '../seed/fixtures.mjs';
import { oid, secondOid, user, defaultQuery, resultFor } from './helpers.mjs';
import { POLICY_SNAPSHOT, resolvePolicies, resolveComparison, policyCatalog } from '../src/knowledge/policies.mjs';
import { createModel, plannerRequestSha256 } from '../src/model.mjs';

const plannerFixture = (await createModel({
  openaiEndpoint: 'https://synthetic-unit-test.example.invalid', chatDeployment: 'canadian-chat', modelVersion: 'configured-unit-test-version',
}, async () => ({
  id: 'chatcmpl-synthetic-unit-test', model: 'reported-unit-test-model-2026-09-01', created: 1792450800,
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ supported: true, request: defaultQuery, reason: 'approved' }) } }],
})).plan(SUPPORTED_QUESTION)).provenance;

const hash = value => createHash('sha256').update(value).digest('hex');
const evaluatedAt = '2026-10-20T03:00:00.000Z';
const lossQuery = { q: 'Net fraud loss KPI', asOf: '2026-09-30' };
const policyKey = item => `${item.policyId}|${item.version}`;
function knowledge(mode = 'hybrid', docs, { query = lossQuery, request, caller = user } = {}) {
  const policyResolution = request ? resolveComparison(POLICY_SNAPSHOT, caller, request, evaluatedAt)
    : resolvePolicies(POLICY_SNAPSHOT, caller, query, evaluatedAt);
  const resolved = new Set(policyResolution.decisions.filter(item => item.status === 'resolved').map(policyKey));
  const selected = docs ?? documents.filter(item => resolved.has(policyKey(item))).slice(0, 4);
  const sources = citationsFromResults(selected, caller, query.asOf, { resolution: policyResolution });
  const cited = new Set(sources.map(policyKey)).size;
  return { status: 'available', mode, sources, policyResolution,
    sourceCoverage: { allPolicyMetadataEvaluated: true, maxSources: 4, resolvedVersions: resolved.size,
      citedVersions: cited, omittedResolvedVersions: resolved.size - cited } };
}
const response = (value, status = 200) => ({ status, value, correlationId: oid, responseTraceId: oid });
const errorResponse = (status = 400, code = 'INVALID_REQUEST', message = 'Only the documented request fields are permitted.') =>
  response({ error: { code, message, traceId: oid } }, status);
function answerFor(request = defaultQuery, mode = 'guided') {
  const broker = resultFor(request);
  const context = knowledge('hybrid', undefined, { request });
  return {
    answerId: secondOid, synthetic: true, metrics: broker.metrics, table: broker.table, narrative: broker.narrative,
    knowledge: context,
    provenance: {
      sourceId: broker.sourceId, sourceAsOf: SOURCE_AS_OF, generatedAt: '2026-10-18T20:00:00.000Z',
      traceId: oid, metricVersion: broker.metricVersion, templateVersion: broker.templateVersion,
      brokerResponseSha256: hash(JSON.stringify(broker)),
      promptVersion: mode === 'guided' ? 'not-used-guided-v1' : 'planner-v1', mode,
      ...(mode === 'guided' ? {} : { modelDeployment: 'canadian-chat',
        plannerExecution: { ...plannerFixture, requestSha256: plannerRequestSha256(request) } }),
      policySetVersion: context.policyResolution.policySetVersion,
      policySnapshotHash: context.policyResolution.snapshotHash,
      policyEvaluatedAt: context.policyResolution.evaluatedAt,
    },
    evidenceUrl: `/api/evidence/${secondOid}`,
  };
}
function artifactFor(answer, request = defaultQuery, question) {
  const broker = resultFor(request);
  const resolution = answer.knowledge.policyResolution;
  return {
    schemaVersion: 'evidence-v1', subjectOid: oid, answer: structuredClone(answer), request: structuredClone(request),
    brokerEvidenceIds: broker.evidenceIds, suppressionPolicy: broker.suppressionPolicy,
    brokerReceipt: { schemaVersion: 'broker-receipt-v1', responseSha256: hash(JSON.stringify(broker)), response: structuredClone(broker) },
    policyEvaluation: { knowledgeStatus: 'available', periods: structuredClone({ previous: request.previous, current: request.current }),
      policySetVersion: resolution.policySetVersion, snapshotHash: resolution.snapshotHash, evaluatedAt: resolution.evaluatedAt,
      status: resolution.status, registry: resolution.registry },
    ...(question ? { questionSha256: hash(question) } : {}),
  };
}

test('broker receipt acceptance binds the actual payload even when returned and archived digest claims agree', () => {
  const answer = answerFor(), artifact = artifactFor(answer);
  assert.doesNotThrow(() => validateEvidence(artifact, answer, defaultQuery, oid));
  const reseal = item => {
    item.brokerReceipt.responseSha256 = hash(JSON.stringify(item.brokerReceipt.response));
    item.answer.provenance.brokerResponseSha256 = item.brokerReceipt.responseSha256;
  };
  for (const mutate of [
    item => { delete item.brokerReceipt; },
    item => { item.brokerReceipt.schemaVersion = 'old-receipt'; },
    item => { item.brokerReceipt.responseSha256 = '0'.repeat(64); item.answer.provenance.brokerResponseSha256 = '0'.repeat(64); },
    item => { item.brokerReceipt.response.metrics[0].value++; reseal(item); },
    item => { item.brokerReceipt.response.params.current.start = '2026-09-02'; reseal(item); },
    item => { item.brokerReceipt.response.evidenceIds = [`sql:${'0'.repeat(64)}`]; reseal(item); },
    item => { item.brokerReceipt.response.narrative.text = 'Not the displayed source narrative'; reseal(item); },
    item => { item.brokerReceipt.response.suppressionPolicy.threshold = 1; reseal(item); },
  ]) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.throws(() => validateEvidence(changed, structuredClone(changed.answer), defaultQuery, oid));
  }
});

test('acceptance helpers import without running Azure, and sample questions reach the bounded planner contract', () => {
  assert.deepEqual(LOSS_REQUEST, defaultQuery);
  assert.equal(validateQuestion(SUPPORTED_QUESTION), SUPPORTED_QUESTION);
  assert.equal(validateQuestion(UNSUPPORTED_QUESTION), UNSUPPORTED_QUESTION);
  assert.equal(validateQuestion(ABSENT_TERM), ABSENT_TERM);
});

test('FI-05 requires exactly 400 + INVALID_REQUEST, relevant text and the matching trace, never auth/outage/no-data', () => {
  assert.doesNotThrow(() => assertInvalidRequest(errorResponse(), /documented request fields/i));
  for (const status of [200, 401, 403, 413, 422, 429, 503]) {
    assert.throws(() => assertInvalidRequest(errorResponse(status), /documented/i));
  }
  for (const code of ['NO_DATA', 'COHORT_SUPPRESSED', 'DEPENDENCY_UNAVAILABLE', 'UNSUPPORTED_QUESTION', undefined]) {
    const result = errorResponse();
    result.value.error.code = code;
    assert.throws(() => assertInvalidRequest(result, /documented/i));
  }
  for (const message of ['', 'Service unavailable', null]) {
    assert.throws(() => assertInvalidRequest(errorResponse(400, 'INVALID_REQUEST', message), /documented/i));
  }
  const wrongTrace = errorResponse();
  wrongTrace.value.error.traceId = secondOid;
  assert.throws(() => assertInvalidRequest(wrongTrace, /documented/i));
  const fallback = errorResponse();
  fallback.value.metrics = [];
  assert.throws(() => assertInvalidRequest(fallback, /documented/i));
});

test('HTTP checks reject redirect/sign-in responses and missing or substituted correlation IDs', () => {
  assert.doesNotThrow(() => assertHttp(response({ ready: true })));
  for (const change of [
    { responseTraceId: null }, { responseTraceId: secondOid }, { correlationId: 'not-a-uuid' },
    { value: { nonJson: true } }, { status: 302 },
  ]) assert.throws(() => assertHttp({ ...response({}), ...change }));
});

test('FI-01 verifies all seeded channels, recalculated totals/deltas/percentages and CAD units', () => {
  const answer = answerFor();
  assert.equal(validateLossAnswer(answer).currentLossCad, 1240000);
  validateProvenance(answer, response(answer), 'guided');
  for (const mutate of [
    item => { item.table.rows.pop(); },
    item => { item.table.rows[0].currentLoss = null; },
    item => { item.table.rows[0].previousLoss = 0; },
    item => { item.table.rows[0].delta++; },
    item => { item.table.rows[0].deltaPercent++; },
    item => { item.table.rows[0].group = item.table.rows[1].group; },
    item => { item.metrics[0].value++; },
    item => { item.metrics[0].currency = 'USD'; },
    item => { item.table.columns.find(column => column.key === 'delta').currency = undefined; },
  ]) {
    const changed = structuredClone(answer);
    mutate(changed);
    assert.throws(() => validateLossAnswer(changed));
  }
  assert.doesNotThrow(() => assertApiError(errorResponse(422, 'NO_DATA', 'Missing complete periods; missing data is not zero.'), 422, 'NO_DATA', /missing/i));
});

test('FI-02 accepts real R017 IDs and verifies adjudicated FP shares and percentage-point changes', () => {
  const answer = answerFor({ ...defaultQuery, kind: 'rule_quality' });
  assert.equal(validateRuleAnswer(answer).shareChangePercentagePoints, 8);
  for (const mutate of [
    item => { item.table.rows[0].ruleId = 'R-017'; },
    item => { item.table.rows[0].currentAdjudicated++; },
    item => { item.table.rows[0].currentShare = 0; },
    item => { item.table.rows[0].shareChangePp = 11.76; },
    item => { item.metrics.find(metric => metric.key === 'fpShareChangePp').format = 'percent'; },
    item => { item.narrative.caveats = ['Population false-positive rate measured']; },
  ]) {
    const changed = structuredClone(answer);
    mutate(changed);
    assert.throws(() => validateRuleAnswer(changed));
  }
});

test('rate helper never treats a zero adjudicated denominator as measured zero', () => {
  const row = {
    currentAdjudicated: 0, currentFalsePositives: 0, currentShare: null,
    previousAdjudicated: 20, previousFalsePositives: 5, previousShare: 25, shareChangePp: null,
  };
  validateRuleRates(row);
  assert.throws(() => validateRuleRates({ ...row, currentShare: 0 }));
  assert.throws(() => validateRuleRates({ ...row, currentFalsePositives: 1 }));
  assert.throws(() => validateRuleRates({ ...row, shareChangePp: -25 }));
});

test('rate acceptance independently checks count-based percentage-point rounding', () => {
  const row = { currentAdjudicated: 3, currentFalsePositives: 1, currentShare: 33.33,
    previousAdjudicated: 6, previousFalsePositives: 1, previousShare: 16.67, shareChangePp: 16.67 };
  assert.doesNotThrow(() => validateRuleRates(row));
  assert.throws(() => validateRuleRates({ ...row, shareChangePp: 16.66 }));
});

test('FI-03 binds citations to actual seed metadata/content and excludes future and restricted documents', () => {
  const current = knowledge('hybrid', [documents[0], documents[4]], { query: { q: 'R017 dictionary', asOf: '2026-09-30' } });
  assert.equal(validateCitations(current, '2026-09-30').length, 2);
  assert.throws(() => validateCitations(current, '2026-09-01'), /requested as-of date/);
  for (const key of ['citationId', 'policyId', 'documentId', 'title', 'version', 'effectiveFrom', 'effectiveTo', 'chunkId', 'excerpt', 'appliesTo']) {
    const missing = structuredClone(current);
    delete missing.sources[0][key];
    assert.throws(() => validateCitations(missing, '2026-09-30'));
  }
  const restricted = knowledge('hybrid', [documents[5]], { caller: { ...user, roles: ['PolicyOwner'] },
    query: { q: 'Restricted governance', subject: 'restricted-governance', asOf: '2026-09-30' } });
  assert.throws(() => validateCitations(restricted, '2026-09-30'), /analyst-authorized/);
  const wrongChunk = structuredClone(current);
  wrongChunk.sources[0].excerpt = 'Pretend local fallback definition.';
  assert.throws(() => validateCitations(wrongChunk, '2026-09-30'), /identified seeded chunk/);
  assert.throws(() => validateCitations({ ...current, status: 'unavailable', sources: [] }, '2026-09-30'));
});

test('FI-03 unknown policy subjects are honestly unavailable for interpretation, not semantic governing substitutes', () => {
  const options = { query: { q: ABSENT_TERM, asOf: '2026-09-30' } };
  const empty = validateAbsentTerm(knowledge('hybrid', undefined, options));
  assert.equal(empty.emptyResultObserved, true);
  assert.match(empty.interpretation, /no-applicable-policy.*not an outage/);
  assert.equal(validateAbsentTerm(knowledge('keyword-only', undefined, options)).emptyResultObserved, true);
  assert.throws(() => validateAbsentTerm(knowledge('hybrid')));
  assert.throws(() => validateAbsentTerm(knowledge('keyword-only')));
  assert.throws(() => validateAbsentTerm({ status: 'unavailable', mode: 'hybrid', sources: [] }));
  assert.throws(() => validateAbsentTerm(knowledge('unknown')));
});

test('policy citations bind exact version/chunk identity and enforce exclusive effective-to boundaries', () => {
  const historical = { q: 'Net fraud loss KPI', subject: 'loss-kpi', asOf: '2026-08-31' };
  const current = { ...historical, asOf: '2026-09-01' };
  const oldResult = knowledge('hybrid', undefined, { query: historical });
  const newResult = knowledge('hybrid', undefined, { query: current });
  assert.equal(oldResult.sources[0].documentId, newResult.sources[0].documentId);
  assert.equal(validateCitations(oldResult, historical.asOf, { query: historical })[0].version, '4.0');
  assert.equal(validateCitations(newResult, current.asOf, { query: current })[0].version, '4.1');
  assert.equal(oldResult.sources[0].effectiveTo, '2026-09-01');
  const wrongTuple = structuredClone(oldResult);
  wrongTuple.sources[0].chunkId = newResult.sources[0].chunkId;
  assert.throws(() => validateCitations(wrongTuple, historical.asOf, { query: historical }), /exact seeded/);
  const expired = structuredClone(newResult);
  expired.sources = oldResult.sources;
  assert.throws(() => validateCitations(expired, current.asOf, { query: current }), /resolved version/);
  const forgedEnd = structuredClone(oldResult);
  forgedEnd.sources[0].effectiveTo = null;
  assert.throws(() => validateCitations(forgedEnd, historical.asOf, { query: historical }), /exclusive end/);
});

test('cross-period acceptance validates historical citations against their actual segments rather than September 30', () => {
  for (const request of [defaultQuery, { ...defaultQuery, kind: 'rule_quality' }]) {
    const answer = answerFor(request);
    validateProvenance(answer, response(answer), 'guided', undefined, request);
    const citations = validateCitations(answer.knowledge, undefined, { request, requireSources: true });
    assert(citations.some(source => source.appliesTo.some(item => item.period === 'previous')));
    validateEvidence(artifactFor(answer, request), answer, request, oid);
    for (const mutate of [
      value => { value.policyResolution.segments.pop(); },
      value => { value.policyResolution.decisions[0].start = '2026-09-01'; },
      value => { value.policyResolution.periods.previous.end = '2026-08-15'; },
      value => { value.sources[0].appliesTo[0].end = '2026-11-01'; },
      value => { value.sourceCoverage.omittedResolvedVersions++; },
    ]) {
      const altered = structuredClone(answer.knowledge);
      mutate(altered);
      assert.throws(() => validateCitations(altered, undefined, { request }));
    }
  }
  const answer = answerFor();
  const previousSource = answer.knowledge.sources.find(source => source.version === '4.0');
  assert.equal(previousSource.effectiveTo, '2026-09-01');
  assert(previousSource.appliesTo.every(item => item.period === 'previous'));
  assert.throws(() => validateCitations(answer.knowledge, '2026-09-30'), /actual typed request/);
});

test('new release catalog and resolution validators reject legacy readiness, incomplete metadata and restricted catalog leaks', () => {
  const catalog = policyCatalog(POLICY_SNAPSHOT, user, evaluatedAt);
  assert.equal(validatePolicyCatalog(catalog).snapshotHash, POLICY_SNAPSHOT.snapshotHash);
  for (const mutate of [
    value => { delete value.snapshotHash; },
    value => { value.policySetVersion = 'legacy-six-chunks'; },
    value => { value.policies.pop(); },
    value => { value.policies[0].content = 'A body must not be exposed by the metadata catalog'; },
    value => { value.policies[0].owner = 'Unapproved replacement owner'; },
    value => { value.policies.push(policyCatalog(POLICY_SNAPSHOT, { ...user, roles: ['PolicyOwner'] }, evaluatedAt).policies.find(item => item.policyId === 'restricted-governance')); },
  ]) {
    const altered = structuredClone(catalog);
    mutate(altered);
    assert.throws(() => validatePolicyCatalog(altered));
  }
  const legacy = knowledge();
  delete legacy.policyResolution;
  assert.throws(() => validateCitations(legacy, lossQuery.asOf), /synthetic manifest authority/);
  const leakedConflict = knowledge();
  leakedConflict.policyResolution.conflicts.push({ subject: 'restricted-governance', versions: [{ title: 'Restricted metadata must not leak' }] });
  assert.throws(() => validateCitations(leakedConflict, lossQuery.asOf), /Conflict metadata/);
  for (const mutate of [
    value => { value.snapshotHash = '0'.repeat(64); },
    value => { value.decisions[0].version = '4.0'; },
    value => { value.evaluatedAt = 'not-a-date'; },
    value => { value.conflicts.push({ subject: 'unrelated-conflict' }); },
  ]) {
    const altered = structuredClone(knowledge().policyResolution);
    mutate(altered);
    assert.throws(() => validatePolicyResolution(altered, { query: lossQuery }));
  }
});

test('every bounded policy acceptance scenario uses actual resolver outcomes, including historical R017 and scope-specific exclusions', () => {
  assert.equal(POLICY_ACCEPTANCE_PROBES.length, 10);
  for (const probe of POLICY_ACCEPTANCE_PROBES) {
    const result = knowledge('hybrid', undefined, { query: probe.query });
    const observed = validatePolicyProbe(result, probe);
    assert.equal(observed.status, probe.status);
    assert.deepEqual(observed.versions, [...probe.versions].sort());
  }
  const historical = POLICY_ACCEPTANCE_PROBES.find(item => item.check === 'policy-before-exclusive-boundary');
  const history = knowledge('hybrid', undefined, { query: historical.query });
  assert.equal(history.sources[0].documentId, 'synthetic-r017-change');
  assert.equal(history.sources[0].version, '2.2');
  const conflict = POLICY_ACCEPTANCE_PROBES.find(item => item.status === 'conflict');
  const ambiguous = knowledge('hybrid', undefined, { query: conflict.query });
  assert.deepEqual(ambiguous.policyResolution.conflicts[0].versions.map(item => item.version), ['1.0', '2.0']);
  const earlier = knowledge('hybrid', undefined, { query: { ...conflict.query, asOf: '2026-08-31' } });
  ambiguous.sources = earlier.sources;
  assert.throws(() => validatePolicyProbe(ambiguous, conflict), /resolved version/);
  const current = knowledge();
  for (const doc of documents.filter(item => item.approvalStatus === 'draft' || item.version === '3.0' && item.policyId === 'r017-rule')) {
    const altered = structuredClone(current);
    altered.sources[0] = { ...altered.sources[0], policyId: doc.policyId, documentId: doc.docId, title: doc.title,
      version: doc.version, effectiveFrom: doc.effectiveFrom.slice(0, 10), effectiveTo: doc.effectiveTo?.slice(0, 10) ?? null, chunkId: doc.chunkId };
    assert.throws(() => validateCitations(altered, lossQuery.asOf, { query: lossQuery }));
  }
});

test('FI-04 roundtrip preserves typed request, complete provenance, citations, SQL references and ownership', () => {
  const answer = answerFor();
  const artifact = artifactFor(answer);
  assert.equal(validateEvidence(artifact, answer, defaultQuery, oid).answerId, answer.answerId);
  for (const mutate of [
    item => { item.schemaVersion = undefined; },
    item => { item.subjectOid = secondOid; },
    item => { item.request = { ...defaultQuery, groupBy: 'province' }; },
    item => { item.answer.provenance.traceId = secondOid; },
    item => { delete item.answer.provenance.promptVersion; },
    item => { item.answer.knowledge.sources[0].chunkId = 'other-chunk'; },
    item => { item.brokerEvidenceIds = []; },
    item => { item.brokerEvidenceIds = ['pretend-sql-result']; },
    item => { item.suppressionPolicy.threshold = 0; },
  ]) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.throws(() => validateEvidence(changed, answer, defaultQuery, oid));
  }
  for (const evidenceUrl of ['https://outside.invalid/steal-token', '//outside.invalid/evidence', '/api/evidence/../status', `/api/evidence/${oid}`]) {
    assert.throws(() => evidencePath({ ...answer, evidenceUrl }));
  }
});

test('evidence acceptance requires actual policy snapshot outcomes and current analyst ACLs even if returned and archived copies agree', () => {
  const answer = answerFor();
  for (const mutate of [
    value => { delete value.policyEvaluation; },
    value => { value.policyEvaluation.snapshotHash = '0'.repeat(64); },
    value => { value.policyEvaluation.status = 'conflict'; },
    value => { value.policyEvaluation.evaluatedAt = '2026-10-19T00:00:00Z'; },
    value => { value.policyEvaluation.periods.previous.start = '2026-08-02'; },
  ]) {
    const artifact = artifactFor(answer);
    mutate(artifact);
    assert.throws(() => validateEvidence(artifact, answer, defaultQuery, oid));
  }
  const owner = { ...user, roles: ['PolicyOwner'] };
  const restricted = knowledge('hybrid', undefined, { caller: owner,
    query: { q: 'Restricted governance appendix', subject: 'restricted-governance', asOf: '2026-08-31' } });
  for (const mutate of [
    value => { value.knowledge.sources = restricted.sources; },
    value => { value.knowledge.policyResolution.decisions.push(restricted.policyResolution.decisions[0]); },
    value => { value.provenance.policySnapshotHash = '0'.repeat(64); },
  ]) {
    const altered = structuredClone(answer);
    mutate(altered);
    assert.throws(() => validateEvidence(artifactFor(altered), altered, defaultQuery, oid));
  }
});

test('provenance fails on missing fields even if both archived and returned copies are equally incomplete', () => {
  for (const key of ['sourceId', 'sourceAsOf', 'generatedAt', 'traceId', 'metricVersion', 'templateVersion', 'promptVersion',
    'policySetVersion', 'policySnapshotHash', 'policyEvaluatedAt']) {
    const answer = answerFor();
    delete answer.provenance[key];
    assert.throws(() => validateProvenance(answer, response(answer), 'guided'));
    assert.throws(() => validateEvidence(artifactFor(answer), answer, defaultQuery, oid));
  }
});

test('source acceptance rejects rolled-calendar aliases and equally incorrect archived source identity', () => {
  for (const sourceAsOf of ['2026-09-31T00:00:00Z', '2026-09-30T20:00:00-04:00', 'not-a-timestamp']) {
    const answer = answerFor();
    answer.provenance.sourceAsOf = sourceAsOf;
    assert.throws(() => validateProvenance(answer, response(answer), 'guided'));
    assert.throws(() => validateEvidence(artifactFor(answer), answer, defaultQuery, oid));
  }
  const wrongSource = answerFor();
  wrongSource.provenance.sourceId = 'different-synthetic-source';
  assert.throws(() => validateEvidence(artifactFor(wrongSource), wrongSource, defaultQuery, oid));
  const canonical = answerFor();
  canonical.provenance.sourceAsOf = '2026-10-01T00:00:00.000Z';
  assert.doesNotThrow(() => validateProvenance(canonical, response(canonical), 'guided'));
  assert.doesNotThrow(() => validateEvidence(artifactFor(canonical), canonical, defaultQuery, oid));
});

test('FI-06 requires real model-mode provenance and unchanged question hash; unrelated errors do not prove refusal', () => {
  const answer = answerFor(defaultQuery, 'natural-language');
  validateProvenance(answer, response(answer), 'natural-language', 'canadian-chat');
  const artifact = artifactFor(answer, defaultQuery, SUPPORTED_QUESTION);
  validateEvidence(artifact, answer, defaultQuery, oid, SUPPORTED_QUESTION);
  artifact.questionSha256 = hash(`${SUPPORTED_QUESTION} changed`);
  assert.throws(() => validateEvidence(artifact, answer, defaultQuery, oid, SUPPORTED_QUESTION));
  assert.throws(() => validateProvenance(answer, response(answer), 'guided'));
  assert.throws(() => validateProvenance(answer, response(answer), 'natural-language', 'different-deployment'));
  const refused = errorResponse(422, 'UNSUPPORTED_QUESTION', 'This question is outside the bounded aggregate analysis.');
  assertApiError(refused, 422, 'UNSUPPORTED_QUESTION', /outside.*bounded/);
  for (const [status, code] of [[400, 'UNSAFE_REQUEST'], [400, 'INVALID_REQUEST'], [403, 'FORBIDDEN'], [422, 'NO_DATA'], [503, 'DEPENDENCY_UNAVAILABLE']]) {
    assert.throws(() => assertApiError(errorResponse(status, code), 422, 'UNSUPPORTED_QUESTION', /outside.*bounded/));
  }
});

test('natural-language acceptance rejects equally incomplete or rebound completion metadata in both archived and returned answers', () => {
  for (const mutate of [
    (execution) => { delete execution.completionId; }, (execution) => { delete execution.reportedModel; },
    (execution) => { execution.promptSha256 = '0'.repeat(64); },
    (execution) => { execution.responseSchemaSha256 = '0'.repeat(64); },
    (execution) => { execution.requestSha256 = '0'.repeat(64); },
    (execution) => { execution.questionSha256 = '0'.repeat(64); },
  ]) {
    const answer = answerFor(defaultQuery, 'natural-language');
    mutate(answer.provenance.plannerExecution);
    const artifact = artifactFor(answer, defaultQuery, SUPPORTED_QUESTION);
    assert.throws(() => validateEvidence(artifact, answer, defaultQuery, oid, SUPPORTED_QUESTION));
  }
  const answer = answerFor(defaultQuery, 'natural-language');
  delete answer.provenance.plannerExecution;
  assert.throws(() => validateProvenance(answer, response(answer), 'natural-language', 'canadian-chat'));
  assert.throws(() => validateEvidence(artifactFor(answer, defaultQuery, SUPPORTED_QUESTION), answer, defaultQuery, oid, SUPPORTED_QUESTION));
});

test('bounded JSON rejects declared or streamed oversized payloads and never parses a sign-in page', async () => {
  assert.deepEqual(await boundedResponseJson(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })), { ok: true });
  assert.deepEqual(await boundedResponseJson(new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })), { nonJson: true });
  await assert.rejects(boundedResponseJson(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } })), /byte budget/);
  await assert.rejects(boundedResponseJson(new Response(JSON.stringify({ content: 'x'.repeat(MAX_RESPONSE_BYTES) }), { headers: { 'content-type': 'application/json' } })), /byte budget/);
  await assert.rejects(boundedResponseJson(new Response('not-json', { headers: { 'content-type': 'application/json' } })));
});

test('HTTP caller uses fresh correlation IDs, manual redirects, bounded bodies and pacing', async () => {
  let calls = 0, paced = 0;
  const call = createHttpCaller({
    pace: async () => { paced++; },
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      assert(options.signal instanceof AbortSignal);
      assert.equal(paced, calls);
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'x-correlation-id': options.headers['x-correlation-id'] } });
    },
  });
  const first = await call('https://web.example.invalid/api/status');
  const second = await call('https://web.example.invalid/api/status');
  assertHttp(first); assertHttp(second);
  assert.notEqual(first.correlationId, second.correlationId);
  await assert.rejects(call('https://web.example.invalid/api/analyze', { body: 'x'.repeat(MAX_BODY_BYTES + 1) }), /byte budget/);
  assert.equal(calls, 2);
});

test('acceptance request cap prevents further network starts, including concurrent attempts', async () => {
  let calls = 0;
  const call = createHttpCaller({ maxRequests: 2, pace: async () => {},
    fetchImpl: async (_url, options) => {
      calls++;
      return new Response('{}', { headers: { 'content-type': 'application/json', 'x-correlation-id': options.headers['x-correlation-id'] } });
    } });
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => call('https://web.example.invalid/api/status')));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
  assert.match(results.find(item => item.status === 'rejected').reason.message, /request cap/);
  assert.equal(calls, 2);
  assert.throws(() => createHttpCaller({ maxRequests: MAX_ACCEPTANCE_REQUESTS + 1 }), /cap must be bounded/);
});

test('pacing includes concurrent starts and stays below authenticated and public-demo rolling-minute limits', async () => {
  let now = 0;
  const starts = [];
  const pace = createPacer({ clock: () => now, sleep: async ms => { now += ms; } });
  await Promise.all(Array.from({ length: 45 }, async () => { await pace(); starts.push(now); }));
  for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 6000);
  for (const start of starts) assert(starts.filter(time => time >= start && time < start + 60000).length < 12);
});

test('reports enumerate all six stories without claiming browser, pre-query, residency or retention proof', () => {
  const report = createReport();
  assert.deepEqual(report.stories.map(item => item.id), ['FI-01', 'FI-02', 'FI-03', 'FI-04', 'FI-05', 'FI-06']);
  report.liveAzure = true;
  for (const story of report.stories) story.observations.push({ check: `${story.id}-example`, status: 'passed' });
  finalizeReport(report);
  assert.equal(report.allApiChecksPassed, false, 'Legacy story checks alone cannot accept the new policy release.');
  report.checks.push(...report.policyRelease.requiredChecks);
  finalizeReport(report);
  assert.equal(report.allApiChecksPassed, true);
  assert.equal(report.policyReleaseVerified, true);
  assert.equal(report.allStoriesVerified, false);
  assert.equal(report.outcome, 'partial');
  assert(report.stories.every(story => story.status === 'partial'));
  const notLive = finalizeReport({ ...structuredClone(report), liveAzure: false });
  assert.equal(notLive.allApiChecksPassed, false);
  assert.match(report.stories.find(story => story.id === 'FI-05').unverifiedCriteria.join(' '), /zero database reads\/writes.*HTTP 400 alone cannot prove/);
  assert.match(report.stories.find(story => story.id === 'FI-06').unverifiedCriteria.join(' '), /Canada residency.*telemetry/);
  assert.match(report.stories.find(story => story.id === 'FI-04').unverifiedCriteria.join(' '), /retention duration/);
  assert.match(report.stories.find(story => story.id === 'FI-04').unverifiedCriteria.join(' '), /revocation.*historical evidence/);
  report.stories[0].observations[0].status = 'failed';
  report.failures.push({ check: 'live-failure' });
  finalizeReport(report);
  assert.equal(report.allApiChecksPassed, false);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.stories[0].status, 'failed');
  const blocked = finalizeReport(createReport());
  assert.equal(blocked.allApiChecksPassed, false);
  assert(blocked.stories.every(story => story.status === 'blocked'));
  const missingGate = createReport();
  missingGate.liveAzure = true;
  missingGate.stories.forEach(story => story.observations.push({ check: 'fixture-only', status: 'passed' }));
  missingGate.policyRelease.requiredChecks = [];
  finalizeReport(missingGate);
  assert.equal(missingGate.policyReleaseVerified, false, 'A changed report requirement list cannot bypass the fixed release gates.');
});
