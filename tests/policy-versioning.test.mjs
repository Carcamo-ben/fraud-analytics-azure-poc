import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPolicyManifest } from '../src/knowledge/policy-manifest.mjs';
import { POLICY_SNAPSHOT, createPolicySnapshot, resolvePolicies, resolveComparison, policyCatalog } from '../src/knowledge/policies.mjs';
import { createKnowledge, citationsFromResults, validateIndexInventory, SEARCH_METADATA_FIELDS } from '../src/knowledge/search.mjs';
import { policyIndexDefinition } from '../src/knowledge/search-schema.mjs';
import { createWebServices } from '../src/web/services.mjs';
import { createApplication } from '../src/app.mjs';
import { validateKnowledgeQuery, MAX_RESPONSE_BYTES } from '../src/validation.mjs';
import { AppError, unavailable } from '../src/errors.mjs';
import { ingestPolicyIndex } from '../seed/ingest.mjs';
import { config, user, oid, defaultQuery, resultFor, listening } from './helpers.mjs';

const evaluatedAt = '2026-10-20T03:00:00.000Z';
const now = () => new Date(evaluatedAt);
const query = (subject, asOf = '2026-09-30', extra = {}) => ({ q: 'Fictional policy context', subject, asOf, ...extra });
const resolve = (subject, asOf, extra = {}, snapshot = POLICY_SNAPSHOT, caller = user) => resolvePolicies(snapshot, caller, query(subject, asOf, extra), evaluatedAt);
const changed = (edit) => { const input = structuredClone(syntheticPolicyManifest); edit(input); return createPolicySnapshot(input); };
const byVersion = (input, policyId, version) => input.policies.find((item) => item.policyId === policyId && item.version === version);
const inventoryFor = (snapshot) => ({ '@odata.count': snapshot.documents.length, value: snapshot.documents.map((doc) => Object.fromEntries(SEARCH_METADATA_FIELDS.map((field) => [field, doc[field]]))) });

function knowledgeFor(snapshot = POLICY_SNAPSHOT, overrides = {}) {
  const calls = [], embeds = [];
  const http = async (_url, options) => {
    calls.push(options.body);
    if (options.body.count) return overrides.inventory ? overrides.inventory(inventoryFor(snapshot)) : inventoryFor(snapshot);
    if (overrides.results) return { value: overrides.results(snapshot.documents, options.body) };
    const ids = options.body.filter.match(/search\.in\(chunkId, '([^']+)', ','\)/)?.[1].split(',');
    assert.ok(ids?.length, 'Top-K is constrained to resolved authoritative chunk IDs');
    return { value: snapshot.documents.filter((doc) => ids.includes(doc.chunkId)).slice(0, options.body.top) };
  };
  const knowledge = createKnowledge({ ...config, knowledgeMode: overrides.mode ?? 'keyword-only',
    searchEndpoint: 'https://synthetic.example.invalid', searchIndex: overrides.indexName ?? snapshot.indexName }, http,
  { embed: async (q) => { embeds.push(q); return [1, 0]; } }, { snapshot, now: overrides.now ?? now });
  return { knowledge, calls, embeds };
}

test('synthetic policy history is bounded, immutable and shared by runtime and index schema', () => {
  assert.equal(POLICY_SNAPSHOT.documents.length, 16);
  assert.match(POLICY_SNAPSHOT.indexName, /^fraud-policy-[a-f0-9]{16}$/);
  assert.ok(Object.isFrozen(POLICY_SNAPSHOT.policies[0].chunks[0]));
  const fields = policyIndexDefinition(POLICY_SNAPSHOT, 'hybrid', 1536).fields;
  for (const field of [...SEARCH_METADATA_FIELDS, 'content']) assert.ok(fields.some((item) => item.name === field), field);
  assert.ok(fields.find((item) => item.name === 'effectiveTo').filterable);
  assert.ok(fields.find((item) => item.name === 'policySetVersion').filterable);
  assert.equal(fields.find((item) => item.name === 'contentVector').retrievable, false);
  assert.throws(() => policyIndexDefinition(POLICY_SNAPSHOT, 'silent-fallback', 1536));
});

test('historical and current approved versions use effective dates, never later archival publication', () => {
  const old = resolve('loss-kpi', '2026-08-31');
  const current = resolve('loss-kpi', '2026-09-01');
  assert.equal(old.status, 'resolved');
  assert.equal(old.decisions[0].version, '4.0');
  assert.equal(current.decisions[0].version, '4.1');
  assert.ok(old.decisions[0].publishedAt > current.decisions[0].publishedAt);
  assert.equal(old.evaluatedAt, evaluatedAt);
  assert.equal(old.policySetVersion, POLICY_SNAPSHOT.policySetVersion);
  assert.equal(old.snapshotHash, POLICY_SNAPSHOT.snapshotHash);
  assert.deepEqual(resolve('loss-kpi', '2026-08-31'), old);
});

