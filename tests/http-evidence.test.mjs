import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApplication, createRateLimiter } from '../src/app.mjs';
import { createWebServices, createServiceCaller } from '../src/web/services.mjs';
import { createEvidence } from '../src/evidence.mjs';
import { createModel } from '../src/model.mjs';
import { calculate } from '../src/broker/metrics.mjs';
import { AppError, unavailable } from '../src/errors.mjs';
import { config, user, oid, secondOid, callerOid, defaultQuery, fixtureRows, resultFor, listening } from './helpers.mjs';
import { documents } from '../seed/fixtures.mjs';
import { citationsFromResults } from '../src/knowledge/search.mjs';
import { POLICY_SNAPSHOT, resolveComparison, resolvePolicies, policyCatalog } from '../src/knowledge/policies.mjs';
import { MAX_RESPONSE_BYTES } from '../src/validation.mjs';

function memoryContainer() {
  const contents = new Map();
  return {
    contents,
    getProperties: async () => ({}),
    getBlockBlobClient: (name) => ({
      upload: async (value, length, options) => {
        assert.equal(Buffer.byteLength(value), length);
        assert.equal(options.conditions.ifNoneMatch, '*');
        if (contents.has(name)) throw new Error('Evidence cannot overwrite');
        contents.set(name, value);
      },
    }),
    getBlobClient: (name) => ({
      download: async () => {
        if (!contents.has(name)) throw Object.assign(new Error('Not found'), { statusCode: 404 });
        const content = Buffer.from(contents.get(name));
        return { contentLength: content.length, readableStreamBody: Readable.from([content]) };
      },
    }),
  };
}

function webDeps(overrides = {}) {
  const container = memoryContainer();
  const evidence = createEvidence({}, undefined, { container });
  const policyContext = (resolution) => {
    const key = (item) => `${item.policyId}|${item.version}`;
    const resolved = new Set(resolution.decisions.filter((item) => item.status === 'resolved').map(key));
    const sources = citationsFromResults(documents.filter((doc) => resolved.has(key(doc))).slice(0, 4), user, resolution.asOf, { resolution });
    const cited = new Set(sources.map(key));
    return { status: 'available', mode: 'hybrid', sources, policyResolution: resolution,
      sourceCoverage: { allPolicyMetadataEvaluated: true, maxSources: 4, resolvedVersions: resolved.size,
        citedVersions: cited.size, omittedResolvedVersions: resolved.size - cited.size } };
  };
  const call = async (_base, route, context) => {
    if (route === '/health/ready') return { service: { status: 'ready' } };
    if (route === '/v1/analytics/query') return resultFor(context.body);
    if (route === '/v1/knowledge/compare') {
      return policyContext(resolveComparison(POLICY_SNAPSHOT, user, context.body));
    }
    if (route === '/v1/knowledge/policies') return policyCatalog(POLICY_SNAPSHOT, user);
    if (route === '/v1/knowledge/search') return policyContext(resolvePolicies(POLICY_SNAPSHOT, user, context.body));
    assert.fail(`Unexpected internal route: ${route}`);
  };
  const model = createModel({ ...config, openaiEndpoint: 'https://unit-test-model.example.invalid' }, async (_url, options) => ({
    id: 'chatcmpl-synthetic-unit-test', model: 'unit-test-model-2026-09-01', created: 1792450800, system_fingerprint: 'fp_synthetic',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(options.body.response_format.type === 'json_schema'
      ? { supported: true, request: defaultQuery, reason: 'approved' } : { ready: true }) } }],
  }));
  return { call, model, evidence, container, ...overrides };
}

