import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { startLocalPreview, parseArguments, assertLocalEnvironment, LOCAL_USER, LOCAL_MODEL } from '../dev/local-preview.mjs';
import { createLocalEvidenceContainer } from '../dev/local-evidence.mjs';
import { createLocalSearchTransport, LOCAL_SEARCH_ENDPOINT, LOCAL_SEARCH_URL } from '../dev/local-fixture-transport.mjs';
import { createEvidence } from '../src/evidence.mjs';
import { createKnowledge, SEARCH_METADATA_FIELDS, validateIndexInventory } from '../src/knowledge/search.mjs';
import { POLICY_SNAPSHOT, createPolicySnapshot } from '../src/knowledge/policies.mjs';
import { syntheticPolicyManifest } from '../src/knowledge/policy-manifest.mjs';
import { MAX_RESPONSE_BYTES } from '../src/validation.mjs';
import { SCENARIOS } from '../src/web/services.mjs';
import { resultFor } from './helpers.mjs';
import { SOURCE_AS_OF } from '../seed/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const cleanupCallbacks = new WeakMap();
const knowledgeConfig = {
  searchEndpoint: LOCAL_SEARCH_ENDPOINT, searchIndex: POLICY_SNAPSHOT.indexName,
  knowledgeMode: 'keyword-only', sourceAsOf: SOURCE_AS_OF,
};
const knowledgeFor = (transport = createLocalSearchTransport()) => createKnowledge(knowledgeConfig, transport, LOCAL_MODEL);
const inventoryOptions = () => ({
  scope: 'https://search.azure.com/.default', method: 'POST', signal: undefined, service: 'Azure AI Search',
  body: { search: '*', top: 65, count: true, select: SEARCH_METADATA_FIELDS.join(',') },
});
async function directoryFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fraud-local-preview-test-'));
  const callbacks = [];
  cleanupCallbacks.set(t, callbacks);
  t.after(async () => {
    try { for (const callback of callbacks.reverse()) await callback(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return directory;
}
async function previewFor(t) {
  const directory = await directoryFor(t);
  const preview = await startLocalPreview({ evidenceDirectory: path.join(directory, 'evidence') });
  cleanupCallbacks.get(t).push(() => preview.stop());
  return preview;
}
async function json(preview, route, body, headers = {}) {
  const response = await fetch(`${preview.url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const policyRoute = (subject, asOf, extra = {}) => `/api/knowledge?${new URLSearchParams({ q: 'Fictional policy context R017 net loss', subject, asOf, ...extra })}`;

test('loopback-only default ephemeral port serves the actual analyst UI and honest local readiness', async (t) => {
  const preview = await previewFor(t);
  assert.equal(preview.server.address().address, '127.0.0.1');
  assert.equal(preview.server.address().family, 'IPv4');
  assert.ok(preview.port > 0);
  const page = await fetch(preview.url);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), await readFile(path.join(root, 'src', 'web', 'public', 'index.html'), 'utf8'));
  assert.equal(page.headers.get('content-security-policy').includes("connect-src 'self'"), true);
  for (const asset of ['app.js', 'styles.css']) {
    const response = await fetch(`${preview.url}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(path.join(root, 'src', 'web', 'public', asset), 'utf8'));
  }
  const status = await json(preview, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.localPreview, true);
  assert.equal(status.data.source.type, 'local-synthetic-fixtures');
  assert.match(status.data.source.label, /Local synthetic fixtures.*not connected to Azure, Fabric or Foundry/);
  assert.deepEqual(status.data.capabilities, { guided: true, naturalLanguage: false, knowledge: true, evidence: true });
  assert.equal(status.data.services.knowledge.snapshotHash, POLICY_SNAPSHOT.snapshotHash);
  assert.match(status.data.services.broker.detail, /no SQL connection/);
  assert.match(status.data.services.evidence.detail, /local filesystem/);
  assert.doesNotMatch(JSON.stringify(status.data), /Readiness is based on live probes|data in real Azure SQL/);
  assert.equal((await json(preview, '/health/ready')).status, 200);
  assert.equal((await json(preview, '/api/scenarios')).data.length, 2);
  await preview.stop();
  await preview.stop();
  assert.equal(preview.server.listening, false);
  await assert.rejects(fetch(preview.url));
});

test('explicit directory, ports, interfaces and production environments fail closed', async () => {
  assert.throws(() => parseArguments([]), /explicit dedicated/);
  assert.deepEqual(parseArguments(['--evidence-directory', '.\\local-data']), { port: 0, evidenceDirectory: '.\\local-data' });
  assert.equal(parseArguments(['--evidence-directory', 'fixture', '--port', '0']).port, 0);
  for (const args of [
    ['--evidence-directory', 'fixture', '--host', '0.0.0.0'],
    ['--evidence-directory', 'fixture', '--port', '-1'],
    ['--evidence-directory', 'fixture', '--port', '65536'],
    ['--evidence-directory', 'fixture', '--port', '3.5'],
    ['--evidence-directory', 'fixture', '--port', '0', '--port', '1'],
  ]) assert.throws(() => parseArguments(args));
  await assert.rejects(startLocalPreview({ port: 0 }), { status: 400 });
  await assert.rejects(startLocalPreview({ evidenceDirectory: 'unused', host: '0.0.0.0' }), { status: 400 });
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'PRODUCTION' }, { WEBSITE_SITE_NAME: 'app' },
    { CONTAINER_APP_NAME: 'app' }, { KUBERNETES_SERVICE_HOST: 'cluster' }, { ROLE: 'web' }]) {
    assert.throws(() => assertLocalEnvironment(env), /refuses production/);
  }
  assert.doesNotThrow(() => assertLocalEnvironment({ NODE_ENV: 'test', PORT: '8080' }));
});