test('exclusive effective-to boundaries exclude expired, future, draft and not-yet-published records', () => {
  assert.equal(resolve('r017-rule', '2026-09-11').decisions[0].version, '2.2');
  assert.equal(resolve('r017-rule', '2026-09-12').decisions[0].version, '2.3');
  assert.equal(resolve('expired-demo', '2026-08-31').status, 'resolved');
  assert.equal(resolve('expired-demo', '2026-09-01').status, 'no-applicable-policy');
  assert.equal(resolve('loss-kpi', '2026-06-30').status, 'no-applicable-policy');
  assert.deepEqual(resolve('r017-rule', '2026-09-19').decisions.map((item) => item.version), ['2.3']);
  const unpublished = changed((input) => {
    byVersion(input, 'net-loss-kpi', '4.1').publishedAt = '2027-01-01T00:00:00Z';
  });
  assert.equal(resolve('loss-kpi', '2026-09-30', {}, unpublished).status, 'no-applicable-policy');
});

test('same-scope overlaps require explicit approved precedence, regardless of publication order', () => {
  const snapshot = changed((input) => {
    byVersion(input, 'net-loss-kpi', '4.0').effectiveTo = null;
    byVersion(input, 'net-loss-kpi', '4.1').supersedes = [];
  });
  const result = resolve('loss-kpi', '2026-09-30', {}, snapshot);
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].versions.length, 2);
  assert.ok(result.decisions.every((item) => !item.version));
  const approved = changed((input) => { byVersion(input, 'net-loss-kpi', '4.0').effectiveTo = null; });
  assert.equal(resolve('loss-kpi', '2026-09-30', {}, approved).decisions[0].version, '4.1');
});

test('policy decision and conflict references preserve the exact approval instant used for eligibility', () => {
  const comparison = resolveComparison(POLICY_SNAPSHOT, user, defaultQuery, evaluatedAt);
  const references = [
    ...resolve('loss-kpi', '2026-08-31').decisions,
    ...resolve('r017-rule', '2026-09-22', { province: 'QC' }).decisions,
    ...resolve('overlap-demo', '2026-09-15').conflicts.flatMap(item => item.versions),
    ...comparison.decisions,
    ...comparison.segments.flatMap(segment => segment.decisions),
  ];
  assert.ok(references.length >= 8);
  for (const ref of references) {
    const policy = POLICY_SNAPSHOT.policies.find(item => item.policyId === ref.policyId && item.version === ref.version);
    assert.equal(ref.approvedAt, policy.approvedAt);
    assert.equal(ref.publishedAt, policy.publishedAt);
    assert.ok(Date.parse(ref.approvedAt) <= Date.parse(evaluatedAt));
  }
});

test('scoped exceptions are approved supersession, not automatic specificity; broad scopes partition', () => {
  assert.equal(resolve('r017-rule', '2026-09-22', { province: 'QC' }).decisions[0].version, '2.4-qc');
  assert.equal(resolve('r017-rule', '2026-09-22', { province: 'ON' }).decisions[0].version, '2.3');
  const broad = resolve('r017-rule', '2026-09-22');
  assert.equal(broad.status, 'resolved');
  assert.deepEqual(broad.decisions.map((item) => [item.scope.province, item.version]), [['*', '2.3'], ['QC', '2.4-qc']]);
  assert.deepEqual(broad.decisions[0].scope.excludedProvinces, ['QC']);
  const ambiguous = changed((input) => { byVersion(input, 'r017-rule', '2.4-qc').supersedes = []; });
  const result = resolve('r017-rule', '2026-09-22', {}, ambiguous);
  assert.equal(result.status, 'conflict');
  assert.equal(result.decisions[0].status, 'resolved');
  assert.equal(result.conflicts[0].scope.province, 'QC');
  assert.equal(resolve('r017-rule', '2026-10-01', { province: 'QC' }).decisions[0].version, '2.3');
});

