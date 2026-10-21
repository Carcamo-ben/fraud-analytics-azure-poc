import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { authenticateEasyAuth, scopedUser, createApiAuthenticator, verifyApiToken } from '../src/auth.mjs';
import { buildFilter, citationsFromResults, createKnowledge } from '../src/knowledge/search.mjs';
import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';
import { validatePlan, createModel, validatePlannerExecution, plannerRequestSha256, PROMPT_SHA256, RESPONSE_SCHEMA_SHA256 } from '../src/model.mjs';
import { loadConfig } from '../src/config.mjs';
import { documents } from '../seed/fixtures.mjs';
import { config, oid, callerOid, secondOid, tenantId, user, defaultQuery } from './helpers.mjs';

function easyAuth(oidValue = oid, tenant = tenantId) {
  return { 'x-ms-client-principal': Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [
    { typ: 'oid', val: oidValue }, { typ: 'tid', val: tenant }, { typ: 'name', val: 'Analyst' }, { typ: 'roles', val: 'PolicyOwner' },
  ] })).toString('base64') };
}

test('EasyAuth trust boundary requires production platform, tenant and explicit OID allowlist', () => {
  assert.equal(authenticateEasyAuth(easyAuth(), config).oid, oid);
  assert.deepEqual(authenticateEasyAuth(easyAuth(), config).roles, ['analyst']);
  assert.throws(() => authenticateEasyAuth(easyAuth(), { ...config, productionEasyAuth: false }), { status: 401 });
  assert.throws(() => authenticateEasyAuth(easyAuth(secondOid), config), { status: 403 });
  assert.throws(() => authenticateEasyAuth(easyAuth(oid, secondOid), config), { status: 403 });
  assert.throws(() => authenticateEasyAuth({ 'x-ms-client-principal': 'garbage' }, config), { status: 401 });
  assert.deepEqual(scopedUser(oid, { ...config, policyOwnerOids: new Set([oid]) }).roles, ['analyst', 'PolicyOwner']);
});