test('guided and natural-language routes preserve deterministic numbers, citations and actual rendered evidence', async () => {
  const dependencies = webDeps();
  let plannerCalls = 0;
  const plan = dependencies.model.plan;
  dependencies.model.plan = async (...args) => { plannerCalls++; return plan(...args); };
  const web = createWebServices(config, dependencies);
  const app = createApplication(config, { authenticate: async () => user, web });
  await listening(app, async (base) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.synthetic, true);
    assert.equal(status.capabilities.naturalLanguage, true);
    assert.equal(status.source.type, 'azure-sql-database');
    assert.equal(status.services.broker.status, 'ready');
    const scenarios = await (await fetch(`${base}/api/scenarios`)).json();
    assert.equal(scenarios.length, 2);
    const analyzeResponse = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery) });
    assert.equal(analyzeResponse.status, 200);
    const answer = await analyzeResponse.json();
    assert.deepEqual(Object.keys(answer).sort(), ['answerId', 'synthetic', 'metrics', 'table', 'narrative', 'knowledge', 'provenance', 'evidenceUrl'].sort());
    assert.equal(answer.provenance.mode, 'guided');
    assert.equal(answer.provenance.plannerExecution, undefined);
    assert.equal(answer.metrics.find((m) => m.key === 'lossChangePercent').value, 24);
    assert.equal(plannerCalls, 0);
    assert.equal(answer.knowledge.sources[0].documentId, 'synthetic-net-loss-kpi');
    const artifact = await (await fetch(`${base}${answer.evidenceUrl}`)).json();
    assert.deepEqual(artifact.answer, answer);
    assert.deepEqual(artifact.request, defaultQuery);
    assert.ok(artifact.brokerEvidenceIds[0].startsWith('sql:'));
    const askResponse = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Compare monthly fraud loss by channel' }) });
    assert.equal(askResponse.status, 200);
    const natural = await askResponse.json();
    assert.equal(natural.provenance.mode, 'natural-language');
    assert.equal(natural.provenance.modelDeployment, config.chatDeployment);
    assert.equal(natural.provenance.plannerExecution.reportedModel, 'unit-test-model-2026-09-01');
    assert.equal(natural.provenance.plannerExecution.configuredModelVersion, 'test');
    const naturalArtifact = await (await fetch(`${base}${natural.evidenceUrl}`)).json();
    assert.deepEqual(naturalArtifact.answer, natural);
    assert.equal(naturalArtifact.questionSha256, natural.provenance.plannerExecution.questionSha256);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(natural.metrics, answer.metrics);
    const contextual = await (await fetch(`${base}/api/knowledge?q=R017&asOf=2026-09-30`)).json();
    assert.equal(contextual.status, 'available');
  });
});

test('broker receipt preserves the complete approved response before web caveats and binds its exact object hash', async () => {
  const sample = fixtureRows()[0];
  const rows = Array.from({ length: 50 }, (_, index) => ['current', 'previous'].map(period => ({
    ...sample, group: `Group-${index}-`.padEnd(80, 'x'), period, loss: index + (period === 'current' ? 10 : 5),
  }))).flat();
  for (const broker of [resultFor(), calculate(defaultQuery, rows, { sourceAsOf: config.sourceAsOf, traceId: oid })]) {
    const dependencies = webDeps();
    const realCall = dependencies.call, put = dependencies.evidence.put;
    dependencies.call = async (base, route, context) => route === '/v1/analytics/query' ? broker : realCall(base, route, context);
    dependencies.evidence.put = async (...args) => {
      assert.ok(args[2].brokerReceipt, 'The exact approved broker payload must be archived.');
      assert.ok(Object.isFrozen(args[2].brokerReceipt));
      assert.ok(Object.isFrozen(args[2].brokerReceipt.response.narrative));
      return put(...args);
    };
    const answer = await createWebServices(config, dependencies).analyze(defaultQuery, user, { traceId: oid });
    const artifact = await dependencies.evidence.get(user, answer.answerId);
    assert.equal(artifact.brokerReceipt.schemaVersion, 'broker-receipt-v1');
    assert.deepEqual(artifact.brokerReceipt.response, broker);
    const digest = createHash('sha256').update(JSON.stringify(broker)).digest('hex');
    assert.equal(artifact.brokerReceipt.responseSha256, digest);
    assert.equal(answer.provenance.brokerResponseSha256, digest);
    assert.deepEqual(artifact.brokerReceipt.response.metrics, answer.metrics);
    assert.deepEqual(artifact.brokerReceipt.response.table, answer.table);
    assert.ok(answer.narrative.caveats.length > artifact.brokerReceipt.response.narrative.caveats.length);
    assert.deepEqual(artifact.answer, answer);
    assert.ok(Buffer.byteLength(JSON.stringify(artifact)) <= MAX_RESPONSE_BYTES, 'Even the bounded fifty-row receipt fits the existing evidence cap.');
  }
  const dependencies = webDeps(), call = dependencies.call;
  const oversized = resultFor();
  oversized.narrative.text = 'x'.repeat(66000);
  let writes = 0;
  dependencies.call = async (base, route, context) => route === '/v1/analytics/query' ? oversized : call(base, route, context);
  dependencies.evidence = { put: async () => { writes++; } };
  await assert.rejects(createWebServices(config, dependencies).analyze(defaultQuery, user, { traceId: oid }), { status: 503 });
  assert.equal(writes, 0, 'A complete over-budget receipt must fail before persistence, not degrade to a partial snapshot.');
});