test('current authorization controls every historical version and metadata-only catalog', () => {
  const catalog = policyCatalog(POLICY_SNAPSHOT, user, evaluatedAt);
  const text = JSON.stringify(catalog);
  assert.doesNotMatch(text, /restricted-governance|restricted policy-owner|owner-only historical|SYNTHETIC RESTRICTED|allowedRoles|chunks|content/);
  assert.ok(catalog.scenarios.some((item) => item.id === 'overlap'));
  assert.equal(resolve('restricted-governance', '2026-08-31').status, 'no-applicable-policy');
  const owner = { ...user, roles: ['analyst', 'PolicyOwner'] };
  assert.equal(resolve('restricted-governance', '2026-08-31', {}, POLICY_SNAPSHOT, owner).status, 'resolved');
  assert.ok(policyCatalog(POLICY_SNAPSHOT, owner, evaluatedAt).scenarios.some((item) => item.id === 'restricted'));
  const revoked = changed((input) => { input.access.find((item) => item.policyId === 'r017-rule').allowedRoles = ['PolicyOwner']; });
  assert.equal(resolve('r017-rule', '2026-08-31', {}, revoked).status, 'no-applicable-policy');
  assert.ok(!policyCatalog(revoked, user, evaluatedAt).policies.some((item) => item.policyId === 'r017-rule'));
  assert.throws(() => citationsFromResults([revoked.documents[7]], user, '2026-08-31', { snapshot: revoked }), { status: 503 });
  assert.throws(() => policyCatalog(POLICY_SNAPSHOT, { ...user, businessUnit: 'another-unit' }), { status: 503 });
});

test('malformed dates, metadata budgets, unknown references, unapproved and invalid scoped supersession fail closed', () => {
  for (const mutate of [
    (input) => { input.policies[0].effectiveTo = '2026-09-12'; },
    (input) => { input.policies[0].effectiveFrom = '2026-02-30'; },
    (input) => { input.policies[0].publishedAt = '2026-09-31T00:00:00Z'; },
    (input) => { input.policies[0].approvalStatus = 'maybe-approved'; },
    (input) => { input.policies[0].owner = 'x'.repeat(121); },
    (input) => { input.policies[0].title = 'x'.repeat(181); },
    (input) => { input.policies[0].version = 'x'.repeat(31); },
    (input) => { input.policies[0].chunks[0].chunkId = 'x'.repeat(101); },
    (input) => { input.policies[0].chunks[0].content = 'x'.repeat(4001); },
    (input) => { input.access[0].allowedRoles = ['untrusted-role']; },
    (input) => { input.policies.push(structuredClone(input.policies[0])); },
    (input) => { input.policies[0].supersedes = [{ policyId: 'r017-rule', version: 'missing' }]; },
    (input) => { input.policies[12].supersedes = [{ policyId: 'r017-rule', version: '2.2' }]; },
    (input) => { input.policies[0].supersedes = [{ policyId: 'r017-dictionary', version: '2.2' }]; },
    (input) => { input.policies[0].scope.subject = 'loss-kpi'; },
    (input) => { input.policies[0].scope.province = 'outside-scope'; },
    (input) => { input.policies[7].scope.province = 'QC'; },
  ]) assert.throws(() => changed(mutate), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.throws(() => changed((input) => {
    const old = byVersion(input, 'net-loss-kpi', '4.0'), next = byVersion(input, 'net-loss-kpi', '4.1');
    next.effectiveFrom = old.effectiveFrom;
    old.supersedes = [{ policyId: 'net-loss-kpi', version: '4.1' }];
  }), { code: 'DEPENDENCY_UNAVAILABLE' });
});

test('bounded complete index inventory detects missing, mixed, duplicate and unauthorized metadata', () => {
  assert.doesNotThrow(() => validateIndexInventory(inventoryFor(POLICY_SNAPSHOT)));
  for (const mutate of [
    (result) => { result.value.pop(); },
    (result) => { result['@odata.count']++; },
    (result) => { result.value[1] = result.value[0]; },
    (result) => { result.value[0].policySetVersion = 'old-snapshot'; },
    (result) => { result.value[0].snapshotHash = '0'.repeat(64); },
    (result) => { result.value[0].effectiveTo = '2026-09-30T00:00:00Z'; },
    (result) => { result.value[5].allowedRoles = ['analyst']; },
    (result) => { result['@odata.nextLink'] = 'next-page'; },
    (result) => { result['@search.nextPageParameters'] = {}; },
    (result) => { delete result.value[0].approvalStatus; },
  ]) {
    const result = structuredClone(inventoryFor(POLICY_SNAPSHOT));
    mutate(result);
    assert.throws(() => validateIndexInventory(result), { status: 503 });
  }
});

test('partial or inactive snapshots never reach relevance, embedding or metadata catalog output', async () => {
  const partial = knowledgeFor(POLICY_SNAPSHOT, { mode: 'hybrid', inventory: (result) => ({ ...result, value: result.value.slice(0, 4) }) });
  await assert.rejects(partial.knowledge.retrieve(query('loss-kpi'), user), { status: 503 });
  await assert.rejects(partial.knowledge.catalog(user), { status: 503 });
  await assert.rejects(partial.knowledge.probe(), { status: 503 });
  assert.equal(partial.calls.length, 3);
  assert.equal(partial.embeds.length, 0);
  const legacy = knowledgeFor(POLICY_SNAPSHOT, { indexName: 'fraud-knowledge-v1' });
  await assert.rejects(legacy.knowledge.retrieve(query('loss-kpi'), user), { status: 503 });
  assert.equal(legacy.calls.length, 0);
});

test('ingestion creates a new immutable-name index only and verifies completeness before reporting activation readiness', async () => {
  const calls = [];
  let polls = 0, waits = 0;
  const http = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'PUT') return {};
    if (url.includes('/docs/index?')) return { value: options.body.value.map((item) => ({ key: item.chunkId, status: true })) };
    polls++;
    return polls === 1 ? { '@odata.count': 0, value: [] } : inventoryFor(POLICY_SNAPSHOT);
  };
  const config = { endpoint: 'https://synthetic.search.windows.net', mode: 'keyword-only' };
  const report = await ingestPolicyIndex(config, http, {}, { wait: async () => { waits++; } });
  assert.equal(calls[0].headers['if-none-match'], '*');
  assert.ok(calls.every((item) => item.url.includes(POLICY_SNAPSHOT.indexName)));
  assert.equal(waits, 1);
  assert.match(report.activation, /Not activated.*Retain the old index/);
  assert.equal(report.snapshotHash, POLICY_SNAPSHOT.snapshotHash);
  await assert.rejects(ingestPolicyIndex({ ...config, indexName: 'fraud-knowledge-v1' }, async () => assert.fail('Do not mutate old index'), {}));
  await assert.rejects(ingestPolicyIndex({ ...config, mode: 'hybrid' }, async () => assert.fail('Embedding failure must not create an empty index'),
    { embed: async () => { throw unavailable('Embedding'); } }), { status: 503 });
  let failures = 0;
  await assert.rejects(ingestPolicyIndex(config, async (url, options) => {
    if (options.method === 'PUT') return {};
    if (url.includes('/docs/index?')) return { value: options.body.value.map((item) => ({ key: item.chunkId, status: true })) };
    failures++;
    return { '@odata.count': 0, value: [] };
  }, {}, { wait: async () => {} }), { status: 503 });
  assert.equal(failures, 5);
});