test('explicit ports are honored, occupied ports fail, and failed starts release their evidence lock', async (t) => {
  const preview = await previewFor(t);
  const secondDirectory = path.join(path.dirname(preview.evidenceDirectory), 'second-evidence');
  await assert.rejects(startLocalPreview({ port: preview.port, evidenceDirectory: secondDirectory }), { code: 'EADDRINUSE' });
  assert.ok(!(await readdir(secondDirectory)).includes('.preview.lock'));
  await preview.stop();
  const restarted = await startLocalPreview({ port: preview.port, evidenceDirectory: secondDirectory });
  cleanupCallbacks.get(t).push(() => restarted.stop());
  assert.equal(restarted.port, preview.port);
  assert.equal(restarted.server.address().address, '127.0.0.1');
  assert.equal((await json(restarted, '/api/status')).status, 200);
});

test('guided loss and rule analyses execute production calculation, comparison, citations and persisted evidence', async (t) => {
  const preview = await previewFor(t);
  for (const scenario of SCENARIOS) {
    const response = await json(preview, '/api/analyze', scenario.request);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const answer = response.data, expected = resultFor(scenario.request);
    assert.deepEqual(answer.metrics, expected.metrics);
    assert.deepEqual(answer.table, expected.table);
    assert.equal(answer.knowledge.status, 'available');
    assert.equal(answer.knowledge.mode, 'keyword-only');
    assert.equal(answer.knowledge.policyResolution.status, 'resolved');
    assert.equal(answer.provenance.policySnapshotHash, POLICY_SNAPSHOT.snapshotHash);
    assert.equal(answer.provenance.sourceId, 'local-synthetic-fixtures-fraud-v1');
    assert.equal(answer.provenance.mode, 'guided');
    assert.equal(answer.provenance.promptVersion, 'not-used-guided-v1');
    assert.match(answer.narrative.caveats.join(' '), /no live SQL query/);
    assert.doesNotMatch(answer.narrative.caveats.join(' '), /Synthetic aggregate Azure SQL data only/);
    assert.ok(answer.knowledge.sources.length > 0);
    for (const source of answer.knowledge.sources) {
      const doc = POLICY_SNAPSHOT.documents.find((item) => item.chunkId === source.chunkId);
      assert.equal(doc.version, source.version);
      assert.ok(doc.content.startsWith(source.excerpt));
      assert.match(source.citationId, /^cite-[a-f0-9]{20}$/);
    }
    const segments = answer.knowledge.policyResolution.segments;
    if (scenario.request.kind === 'loss_comparison') {
      assert.deepEqual(segments.map((segment) => segment.decisions[0].version), ['4.0', '4.1']);
    } else {
      assert.ok(segments.some((segment) => segment.start === '2026-09-12'));
      assert.ok(segments.some((segment) => segment.start === '2026-09-20' &&
        segment.decisions.some((decision) => decision.version === '2.4-qc')));
      assert.ok(answer.knowledge.sourceCoverage.omittedResolvedVersions > 0);
    }
    const stored = await json(preview, answer.evidenceUrl);
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.data.answer, answer);
    assert.ok(stored.data.brokerEvidenceIds.every((id) => id.startsWith('local-fixture:')));
    const bytes = await readFile(path.join(preview.evidenceDirectory, LOCAL_USER.oid, `${answer.answerId}.json`), 'utf8');
    assert.deepEqual(JSON.parse(bytes), stored.data);
  }
});