test('API JWTs require verified signature, issuer, audience, lifetime, caller OID and scoped user', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const otherKey = await generateKeyPair('RS256');
  const issue = (claims = {}, key = privateKey, expires = '5m') => new SignJWT({ tid: tenantId, oid: callerOid, ...claims })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://sts.windows.net/${tenantId}/`)
    .setAudience(config.audience).setIssuedAt().setExpirationTime(expires).sign(key);
  const authenticate = createApiAuthenticator(config, (token) => verifyApiToken(token, publicKey, config));
  const request = (token, oidValue = oid) => ({ headers: { authorization: `Bearer ${token}`, 'x-fraud-user-oid': oidValue, 'x-fraud-roles': 'PolicyOwner' } });
  const result = await authenticate(request(await issue()));
  assert.deepEqual(result.roles, ['analyst']);
  assert.equal(result.businessUnit, 'poc');
  await assert.rejects(authenticate(request(await issue({}, otherKey.privateKey))), { status: 401 });
  await assert.rejects(authenticate(request(await issue({}, privateKey, '-1m'))), { status: 401 });
  await assert.rejects(authenticate(request(await issue({ tid: secondOid }))), { status: 403 });
  await assert.rejects(authenticate(request(await issue({ oid: secondOid }))), { status: 403 });
  await assert.rejects(authenticate(request(await issue({ scp: 'user_impersonation' }))), { status: 403 });
  await assert.rejects(authenticate(request(await issue(), secondOid)), { status: 403 });
  const wrongAudience = await new SignJWT({ tid: tenantId, oid: callerOid }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://sts.windows.net/${tenantId}/`).setAudience('api://other').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(authenticate(request(wrongAudience)), { status: 401 });
  const wrongIssuer = await new SignJWT({ tid: tenantId, oid: callerOid }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://attacker.invalid/').setAudience(config.audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(authenticate(request(wrongIssuer)), { status: 401 });
  assert.equal((await authenticate({ headers: { authorization: `Bearer ${await issue()}` } }, { health: true })).callerOid, callerOid);
});

test('knowledge authorization filter is server-built, date bounded and blocks restricted leaks', () => {
  const filter = buildFilter(user, '2026-09-30');
  assert.match(filter, /domain eq 'fraud'/);
  assert.match(filter, /'analyst'/);
  assert.doesNotMatch(filter, /PolicyOwner/);
  assert.throws(() => buildFilter({ ...user, roles: ["analyst') or true"] }, '2026-09-30'));
  assert.throws(() => buildFilter(user, "2026-09-30' or true"));
  assert.throws(() => citationsFromResults([documents[5]], user, '2026-09-30'));
  assert.throws(() => citationsFromResults([documents[0]], user, '2026-09-01'));
  const source = citationsFromResults([documents[0]], user, '2026-09-30')[0];
  assert.equal(source.documentId, 'synthetic-r017-change');
  assert.match(source.citationId, /^cite-/);
  assert.equal(source.citationId, citationsFromResults([documents[0]], user, '2026-09-30')[0].citationId);
});

test('keyword-only is explicit and hybrid fails closed instead of silently falling back', async () => {
  let called = 0;
  const http = async (_url, options) => {
    called++;
    if (options.body.count) {
      assert.equal(options.body.select.includes('content,'), false);
      return { '@odata.count': documents.length, value: documents };
    }
    assert.match(options.body.filter, /'analyst'/);
    assert.equal(options.body.top, 4);
    assert.equal(options.body.vectorQueries, undefined);
    return { value: [documents[1]] };
  };
  const model = { embed: async () => { throw new Error('embedding blocked'); } };
  const keyword = createKnowledge({ ...config, knowledgeMode: 'keyword-only', searchIndex: POLICY_SNAPSHOT.indexName, searchEndpoint: 'https://search.example.invalid' }, http, model);
  assert.equal((await keyword.retrieve({ q: 'fraud KPI' }, user)).mode, 'keyword-only');
  assert.equal((await keyword.probe()).status, 'keyword-only');
  const hybrid = createKnowledge({ ...config, knowledgeMode: 'hybrid', searchIndex: POLICY_SNAPSHOT.indexName }, http, model);
  await assert.rejects(hybrid.retrieve({ q: 'fraud KPI' }, user), /embedding blocked/);
  assert.equal(called, 5);
});

test('model uses bounded real planner output only and validates unsupported or malicious responses', async () => {
  assert.deepEqual(validatePlan({ supported: true, request: defaultQuery, reason: 'approved' }), defaultQuery);
  assert.throws(() => validatePlan({ supported: false, request: null, reason: 'unsupported' }), { code: 'UNSUPPORTED_QUESTION' });
  assert.throws(() => validatePlan({ supported: true, request: { ...defaultQuery, raw_sql: 'select' }, reason: 'approved' }));
  let calls = 0;
  const model = createModel({ openaiEndpoint: 'https://canadian.openai.azure.com', chatDeployment: 'approved' }, async (_url, options) => {
    calls++;
    assert.equal(options.body.response_format.type, 'json_schema');
    assert.equal(options.body.max_tokens, 600);
    assert.equal(options.body.messages[0].role, 'system');
    return { id: 'chatcmpl-synthetic-unit-test', model: 'unit-test-model-2026-09-01', created: 1792450800,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ supported: true, request: defaultQuery, reason: 'approved' }) } }] };
  });
  const planned = await model.plan('Compare monthly fraud losses by channel');
  assert.deepEqual(planned.request, defaultQuery);
  assert.equal(planned.provenance.reportedModel, 'unit-test-model-2026-09-01');
  assert.equal(planned.provenance.configuredModelVersion, 'unverified');
  assert.equal(planned.provenance.systemFingerprint, null);
  await assert.rejects(model.plan('Delete all rows from transactions'));
  assert.equal(calls, 1);
  await assert.rejects(createModel({}, async () => assert.fail()).plan('Compare monthly fraud losses'), { status: 503 });
});