test('authoritative conflicts outside top-K are detected without asking relevance or the model to pick', async () => {
  const { knowledge, calls, embeds } = knowledgeFor(POLICY_SNAPSHOT, { mode: 'hybrid', results: () => assert.fail('Conflict must never select governing excerpts') });
  assert.ok(POLICY_SNAPSHOT.documents.findIndex((doc) => doc.policyId === 'overlap-demo' && doc.version === '2.0') > 4);
  const result = await knowledge.retrieve(query('overlap-demo', '2026-09-15'), user);
  assert.equal(result.status, 'available');
  assert.equal(result.policyResolution.status, 'conflict');
  assert.equal(result.policyResolution.conflicts[0].versions.length, 2);
  assert.deepEqual(result.sources, []);
  assert.equal(calls.length, 1);
  assert.equal(embeds.length, 0);
  assert.equal(calls[0].count, true);
  assert.ok(!calls[0].select.split(',').includes('content'));
});

test('loss context is not poisoned by unrelated overlaps; unrecognized queries do not infer policy subject', async () => {
  const { knowledge } = knowledgeFor();
  const loss = await knowledge.retrieve({ q: 'Net fraud loss KPI', asOf: '2026-09-30' }, user);
  assert.equal(loss.policyResolution.status, 'resolved');
  assert.ok(loss.sources.every((item) => item.policyId === 'net-loss-kpi'));
  const unknown = await knowledge.retrieve({ q: 'not-in-the-fictional-corpus', asOf: '2026-09-30' }, user);
  assert.equal(unknown.policyResolution.status, 'no-applicable-policy');
  assert.deepEqual(unknown.sources, []);
  assert.throws(() => validateKnowledgeQuery({ ...query('loss-kpi'), roles: ['PolicyOwner'] }), { status: 400 });
  assert.throws(() => validateKnowledgeQuery({ ...query('loss-kpi'), province: "QC' or true" }), { status: 400 });
});