test('policy catalog exposes bounded authorized metadata and effective-date scenarios', async (t) => {
  const preview = await previewFor(t);
  const response = await json(preview, '/api/policies');
  assert.equal(response.status, 200);
  assert.equal(response.data.snapshotHash, POLICY_SNAPSHOT.snapshotHash);
  assert.equal(response.data.policySetVersion, POLICY_SNAPSHOT.policySetVersion);
  assert.ok(response.data.scenarios.some((item) => item.id === 'overlap'));
  assert.ok(response.data.policies.some((item) => item.policyId === 'net-loss-kpi'));
  assert.doesNotMatch(JSON.stringify(response.data), /restricted-governance|allowedRoles|"chunks"|"content"/);
  assert.equal((await json(preview, '/api/policies?roles=PolicyOwner')).status, 400);
  assert.equal((await json(preview, '/api/policies', {})).status, 404);
});

test('historical/current dates, exclusive changes and scoped exception boundaries use actual resolver', async (t) => {
  const preview = await previewFor(t);
  for (const [subject, asOf, version, extra] of [
    ['loss-kpi', '2026-08-31', '4.0'], ['loss-kpi', '2026-09-01', '4.1'],
    ['r017-rule', '2026-09-11', '2.2'], ['r017-rule', '2026-09-12', '2.3'],
    ['r017-rule', '2026-09-22', '2.4-qc', { province: 'QC' }],
    ['r017-rule', '2026-09-22', '2.3', { province: 'ON' }],
    ['r017-rule', '2026-10-01', '2.3', { province: 'QC' }],
  ]) {
    const response = await json(preview, policyRoute(subject, asOf, extra));
    assert.equal(response.status, 200);
    assert.equal(response.data.policyResolution.status, 'resolved');
    assert.deepEqual(response.data.policyResolution.decisions.map((item) => item.version), [version]);
    assert.ok(response.data.sources.every((item) => item.version === version));
  }
});

test('unresolved overlaps and expired policy gaps never fabricate governing excerpts', async (t) => {
  const preview = await previewFor(t);
  const overlap = await json(preview, policyRoute('overlap-demo', '2026-09-15'));
  assert.equal(overlap.status, 200);
  assert.equal(overlap.data.policyResolution.status, 'conflict');
  assert.equal(overlap.data.policyResolution.conflicts[0].versions.length, 2);
  assert.deepEqual(overlap.data.sources, []);
  const expired = await json(preview, policyRoute('expired-demo', '2026-09-01'));
  assert.equal(expired.data.policyResolution.status, 'no-applicable-policy');
  assert.deepEqual(expired.data.sources, []);
});