test('planner evidence binds actual completion identity, exact prompt/schema, question and typed request', async () => {
  const question = 'Compare monthly fraud losses by channel';
  const content = JSON.stringify({ supported: true, request: defaultQuery, reason: 'approved' });
  const completion = { id: 'chatcmpl-synthetic-unit-test', model: 'unit-test-model-2026-09-01', created: 1792450800,
    system_fingerprint: 'fp_synthetic', choices: [{ finish_reason: 'stop', message: { content } }] };
  const options = { ...config, openaiEndpoint: 'https://canadian.example.invalid' };
  const planned = await createModel(options, async () => completion).plan(question);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  assert.equal(planned.provenance.promptSha256, PROMPT_SHA256);
  assert.equal(planned.provenance.responseSchemaSha256, RESPONSE_SCHEMA_SHA256);
  assert.equal(planned.provenance.responseSha256, digest(content));
  assert.equal(planned.provenance.requestSha256, digest(JSON.stringify(planned.request)));
  assert.equal(planned.provenance.questionSha256, digest(question));
  assert.equal(planned.provenance.configuredModelVersion, 'test');
  assert.notEqual(planned.provenance.reportedModel, planned.provenance.configuredModelVersion);
  assert.equal(planned.provenance.completionCreatedAt, new Date(completion.created * 1000).toISOString());
  const expected = { request: planned.request, question, deployment: config.chatDeployment, configuredModelVersion: 'test' };
  const reordered = { previous: { end: defaultQuery.previous.end, start: defaultQuery.previous.start },
    current: { end: defaultQuery.current.end, start: defaultQuery.current.start }, groupBy: defaultQuery.groupBy, kind: defaultQuery.kind };
  assert.equal(plannerRequestSha256(reordered), planned.provenance.requestSha256);
  assert.doesNotThrow(() => validatePlannerExecution(planned.provenance, { ...expected, request: reordered }));
  for (const mutate of [
    (value) => { delete value.completionId; }, (value) => { value.reportedModel = ''; },
    (value) => { value.promptSha256 = '0'.repeat(64); }, (value) => { value.responseSchemaSha256 = '0'.repeat(64); },
    (value) => { value.requestSha256 = '0'.repeat(64); }, (value) => { value.questionSha256 = '0'.repeat(64); },
    (value) => { value.deployment = 'different'; }, (value) => { value.parameters.max_tokens++; },
    (value) => { value.completionCreatedAt = '2026-02-30T00:00:00.000Z'; },
  ]) {
    const value = structuredClone(planned.provenance);
    mutate(value);
    assert.throws(() => validatePlannerExecution(value, expected), { status: 503 });
  }
  for (const field of ['id', 'model', 'created']) {
    const missing = structuredClone(completion);
    delete missing[field];
    await assert.rejects(createModel(options, async () => missing).plan(question), { status: 503 });
  }
});
test('cloud configuration fails closed and offers no local auth bypass', () => {
  const env = {
    ROLE: 'broker', AZURE_CLIENT_ID: callerOid, TENANT_ID: tenantId, SOURCE_AS_OF: config.sourceAsOf,
    API_AUDIENCE: config.audience, ALLOWED_USER_OIDS: oid, ALLOWED_CALLER_OIDS: callerOid,
    SQL_SERVER: 'synthetic.database.windows.net',
  };
  assert.equal(loadConfig({ ...env, AUTH_BYPASS: 'true' }).productionEasyAuth, false);
  assert.throws(() => loadConfig({ ...env, ALLOWED_CALLER_OIDS: '' }));
  assert.throws(() => loadConfig({ ...env, SQL_SERVER: 'localhost' }));
  assert.throws(() => loadConfig({ ...env, ROLE: 'knowledge', SEARCH_ENDPOINT: 'https://fraud.search.windows.net' }));
  assert.equal(loadConfig({ ...env, ROLE: 'knowledge', SEARCH_ENDPOINT: 'https://fraud.search.windows.net', KNOWLEDGE_MODE: 'keyword-only' }).knowledgeMode, 'keyword-only');
  for (const sourceAsOf of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-09-31T00:00:00.000Z',
    '2026-10-01T01:00:00Z', '2026-10-01T00:00:00.001Z', '2026-09-30T20:00:00-04:00']) {
    assert.throws(() => loadConfig({ ...env, SOURCE_AS_OF: sourceAsOf }));
  }
  assert.equal(loadConfig({ ...env, SOURCE_AS_OF: '2026-10-01T00:00:00.000Z' }).sourceAsOf, '2026-10-01T00:00:00.000Z');
});