test('cross-period analysis partitions actual boundaries and preserves metadata for versions beyond four excerpts', async () => {
  const { knowledge, calls } = knowledgeFor();
  const loss = await knowledge.compare(defaultQuery, user);
  assert.deepEqual(loss.policyResolution.segments.map((item) => [item.period, item.start, item.end, item.decisions[0].version]), [
    ['previous', '2026-08-01', '2026-09-01', '4.0'], ['current', '2026-09-01', '2026-10-01', '4.1'],
  ]);
  assert.equal(loss.sources.length, 2);
  assert.ok(loss.sources.find((item) => item.version === '4.0').appliesTo.every((item) => item.period === 'previous'));
  const rules = await knowledge.compare({ ...defaultQuery, kind: 'rule_quality' }, user);
  const segments = rules.policyResolution.segments;
  assert.deepEqual(segments.map((item) => [item.period, item.start, item.end]), [
    ['previous', '2026-08-01', '2026-08-15'], ['previous', '2026-08-15', '2026-09-01'],
    ['current', '2026-09-01', '2026-09-12'], ['current', '2026-09-12', '2026-09-20'], ['current', '2026-09-20', '2026-10-01'],
  ]);
  assert.equal(segments[0].decisions.find((item) => item.subject === 'r017-rule').version, '2.2');
  assert.equal(segments[3].decisions.find((item) => item.subject === 'r017-rule').version, '2.3');
  assert.ok(segments[4].decisions.some((item) => item.version === '2.4-qc' && item.scope.province === 'QC'));
  assert.equal(rules.policyResolution.status, 'resolved');
  assert.equal(rules.sources.length, 4);
  assert.ok(rules.sourceCoverage.omittedResolvedVersions > 0);
  assert.ok(calls.filter((body) => !body.count).every((body) => !body.filter.includes('effectiveFrom le')));
  assert.ok(Buffer.byteLength(JSON.stringify(rules)) < MAX_RESPONSE_BYTES);
});

test('expiry inside a reporting period produces an explicit uncovered segment, never carrying a prior version forward', async () => {
  const snapshot = changed((input) => { byVersion(input, 'net-loss-kpi', '4.1').effectiveTo = '2026-09-15'; });
  const { knowledge } = knowledgeFor(snapshot);
  const result = await knowledge.compare(defaultQuery, user);
  assert.equal(result.policyResolution.status, 'no-applicable-policy');
  const gap = result.policyResolution.segments.at(-1);
  assert.equal(gap.start, '2026-09-15');
  assert.equal(gap.end, '2026-10-01');
  assert.equal(gap.status, 'no-applicable-policy');
  assert.ok(gap.decisions.every((item) => !item.version));
  assert.ok(result.sources.every((source) => source.appliesTo.every((item) => item.end <= '2026-09-15')));
  const web = createWebServices(config, { evidence: { put: async () => {} }, model: {}, now, policySnapshot: snapshot,
    call: async (_base, path) => path === '/v1/analytics/query' ? resultFor() : result });
  const answer = await web.analyze(defaultQuery, user);
  assert.deepEqual(answer.metrics, resultFor().metrics);
  assert.match(answer.narrative.caveats.join(' '), /No old or future version was substituted/);
});

test('citation metadata, content integrity, current ACLs, eligibility and excerpt limits are revalidated', async () => {
  const snapshot = changed((input) => { input.policies.forEach((item) => { item.chunks[0].content = 'x'.repeat(4000); }); });
  const { knowledge } = knowledgeFor(snapshot);
  const result = await knowledge.compare({ ...defaultQuery, kind: 'rule_quality' }, user);
  assert.equal(result.sources.length, 4);
  assert.equal(result.sources.reduce((total, item) => total + item.excerpt.length, 0), 4000);
  assert.ok(result.sources.every((item) => item.excerpt.length <= 1100 && item.policyId && 'effectiveTo' in item));
  for (const mutate of [
    (doc) => { doc.title = 'x'.repeat(181); },
    (doc) => { doc.content = 'tampered text'; },
    (doc) => { doc.contentSha256 = '0'.repeat(64); },
    (doc) => { doc.allowedRoles = ['PolicyOwner']; },
    (doc) => { doc.policyId = 'another-policy'; },
    (doc) => { delete doc.effectiveTo; },
  ]) {
    const doc = structuredClone(POLICY_SNAPSHOT.documents[1]);
    mutate(doc);
    assert.throws(() => citationsFromResults([doc], user, '2026-09-30'), { status: 503 });
  }
  for (const position of [5, 11, 12, 14, 15]) {
    assert.throws(() => citationsFromResults([POLICY_SNAPSHOT.documents[position]], user, '2026-09-30'), { status: 503 });
  }
  const invalidResult = knowledgeFor(POLICY_SNAPSHOT, { results: (docs) => [docs[0]] });
  await assert.rejects(invalidResult.knowledge.retrieve(query('loss-kpi'), user), { status: 503 });
});