test('browser identity is always the fixed analyst, including historical ACL and origin checks', async (t) => {
  const preview = await previewFor(t);
  const response = await json(preview, policyRoute('restricted-governance', '2026-08-31'), undefined, {
    'x-fraud-user-oid': randomUUID(), 'x-ms-client-principal': 'fake-owner', authorization: 'Bearer fake-owner',
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.policyResolution.status, 'no-applicable-policy');
  assert.deepEqual(response.data.sources, []);
  assert.doesNotMatch(JSON.stringify(response.data), /SYNTHETIC RESTRICTED DOCUMENT|policy-owner-only appendix/);
  assert.equal((await json(preview, '/api/knowledge?q=R017&roles=PolicyOwner')).status, 400);
  assert.equal((await json(preview, '/api/knowledge?q=R017&asOf=2026-09-01&asOf=2026-08-31')).status, 400);
  const spoofedHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${preview.url}/api/status`, { headers: { host: 'attacker.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(spoofedHostStatus, 403);
  assert.equal((await json(preview, '/api/status', undefined, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await json(preview, '/api/analyze', SCENARIOS[0].request, { origin: 'https://attacker.example' })).status, 403);
});

test('evidence survives restart unchanged, and repeated evidence IDs cannot overwrite existing files', async (t) => {
  const preview = await previewFor(t);
  const { data: answer } = await json(preview, '/api/analyze', SCENARIOS[0].request);
  const filename = path.join(preview.evidenceDirectory, LOCAL_USER.oid, `${answer.answerId}.json`);
  const original = await readFile(filename);
  await preview.stop();
  const container = await createLocalEvidenceContainer(preview.evidenceDirectory);
  const evidence = createEvidence({}, undefined, { container });
  await assert.rejects(evidence.put(LOCAL_USER, answer.answerId, { answer: { ...answer, synthetic: false } }), { status: 409 });
  assert.deepEqual(await readFile(filename), original);
  assert.deepEqual((await evidence.get(LOCAL_USER, answer.answerId)).answer, answer);
  await container.close();
  const restarted = await startLocalPreview({ evidenceDirectory: preview.evidenceDirectory });
  cleanupCallbacks.get(t).push(() => restarted.stop());
  assert.deepEqual((await json(restarted, answer.evidenceUrl)).data.answer, answer);
  assert.deepEqual(await readFile(filename), original);
});

test('production evidence ownership, answer checks and CURRENT policy ACL apply to filesystem reads', async (t) => {
  const directory = await directoryFor(t);
  const container = await createLocalEvidenceContainer(path.join(directory, 'evidence'));
  cleanupCallbacks.get(t).push(() => container.close());
  const evidence = createEvidence({}, undefined, { container });
  const owner = { ...LOCAL_USER, roles: ['analyst', 'PolicyOwner'] };
  const knowledge = await knowledgeFor().retrieve({ q: 'Fictional policy governance', subject: 'restricted-governance', asOf: '2026-08-31' }, owner);
  assert.ok(knowledge.sources.length);
  const answerId = randomUUID();
  await evidence.put(owner, answerId, { answer: { answerId, knowledge } });
  assert.equal((await evidence.get(owner, answerId)).answer.answerId, answerId);
  await assert.rejects(evidence.get(LOCAL_USER, answerId), { status: 403 });
  await assert.rejects(evidence.get({ ...owner, oid: randomUUID() }, answerId), { status: 404 });
  const changed = structuredClone(syntheticPolicyManifest);
  changed.access.find((item) => item.policyId === 'restricted-governance').allowedRoles = ['analyst'];
  const revoked = createEvidence({}, undefined, { container, policySnapshot: createPolicySnapshot(changed) });
  await assert.rejects(revoked.get({ ...owner, roles: ['PolicyOwner'] }, answerId), { status: 403 });
  const wrongAnswerId = randomUUID(), wrongSubjectId = randomUUID();
  await evidence.put(LOCAL_USER, wrongAnswerId, { answer: { answerId: randomUUID() } });
  await assert.rejects(evidence.get(LOCAL_USER, wrongAnswerId), { status: 503 });
  await evidence.put(LOCAL_USER, wrongSubjectId, { subjectOid: randomUUID(), answer: { answerId: wrongSubjectId } });
  await assert.rejects(evidence.get(LOCAL_USER, wrongSubjectId), { status: 503 });
  const conflict = await knowledgeFor().retrieve({ q: 'Fictional policy overlap', subject: 'overlap-demo', asOf: '2026-09-15' }, LOCAL_USER);
  const conflictId = randomUUID();
  await evidence.put(LOCAL_USER, conflictId, { answer: { answerId: conflictId, knowledge: conflict } });
  assert.equal((await evidence.get(LOCAL_USER, conflictId)).answer.knowledge.policyResolution.status, 'conflict');
  assert.deepEqual((await evidence.get(LOCAL_USER, conflictId)).answer.knowledge.sources, []);
});

test('filesystem preflight, safe paths, size caps, missing records and exclusive directory lock', async (t) => {
  const directory = await directoryFor(t);
  await assert.rejects(createLocalEvidenceContainer(''), /explicit dedicated/);
  const unrelated = path.join(directory, 'unrelated');
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'keep.txt'), 'do not touch');
  await assert.rejects(createLocalEvidenceContainer(unrelated), /nonempty/);
  assert.equal(await readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'do not touch');
  const container = await createLocalEvidenceContainer(path.join(directory, 'evidence'));
  cleanupCallbacks.get(t).push(() => container.close());
  await assert.rejects(createLocalEvidenceContainer(container.directory), /already locked/);
  const evidence = createEvidence({}, undefined, { container });
  await assert.rejects(evidence.get(LOCAL_USER, randomUUID()), { status: 404 });
  for (const unsafe of ['../outside.json', `${LOCAL_USER.oid}/../../outside`, `${LOCAL_USER.oid}\\${randomUUID()}.json`, 'C:\\outside.json']) {
    await assert.rejects(container.getBlockBlobClient(unsafe).upload('{}', 2, { conditions: { ifNoneMatch: '*' } }), /GUID/);
  }
  await assert.rejects(container.getBlockBlobClient(`${LOCAL_USER.oid}/${randomUUID()}.json`).upload('{}', 2), /create-only/);
  await assert.rejects(evidence.put(LOCAL_USER, randomUUID(), { padding: 'x'.repeat(MAX_RESPONSE_BYTES) }), { status: 503 });
  const oversized = randomUUID();
  await mkdir(path.join(container.directory, LOCAL_USER.oid), { recursive: true });
  await writeFile(path.join(container.directory, LOCAL_USER.oid, `${oversized}.json`), 'x'.repeat(MAX_RESPONSE_BYTES + 1));
  await assert.rejects(evidence.get(LOCAL_USER, oversized), { status: 503 });
  const link = path.join(directory, 'linked-evidence');
  await symlink(container.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLocalEvidenceContainer(link), /symbolic links/);
});

test('natural-language planning is explicitly unavailable; no answer or evidence is fabricated', async (t) => {
  const preview = await previewFor(t);
  assert.equal((await LOCAL_MODEL.probe()).status, 'unavailable');
  await assert.rejects(LOCAL_MODEL.plan('Compare fraud losses'), { code: 'LOCAL_MODEL_UNAVAILABLE' });
  await assert.rejects(LOCAL_MODEL.embed('R017'), { code: 'LOCAL_MODEL_UNAVAILABLE' });
  const response = await json(preview, '/api/ask', { question: 'Compare August and September fraud losses by channel.' });
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, 'LOCAL_MODEL_UNAVAILABLE');
  assert.equal(response.data.answerId, undefined);
  assert.ok(!(await readdir(preview.evidenceDirectory)).includes(LOCAL_USER.oid));
});

test('local transport admits only exact bounded inventory and generated selected-chunk request contracts', async () => {
  const transport = createLocalSearchTransport();
  const inventory = await transport(LOCAL_SEARCH_URL, inventoryOptions());
  assert.equal(inventory.value.length, 16);
  assert.equal(POLICY_SNAPSHOT.snapshotHash, 'f17745ee4ea35abab53a64bea2fc664a67222fe45220c8fbebcf865942860c2d');
  assert.ok(inventory.value.every((doc) => !Object.hasOwn(doc, 'content')));
  validateIndexInventory(inventory);
  await assert.rejects(transport('https://search.azure.com', inventoryOptions()));
  for (const change of [
    (value) => { value.method = 'GET'; }, (value) => { value.body.top = 10000; },
    (value) => { value.body.select = '*'; }, (value) => { value.body.filter = 'true'; },
  ]) {
    const options = inventoryOptions(); change(options);
    await assert.rejects(transport(LOCAL_SEARCH_URL, options));
  }
  let selected;
  const knowledge = knowledgeFor(async (url, options) => {
    if (!options.body.count) selected = structuredClone(options);
    return transport(url, options);
  });
  const result = await knowledge.retrieve({ q: 'Net fraud loss KPI', subject: 'loss-kpi', asOf: '2026-09-01' }, LOCAL_USER);
  assert.equal(result.sources[0].version, '4.1');
  assert.match(selected.body.filter, /search\.in\(chunkId,/);
  for (const change of [
    (value) => { value.body.filter += ' or true'; },
    (value) => { value.body.vectorQueries = []; },
    (value) => { value.body.top = 100; },
    (value) => { value.body.select = 'content'; },
    (value) => { value.body.filter = value.body.filter.replace(/search\.in\(chunkId, '[^']+'/, "search.in(chunkId, 'missing-chunk'"); },
  ]) {
    const options = structuredClone(selected); change(options);
    await assert.rejects(transport(LOCAL_SEARCH_URL, options));
  }
});

test('production inventory and citation coherence gates reject partial, mixed or tampered fixtures', async () => {
  for (const mutate of [
    (result) => { result.value.pop(); },
    (result) => { result.value[0].snapshotHash = '0'.repeat(64); },
    (result) => { result.value[0].effectiveTo = '2026-09-30T00:00:00Z'; },
    (result) => { result.value[0].allowedRoles = ['PolicyOwner']; },
  ]) {
    const transport = createLocalSearchTransport();
    const knowledge = knowledgeFor(async (url, options) => {
      const result = await transport(url, options);
      if (options.body.count) mutate(result);
      return result;
    });
    await assert.rejects(knowledge.catalog(LOCAL_USER), { status: 503 });
    await assert.rejects(knowledge.retrieve({ q: 'Net fraud loss KPI' }, LOCAL_USER), { status: 503 });
    await assert.rejects(knowledge.probe(), { status: 503 });
  }
  const transport = createLocalSearchTransport();
  const corrupted = knowledgeFor(async (url, options) => {
    const result = await transport(url, options);
    if (!options.body.count) result.value[0].content += ' invented';
    return result;
  });
  await assert.rejects(corrupted.retrieve({ q: 'Net fraud loss KPI' }, LOCAL_USER), { status: 503 });
});

test('guided routes and readiness run with outbound network APIs blocked', async (t) => {
  const realFetch = globalThis.fetch;
  const attempted = [];
  const deny = (name) => (...args) => { attempted.push(name); throw new Error(`Outbound API blocked: ${name}`); };
  for (const [object, method] of [[http, 'request'], [https, 'request'], [https, 'get'], [tls, 'connect'], [dns, 'resolve']]) {
    t.mock.method(object, method, deny(method));
  }
  const lookup = dns.lookup;
  t.mock.method(dns, 'lookup', function (host, ...args) {
    if (host !== '127.0.0.1') return deny('dns.lookup')(host, ...args);
    return lookup.call(this, host, ...args);
  });
  for (const method of ['connect', 'createConnection']) {
    const original = net[method];
    t.mock.method(net, method, function (...args) {
      const options = args[0];
      if (!options || typeof options !== 'object' || options.host !== '127.0.0.1') return deny(`net.${method}`)(...args);
      return original.apply(this, args);
    });
  }
  t.mock.method(globalThis, 'fetch', (...args) => {
    if (new URL(args[0]).hostname !== '127.0.0.1') return deny('fetch')(...args);
    return realFetch(...args);
  });
  const preview = await previewFor(t);
  assert.equal((await json(preview, '/api/status')).status, 200);
  assert.equal((await json(preview, '/api/policies')).status, 200);
  const loss = await json(preview, '/api/analyze', SCENARIOS[0].request);
  assert.equal(loss.status, 200);
  assert.equal(loss.data.knowledge.status, 'available');
  assert.equal((await json(preview, loss.data.evidenceUrl)).status, 200);
  assert.deepEqual(attempted, []);
});

test('production public-demo burst and durable daily quotas are not widened for preview', async (t) => {
  const preview = await previewFor(t);
  for (let i = 0; i < 12; i++) {
    const response = await json(preview, '/api/policies');
    assert.equal(response.status, 200, JSON.stringify(response.data));
  }
  const limited = await json(preview, '/api/policies');
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'RATE_LIMITED');
  const ledger = path.join(preview.evidenceDirectory, '.demo-budget.json');
  const state = JSON.parse(await readFile(ledger, 'utf8'));
  assert.equal(state.used, 12);
  await preview.stop();
  await writeFile(ledger, JSON.stringify({ ...state, used: 300 }));
  const restarted = await startLocalPreview({ evidenceDirectory: preview.evidenceDirectory });
  cleanupCallbacks.get(t).push(() => restarted.stop());
  const daily = await json(restarted, '/api/policies');
  assert.equal(daily.status, 429);
  assert.equal(daily.data.error.code, 'DEMO_DAILY_LIMIT');
});

test('CLI signal handlers close listeners, release locks, and preserve the dedicated directory', async (t) => {
  const directory = await directoryFor(t);
  const entry = path.join(root, 'dev', 'local-preview.mjs');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const evidenceDirectory = path.join(directory, signal);
    // Emitting the event also tests the handler on Windows, where child.kill terminates without POSIX delivery.
    const code = `process.argv = [process.execPath, ${JSON.stringify(entry)}, '--evidence-directory', ${JSON.stringify(evidenceDirectory)}];
      await import(${JSON.stringify(pathToFileURL(entry).href)});
      process.emit(${JSON.stringify(signal)});`;
    const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '--eval', code], { cwd: root, timeout: 15000 });
    assert.equal(stderr, '');
    const lines = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const listening = lines.find((line) => line.event === 'local-preview-listening');
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(lines.some((line) => line.event === 'local-preview-stopped' && line.signal === signal));
    assert.ok(!(await readdir(evidenceDirectory)).includes('.preview.lock'));
    assert.ok((await readdir(evidenceDirectory)).includes('.fraud-local-preview'));
    await assert.rejects(fetch(listening.url));
  }
});