test('missing or mismatched planner execution evidence stops before any broker query or evidence write', async () => {
  const question = 'Compare monthly fraud losses by channel';
  const dependencies = webDeps();
  const valid = await dependencies.model.plan(question);
  let queries = 0, writes = 0;
  for (const mutate of [
    (value) => { delete value.provenance; },
    (value) => { value.provenance.questionSha256 = '0'.repeat(64); },
    (value) => { value.request.groupBy = 'province'; },
    (value) => { value.provenance.configuredModelVersion = 'fabricated-version'; },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    const web = createWebServices(config, { model: { plan: async () => value },
      call: async () => { queries++; return resultFor(); }, evidence: { put: async () => { writes++; } } });
    await assert.rejects(web.ask(question, user, { traceId: oid }), { status: 503 });
  }
  assert.equal(queries, 0);
  assert.equal(writes, 0);
});

test('evidence is stored under the caller OID and cannot be read by another allowlisted user', async () => {
  const dependencies = webDeps();
  const web = createWebServices(config, dependencies);
  const answer = await web.analyze(defaultQuery, user, { traceId: oid });
  const same = await dependencies.evidence.get(user, answer.answerId);
  assert.deepEqual(same.answer, answer);
  await assert.rejects(dependencies.evidence.get({ ...user, oid: secondOid }, answer.answerId), { status: 404 });
  await assert.rejects(dependencies.evidence.get(user, '../another-user'), { status: 404 });
  assert.equal(dependencies.container.contents.size, 1);
});

test('evidence identifiers use GUID case equivalence without rewriting historical payloads or crossing owners', async () => {
  const container = memoryContainer();
  const evidence = createEvidence({}, undefined, { container });
  const reader = { ...user, oid: 'abcdef12-abcd-4abc-8abc-abcdefabcdef' };
  const writer = { ...reader, oid: reader.oid.toUpperCase() };
  const id = 'deadbeef-abcd-4abc-8def-abcdefabcdef';
  await evidence.put(writer, id.toUpperCase(), { answer: { answerId: id.toUpperCase(), knowledge: { sources: [] } } });
  const key = `${reader.oid}/${id}.json`, original = container.contents.get(key);
  const app = createApplication(config, { authenticate: async () => reader, web: { evidence } });
  await listening(app, async base => {
    for (const variant of [id, id.toUpperCase()]) {
      const response = await fetch(`${base}/api/evidence/${variant}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), JSON.parse(original));
    }
  });
  assert.deepEqual(await evidence.get(writer, id), JSON.parse(original));
  await assert.rejects(evidence.get({ ...reader, oid: secondOid }, id.toUpperCase()), { status: 404 });
  for (const invalid of [[id], { id }, 123, undefined, '../another-user']) {
    await assert.rejects(evidence.get(reader, invalid), { status: 404 });
  }
  await assert.rejects(evidence.get({ ...reader, oid: [reader.oid] }, id), { status: 404 });
  assert.equal(container.contents.get(key), original);
  for (const tamper of [
    value => { value.subjectOid = secondOid; },
    value => { value.answer.answerId = secondOid; },
    value => { value.subjectOid = [reader.oid]; },
  ]) {
    const value = JSON.parse(original);
    tamper(value);
    container.contents.set(key, JSON.stringify(value));
    await assert.rejects(evidence.get(reader, id), { status: 503 });
  }
});

test('case-normalized evidence identifiers still enforce current policy ACL revocation', async () => {
  const container = memoryContainer();
  const evidence = createEvidence({}, undefined, { container });
  const reader = { ...user, oid: 'abcdef12-abcd-4abc-8abc-abcdefabcdef' };
  const owner = { ...reader, oid: reader.oid.toUpperCase(), roles: ['analyst', 'PolicyOwner'] };
  const id = 'deadbeef-abcd-4abc-8def-abcdefabcdef';
  const restricted = citationsFromResults([documents[5]], owner, '2026-08-31');
  await evidence.put(owner, id.toUpperCase(), { answer: { answerId: id.toUpperCase(), knowledge: { sources: restricted } } });
  const original = [...container.contents.values()][0];
  for (const variant of [id, id.toUpperCase()]) {
    await assert.rejects(evidence.get(reader, variant), { status: 403, code: 'EVIDENCE_SCOPE_FORBIDDEN' });
    assert.deepEqual(await evidence.get({ ...owner, oid: reader.oid }, variant), JSON.parse(original));
  }
  assert.equal([...container.contents.values()][0], original);
});

test('historical evidence stays immutable but current ACL revocation withholds restricted content and metadata', async () => {
  const container = memoryContainer();
  const evidence = createEvidence({}, undefined, { container });
  const owner = { ...user, roles: ['analyst', 'PolicyOwner'] };
  const restricted = citationsFromResults([documents[5]], owner, '2026-08-31');
  await evidence.put(owner, oid, { answer: { answerId: oid, knowledge: { sources: restricted } } });
  const before = [...container.contents.values()][0];
  assert.equal((await evidence.get(owner, oid)).answer.knowledge.sources.length, 1);
  await assert.rejects(evidence.get(user, oid), { status: 403, code: 'EVIDENCE_SCOPE_FORBIDDEN' });
  assert.equal([...container.contents.values()][0], before);
  const legacy = structuredClone(restricted);
  delete legacy[0].policyId;
  await evidence.put(owner, secondOid, { answer: { answerId: secondOid, knowledge: { sources: legacy } } });
  await assert.rejects(evidence.get(user, secondOid), { status: 403 });
});

test('model outage disables natural language but not guided SQL; no fabricated knowledge or silent evidence failure', async () => {
  const dependencies = webDeps();
  dependencies.model = { plan: async () => { throw unavailable('model'); }, probe: async () => { throw unavailable('model'); } };
  const originalCall = dependencies.call;
  dependencies.call = async (base, route, context) => {
    if (['/v1/knowledge/search', '/v1/knowledge/compare'].includes(route) || (route === '/health/ready' && base === config.knowledgeUrl)) throw unavailable('knowledge');
    return originalCall(base, route, context);
  };
  const web = createWebServices(config, dependencies);
  const status = await web.status(user);
  assert.equal(status.capabilities.guided, true);
  assert.equal(status.capabilities.naturalLanguage, false);
  assert.equal(status.services.model.status, 'unavailable');
  const answer = await web.analyze(defaultQuery, user, { traceId: oid });
  assert.equal(answer.knowledge.status, 'unavailable');
  assert.deepEqual(answer.knowledge.sources, []);
  await assert.rejects(web.ask('Compare monthly fraud loss', user, { traceId: oid }), { status: 503 });
  dependencies.evidence.put = async () => { throw unavailable('evidence'); };
  await assert.rejects(web.analyze(defaultQuery, user, { traceId: oid }), { status: 503 });
});

test('server rejects unsafe payloads, authenticates readiness, enforces role boundaries and hides dependency errors', async () => {
  let queries = 0, probes = 0;
  const broker = createApplication({ ...config, role: 'broker' }, {
    authenticate: async () => user,
    sql: {
      analytics: async () => { queries++; throw new Error('secret SQL connection database host hidden'); },
      probe: async () => { probes++; return { status: 'ready' }; },
    },
  });
  await listening(broker, async (base) => {
    let response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal(probes, 1);
    for (const body of [{ ...defaultQuery, raw_sql: 'SELECT * FROM private' }, { ...defaultQuery, roles: ['PolicyOwner'] }]) {
      response = await fetch(`${base}/v1/analytics/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(queries, 0);
    response = await fetch(`${base}/v1/analytics/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery) });
    assert.equal(response.status, 503);
    const errorText = await response.text();
    assert.doesNotMatch(errorText, /secret SQL|database host/);
    assert.equal(JSON.parse(errorText).error.code, 'DEPENDENCY_UNAVAILABLE');
    response = await fetch(`${base}/v1/analytics/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'x'.repeat(9000) }) });
    assert.equal(response.status, 413);
    response = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404);
  });
  const closed = createApplication({ ...config, role: 'broker' }, {
    authenticate: async () => { throw new AppError(401, 'UNAUTHENTICATED', 'Verified identity required.'); },
    sql: { probe: async () => assert.fail('Unauthenticated readiness must not probe data') },
  });
  await listening(closed, async (base) => {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 401);
    assert.equal((await fetch(`${base}/v1/analytics/query`)).status, 401);
  });
});