test('policy conflicts preserve broker facts, withhold interpretation, and persist immutable snapshot evidence before return', async () => {
  const snapshot = changed((input) => {
    byVersion(input, 'net-loss-kpi', '4.0').effectiveTo = null;
    byVersion(input, 'net-loss-kpi', '4.1').supersedes = [];
  });
  const { knowledge } = knowledgeFor(snapshot);
  let saved;
  const evidence = { put: async (_user, _id, artifact) => {
    assert.ok(Object.isFrozen(artifact));
    assert.ok(Object.isFrozen(artifact.answer.knowledge.policyResolution.decisions));
    saved = structuredClone(artifact);
  } };
  const web = createWebServices(config, { evidence, model: {}, now, policySnapshot: snapshot,
    call: async (_base, path, context) => path === '/v1/analytics/query' ? resultFor(context.body) : knowledge.compare(context.body, user) });
  const answer = await web.analyze(defaultQuery, user, { traceId: oid });
  assert.deepEqual(answer.metrics, resultFor().metrics);
  assert.deepEqual(answer.table, resultFor().table);
  assert.equal(answer.knowledge.policyResolution.status, 'conflict');
  assert.match(answer.narrative.caveats.join(' '), /interpretation is withheld.*numerical metrics are preserved/);
  assert.equal(saved.policyEvaluation.snapshotHash, snapshot.snapshotHash);
  assert.equal(saved.policyEvaluation.policySetVersion, snapshot.policySetVersion);
  assert.equal(saved.policyEvaluation.evaluatedAt, evaluatedAt);
  assert.ok(saved.answer.knowledge.policyResolution.conflicts.every(conflict =>
    conflict.versions.every(version => typeof version.approvedAt === 'string')));
  assert.deepEqual(saved.answer, answer);
  assert.deepEqual(saved.request, defaultQuery);
  assert.ok(answer.knowledge.sources.every((source) => source.appliesTo.every((segment) => segment.period === 'previous')));
  evidence.put = async () => { throw unavailable('Evidence storage'); };
  await assert.rejects(web.analyze(defaultQuery, user), { status: 503 });
});

test('missing period-specific policy contract fails safe without replacing broker metrics or fabricating snapshot evidence', async () => {
  let saved;
  const web = createWebServices(config, {
    evidence: { put: async (_user, _id, artifact) => { saved = artifact; } }, model: {}, now,
    call: async (_base, path) => path === '/v1/analytics/query' ? resultFor() : { status: 'available', sources: [] },
  });

  const answer = await web.analyze(defaultQuery, user);
  assert.deepEqual(answer.metrics, resultFor().metrics);
  assert.equal(answer.knowledge.status, 'unavailable');
  assert.deepEqual(answer.knowledge.sources, []);
  assert.equal(saved.policyEvaluation.reasonCode, 'POLICY_CONTEXT_UNAVAILABLE');
  assert.equal(saved.policyEvaluation.snapshotHash, undefined);
});

test('private policy drift cannot become trusted context or evidence despite a matching snapshot label', async () => {
  for (const mutate of [
    (result) => { result.policyResolution.snapshotHash = '0'.repeat(64); },
    (result) => { result.policyResolution.segments.pop(); },
    (result) => { result.policyResolution.segments[0].end = '2026-08-20'; },
    (result) => { result.policyResolution.decisions = []; },
    (result) => { result.policyResolution.segments[0].decisions = []; },
    (result) => { result.policyResolution.decisions[0].version = '9.0-draft'; },
    (result) => { delete result.policyResolution.decisions[0].approvedAt; },
    (result) => { result.policyResolution.decisions[0].approvedAt = '2027-01-01T00:00:00Z'; },
    (result) => { result.sources[0].excerpt = 'Invented policy instruction'; },
    (result) => { result.sources[0].appliesTo[0].period = 'previous'; },
    (result) => { result.sources.push(result.sources[0]); },
    (result) => { result.sources[0].policyId = 'restricted-governance'; },
    (result) => { result.sourceCoverage.omittedResolvedVersions++; },
    (result) => { delete result.sourceCoverage; },
  ]) {
    const { knowledge } = knowledgeFor();
    const result = await knowledge.compare(defaultQuery, user);
    mutate(result);
    let saved;
    const web = createWebServices(config, { evidence: { put: async (_user, _id, artifact) => { saved = artifact; } }, model: {}, now,
      call: async (_base, path) => path === '/v1/analytics/query' ? resultFor() : result });
    const answer = await web.analyze(defaultQuery, user);
    assert.equal(answer.knowledge.status, 'unavailable');
    assert.deepEqual(answer.knowledge.sources, []);
    assert.deepEqual(answer.metrics, resultFor().metrics);
    assert.deepEqual(answer.table, resultFor().table);
    assert.deepEqual(saved.answer, answer);
    assert.equal(saved.policyEvaluation.reasonCode, 'POLICY_CONTEXT_UNAVAILABLE');
    assert.equal(saved.policyEvaluation.snapshotHash, undefined);
  }
});