test('server cancellation reaches SQL and broker results have metric provenance', async () => {
  const success = createApplication({ ...config, role: 'broker' }, {
    authenticate: async () => user,
    sql: { analytics: async (query) => fixtureRows(query) },
  });
  await listening(success, async (base) => {
    const response = await fetch(`${base}/v1/analytics/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.metricVersion, 'fraud-metrics-1.2.1');
    assert.equal(body.params.groupBy, 'channel');
    assert.ok(body.traceId);
    assert.equal(body.evidenceIds.length, 1);
  });
  let cancelled = false;
  const timeout = createApplication({ ...config, role: 'broker', requestTimeoutMs: 30 }, {
    authenticate: async () => user,
    sql: { analytics: async (_query, _user, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled = true; reject(unavailable('SQL timeout')); }, { once: true });
    }) },
  });
  await listening(timeout, async (base) => {
    const response = await fetch(`${base}/v1/analytics/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery) });
    assert.equal(response.status, 503);
    assert.equal(cancelled, true);
  });
});

test('undefined rule ranking stays honest and reproducible when policy context is unavailable', async () => {
  const dependencies = webDeps();
  const params = { ...defaultQuery, kind: 'rule_quality' };
  const rows = fixtureRows(params).map(row => row.period === 'current' ? { ...row, adjudicated: 0, falsePositives: 0 } : row);
  dependencies.call = async (_base, route) => {
    if (route === '/v1/analytics/query') return calculate(params, rows, { sourceAsOf: config.sourceAsOf, traceId: oid });
    throw unavailable('knowledge');
  };
  const answer = await createWebServices(config, dependencies).analyze(params, user, { traceId: oid });
  assert.equal(answer.knowledge.status, 'unavailable');
  assert.equal(answer.metrics.find(item => item.key === 'focusRule').value, null);
  assert.equal(answer.metrics.find(item => item.key === 'currentAdjudicated').value, 0);
  assert.match(answer.narrative.headline, /cannot be ranked/);
  assert.equal(answer.provenance.metricVersion, 'fraud-metrics-1.2.1');
  const stored = await dependencies.evidence.get(user, answer.answerId);
  assert.deepEqual(stored.answer, answer);
  assert.deepEqual(stored.request, params);
  assert.ok(stored.answer.table.rows.every(row => row.previousShare !== null && row.currentShare === null));
});

test('unchanged loss facts and corrected movement narrative remain durable without policy context', async () => {
  const dependencies = webDeps();
  const rows = fixtureRows().map(row => ({ ...row, loss: 100 }));
  dependencies.call = async (_base, route) => {
    if (route === '/v1/analytics/query') return calculate(defaultQuery, rows, { sourceAsOf: config.sourceAsOf, traceId: oid });
    throw unavailable('knowledge');
  };
  const answer = await createWebServices(config, dependencies).analyze(defaultQuery, user, { traceId: oid });
  assert.equal(answer.knowledge.status, 'unavailable');
  assert.equal(answer.metrics.find(item => item.key === 'lossDelta').value, 0);
  assert.match(answer.narrative.headline, /unchanged/);
  assert.match(answer.narrative.text, /All returned groups were unchanged/);
  assert.equal(answer.provenance.metricVersion, 'fraud-metrics-1.2.1');
  const stored = await dependencies.evidence.get(user, answer.answerId);
  assert.deepEqual(stored.answer, answer);
  assert.equal(stored.policyEvaluation.knowledgeStatus, 'unavailable');
});

test('mixed metric or template versions fail before returning or persisting a new answer', async () => {
  for (const overrides of [{ metricVersion: 'fraud-metrics-1.0.0' }, { metricVersion: 'fraud-metrics-1.1.0' },
    { metricVersion: 'fraud-metrics-1.1.1' }, { metricVersion: 'fraud-metrics-1.2.0' }, { metricVersion: 'future-unmatched-version' },
    { templateVersion: 'legacy-template' }]) {
    let writes = 0;
    const web = createWebServices(config, {
      model: {}, evidence: { put: async () => { writes++; } },
      call: async () => ({ ...resultFor(), ...overrides }),
    });
    await assert.rejects(web.analyze(defaultQuery, user), { status: 503 });
    assert.equal(writes, 0);
  }
});