test('web policy search and catalog revalidate current ACLs, complete resolutions and snapshot identity', async () => {
  const { knowledge } = knowledgeFor();
  const scopedQuery = query('r017-rule', '2026-09-22', { province: 'QC' });
  const validSearch = await knowledge.retrieve(scopedQuery, user);
  const validCatalog = await knowledge.catalog(user);
  let response = validSearch;
  const web = createWebServices(config, { evidence: {}, model: {}, now, call: async () => response });
  assert.deepEqual(await web.knowledge(scopedQuery, user), validSearch);
  for (const mutate of [
    (result) => { result.policyResolution.asOf = '2026-09-19'; },
    (result) => { result.policyResolution.decisions[0].scope.province = 'ON'; },
    (result) => { result.sources[0].version = '2.3'; },
    (result) => { result.policyResolution.decisions = []; },
    (result) => { result.sourceCoverage.allPolicyMetadataEvaluated = false; },
  ]) {
    response = structuredClone(validSearch);
    mutate(response);
    await assert.rejects(web.knowledge(scopedQuery, user), { status: 503 });
  }
  response = validCatalog;
  assert.deepEqual(await web.policies(user), validCatalog);
  for (const mutate of [
    (result) => { result.snapshotHash = '0'.repeat(64); },
    (result) => { result.policies.pop(); },
    (result) => { result.policies.push(policyCatalog(POLICY_SNAPSHOT, { ...user, roles: ['PolicyOwner'] }, evaluatedAt).policies.find((item) => item.policyId === 'restricted-governance')); },
  ]) {
    response = structuredClone(validCatalog);
    mutate(response);
    await assert.rejects(web.policies(user), { status: 503 });
  }
});

test('web comparison revalidation preserves legitimate conflicts and prevents suppressed conflicts from passing', async () => {
  const snapshot = changed((input) => {
    byVersion(input, 'net-loss-kpi', '4.0').effectiveTo = null;
    byVersion(input, 'net-loss-kpi', '4.1').supersedes = [];
  });
  const { knowledge } = knowledgeFor(snapshot);
  const valid = await knowledge.compare(defaultQuery, user);
  let response = valid;
  const web = createWebServices(config, { evidence: { put: async () => {} }, model: {}, now, policySnapshot: snapshot,
    call: async (_base, path) => path === '/v1/analytics/query' ? resultFor() : response });
  assert.equal((await web.analyze(defaultQuery, user)).knowledge.policyResolution.status, 'conflict');
  response = structuredClone(valid);
  response.policyResolution.status = 'resolved';
  response.policyResolution.conflicts = [];
  assert.equal((await web.analyze(defaultQuery, user)).knowledge.status, 'unavailable');
});

test('fresh private policy evaluations cannot replay an earlier cutoff to suppress a newly known conflict', async () => {
  const snapshot = changed((input) => {
    byVersion(input, 'net-loss-kpi', '4.0').effectiveTo = null;
    const current = byVersion(input, 'net-loss-kpi', '4.1');
    current.supersedes = [];
    current.publishedAt = '2026-10-20T02:59:30Z';
    current.approvedAt = '2026-10-20T02:59:30Z';
  });
  const scopedQuery = query('loss-kpi');
  assert.equal(resolvePolicies(snapshot, user, scopedQuery, evaluatedAt).status, 'conflict');
  for (const offset of [-60000, 60000]) {
    const remote = knowledgeFor(snapshot, { now: () => new Date(Date.parse(evaluatedAt) + offset) }).knowledge;
    const replay = await remote.retrieve(scopedQuery, user);
    if (offset < 0) {
      assert.equal(replay.policyResolution.status, 'resolved');
      assert.equal(replay.policyResolution.decisions[0].version, '4.0');
    }
    let saved;
    const web = createWebServices(config, { model: {}, now, policySnapshot: snapshot,
      evidence: { put: async (_user, _id, artifact) => { saved = artifact; } },
      call: async (_base, route, context) => {
        if (route === '/v1/analytics/query') return resultFor(context.body);
        if (route === '/v1/knowledge/search') return remote.retrieve(context.body, user);
        if (route === '/v1/knowledge/policies') return remote.catalog(user);
        return remote.compare(context.body, user);
      } });
    await assert.rejects(web.knowledge(scopedQuery, user), { status: 503 });
    await assert.rejects(web.policies(user), { status: 503 });
    const answer = await web.analyze(defaultQuery, user);
    assert.equal(answer.knowledge.status, 'unavailable');
    assert.deepEqual(answer.knowledge.sources, []);
    assert.deepEqual(answer.metrics, resultFor().metrics);
    assert.deepEqual(saved.answer, answer);
    assert.equal(saved.policyEvaluation.snapshotHash, undefined);
    assert.equal(saved.policyEvaluation.reasonCode, 'POLICY_CONTEXT_UNAVAILABLE');
  }
});