test('web rejects mismatched broker source provenance before policy work or evidence and accepts equivalent UTC snapshots', async () => {
  const dependencies = webDeps();
  const realCall = dependencies.call;
  const routes = [];
  let broker;
  dependencies.call = async (base, route, context) => {
    routes.push(route);
    return route === '/v1/analytics/query' ? broker : realCall(base, route, context);
  };
  const web = createWebServices(config, dependencies);
  const app = createApplication(config, { authenticate: async () => user, web });
  await listening(app, async base => {
    for (const mutate of [
      value => { delete value.sourceId; },
      value => { value.sourceId = 'microsoft-fabric'; },
      value => { value.sourceId = 'local-synthetic-fixtures-fraud-v1'; },
      value => { delete value.sourceAsOf; },
      value => { value.sourceAsOf = '2026-10-02T00:00:00Z'; },
      value => { value.sourceAsOf = '2026-09-31T00:00:00Z'; },
      value => { value.sourceAsOf = '2026-09-30T20:00:00-04:00'; },
      value => { value.evidenceIds = []; },
      value => { value.evidenceIds = ['sql:not-a-source-hash']; },
      value => { value.evidenceIds = [value.evidenceIds[0].replace('sql:', 'local-fixture:')]; },
      value => { value.unapprovedExtraField = 'must-not-be-archived'; },
    ]) {
      broker = structuredClone(resultFor());
      mutate(broker);
      routes.length = 0;
      const response = await fetch(`${base}/api/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      for (const field of ['metrics', 'table', 'narrative', 'provenance', 'evidenceUrl']) assert.equal(Object.hasOwn(body, field), false);
      assert.deepEqual(routes, ['/v1/analytics/query']);
      assert.equal(dependencies.container.contents.size, 0);
    }
    broker = { ...resultFor(), sourceAsOf: '2026-10-01T00:00:00.000Z' };
    const recovered = await fetch(`${base}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery),
    });
    assert.equal(recovered.status, 200);
    const answer = await recovered.json();
    assert.equal(answer.provenance.sourceAsOf, broker.sourceAsOf);
    assert.equal(answer.metrics.find(item => item.key === 'currentLoss').value, 1240000);
    assert.equal(dependencies.container.contents.size, 1);
  });
});

test('broker HTTP rejects sub-cent source money without returning numerical fields', async () => {
  const app = createApplication({ ...config, role: 'broker' }, {
    authenticate: async () => user,
    sql: { analytics: async () => {
      const rows = fixtureRows();
      rows[0].loss = 0.005;
      return rows;
    } },
  });
  await listening(app, async base => {
    const response = await fetch(`${base}/v1/analytics/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'SOURCE_INTEGRITY_ERROR');
    for (const field of ['metrics', 'table', 'narrative', 'evidenceIds']) assert.equal(Object.hasOwn(body, field), false);
  });
});

test('broker HTTP withholds all numbers when source snapshot metadata is missing and recovers only with verified source rows', async () => {
  let corrupt = true;
  const app = createApplication({ ...config, role: 'broker' }, {
    authenticate: async () => user,
    sql: { analytics: async params => {
      const rows = fixtureRows(params);
      if (corrupt) { delete rows[0].sourceAsOfMin; delete rows[0].sourceAsOfMax; }
      return rows;
    } },
  });
  await listening(app, async (base) => {
    for (const kind of ['loss_comparison', 'rule_quality']) {
      const response = await fetch(`${base}/v1/analytics/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...defaultQuery, kind }),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'SOURCE_INTEGRITY_ERROR');
      for (const field of ['metrics', 'table', 'evidenceIds', 'sourceAsOf']) assert.equal(Object.hasOwn(body, field), false);
    }
    corrupt = false;
    const recovered = await fetch(`${base}/v1/analytics/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(defaultQuery),
    });
    assert.equal(recovered.status, 200);
    const body = await recovered.json();
    assert.equal(body.sourceAsOf, config.sourceAsOf);
    assert.equal(body.metrics.find(item => item.key === 'currentLoss').value, 1240000);
    assert.equal(body.metrics.find(item => item.key === 'lossChangePercent').value, 24);
  });
});

test('frontend service caller forwards identity, never roles, and preserves safe no-data errors', async () => {
  const credential = { getToken: async (scope) => { assert.equal(scope, `${config.audience}/.default`); return { token: 'unit-test-token-not-a-credential' }; } };
  const call = createServiceCaller(config, credential, async (_url, options) => {
    assert.equal(options.headers['x-fraud-user-oid'], oid);
    assert.equal(options.headers['x-fraud-roles'], undefined);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ error: { code: 'NO_DATA', message: 'untrusted message' } }), { status: 422, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(call(config.brokerUrl, '/v1/analytics/query', { user, body: defaultQuery }), { code: 'NO_DATA', message: 'Complete current and previous periods are not available. Missing data is not zero.' });
});

test('rate limit is bounded per authenticated identity and resets', () => {
  let now = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 10, clock: () => now });
  limit(oid); limit(oid);
  assert.throws(() => limit(oid), { status: 429 });
  limit(callerOid);
  now = 11;
  assert.doesNotThrow(() => limit(oid));
});