test('live policy evaluation windows allow bounded clock skew and real request duration, not stale or rolled timestamps', async () => {
  const scopedQuery = query('loss-kpi');
  let response, clock = Date.parse(evaluatedAt), duration = 0;
  const web = createWebServices(config, { evidence: {}, model: {}, now: () => new Date(clock),
    call: async () => { clock += duration; return response; } });
  for (const offset of [-5000, 5000, -5001, 5001]) {
    clock = Date.parse(evaluatedAt);
    const remote = knowledgeFor(POLICY_SNAPSHOT, { now: () => new Date(clock + offset) }).knowledge;
    response = await remote.retrieve(scopedQuery, user);
    if (Math.abs(offset) <= 5000) assert.deepEqual(await web.knowledge(scopedQuery, user), response);
    else await assert.rejects(web.knowledge(scopedQuery, user), { status: 503 });
  }
  clock = Date.parse(evaluatedAt);
  duration = 20000;
  response = await knowledgeFor().knowledge.retrieve(scopedQuery, user);
  assert.deepEqual(await web.knowledge(scopedQuery, user), response, 'Evaluation at request start remains valid when transport takes twenty seconds.');
  duration = 0;
  response.policyResolution.evaluatedAt = '2026-09-31T03:00:00.000Z';
  clock = Date.parse('2026-10-01T03:00:00.000Z');
  await assert.rejects(web.knowledge(scopedQuery, user), { status: 503 });
  response = await knowledgeFor().knowledge.retrieve(scopedQuery, user);
  clock = Date.parse(evaluatedAt);
  duration = -1;
  await assert.rejects(web.knowledge(scopedQuery, user), { status: 503 }, 'A rolled-back exchange clock is not a trustworthy freshness window.');
});

test('authorized read-only catalog and private comparison routes enforce scope without new write endpoints', async () => {
  const { knowledge } = knowledgeFor();
  const privateApp = createApplication({ ...config, role: 'knowledge' }, { authenticate: async () => user, knowledge });
  await listening(privateApp, async (base) => {
    const catalog = await (await fetch(`${base}/v1/knowledge/policies`)).json();
    assert.equal(catalog.registry, 'synthetic-policy-manifest');
    assert.doesNotMatch(JSON.stringify(catalog), /restricted-governance|chunks/);
    assert.equal((await fetch(`${base}/v1/knowledge/policies?roles=PolicyOwner`)).status, 400);
    assert.equal((await fetch(`${base}/v1/knowledge/policies`, { method: 'POST' })).status, 404);
    const response = await fetch(`${base}/v1/knowledge/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).policyResolution.segments.length, 2);
    assert.equal((await fetch(`${base}/api/policies`)).status, 404);
  });
  let forwardedUser;
  const web = createWebServices(config, { model: {}, evidence: {}, now, call: async (_base, path, context) => {
    assert.equal(path, '/v1/knowledge/policies'); forwardedUser = context.user;
    return knowledge.catalog(context.user);
  } });
  const publicApp = createApplication(config, { authenticate: async () => user, web });
  await listening(publicApp, async (base) => {
    assert.equal((await fetch(`${base}/api/policies`)).status, 200);
    assert.equal(forwardedUser, user);
    assert.equal((await fetch(`${base}/api/policies?asOf=2026-08-01`)).status, 400);
    assert.equal((await fetch(`${base}/api/policies`, { method: 'POST' })).status, 404);
  });
  const denied = createApplication(config, { authenticate: async () => { throw new AppError(401, 'UNAUTHENTICATED', 'Verified identity required.'); } });
  await listening(denied, async (base) => { assert.equal((await fetch(`${base}/api/policies`)).status, 401); });
});
