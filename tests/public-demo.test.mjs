import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDemoBudget, publicDemoUser } from '../src/public-demo.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication, createRateLimiter } from '../src/app.mjs';
import { AppError, safeError } from '../src/errors.mjs';
import { config, oid, secondOid, tenantId, callerOid, listening } from './helpers.mjs';

const demoConfig = {
  ...config, publicDemo: true, demoUserOid: secondOid,
  allowedUsers: new Set([secondOid]), policyOwnerOids: new Set(),
};

test('public demo identity is fixed and cannot become a policy owner or backend auth bypass', () => {
  const user = publicDemoUser(demoConfig);
  assert.equal(user.oid, secondOid);
  assert.equal(user.businessUnit, 'poc');
  assert.deepEqual(user.roles, ['analyst']);
  assert(Object.isFrozen(user) && Object.isFrozen(user.roles));
  for (const override of [
    { publicDemo: false }, { role: 'broker' }, { demoUserOid: oid },
    { policyOwnerOids: new Set([secondOid]) },
  ]) assert.throws(() => publicDemoUser({ ...demoConfig, ...override }), { code: 'DEMO_CONFIGURATION' });
});

test('public access configuration requires explicit synthetic-only settings', () => {
  const env = {
    ROLE: 'web', AZURE_CLIENT_ID: callerOid, TENANT_ID: tenantId, API_AUDIENCE: config.audience,
    SOURCE_AS_OF: '2026-10-01T00:00:00Z', SQL_DATABASE: 'fraudpoc',
    ALLOWED_USER_OIDS: secondOid, PUBLIC_DEMO_USER_OID: secondOid,
    PUBLIC_DEMO_ENABLED: 'true', PUBLIC_DEMO_DATASET: 'azure-sql-synthetic-fraud-v1',
    BROKER_URL: 'https://broker.example.test', KNOWLEDGE_URL: 'https://knowledge.example.test',
    STORAGE_ACCOUNT_URL: 'https://store.example.test',
  };
  assert.equal(loadConfig(env).publicDemo, true);
  for (const override of [
    { PUBLIC_DEMO_DATASET: 'production' }, { SQL_DATABASE: 'customerdb' },
    { PUBLIC_DEMO_USER_OID: oid }, { POLICY_OWNER_OIDS: secondOid },
    { ROLE: 'broker', SQL_SERVER: 'fraud.database.windows.net', ALLOWED_CALLER_OIDS: callerOid },
    { PUBLIC_DEMO_ENABLED: 'yes' },
  ]) assert.throws(() => loadConfig({ ...env, ...override }));
  assert.equal(loadConfig({ ...env, PUBLIC_DEMO_ENABLED: 'false' }).publicDemo, false);
});

test('daily demo budget serializes concurrent claims, survives process recreation, resets by UTC day', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fraud-budget-'));
  const filePath = path.join(dir, 'budget.json');
  let now = new Date('2026-10-19T23:59:00Z');
  const options = { filePath, dailyLimit: 2, clock: () => now };
  try {
    const claim = createDemoBudget(options);
    const results = await Promise.allSettled([claim(), claim(), claim()]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
    assert.equal(results.find(item => item.status === 'rejected').reason.code, 'DEMO_DAILY_LIMIT');
    await assert.rejects(createDemoBudget(options)(), { code: 'DEMO_DAILY_LIMIT', retryAfterSeconds: 60 });
    now = new Date('2026-10-20T00:01:00Z');
    await createDemoBudget(options)();
    await writeFile(filePath, 'invalid-json');
    await assert.rejects(createDemoBudget(options)(), SyntaxError);
    await writeFile(filePath, '{"day":"2026-10-21","used":0}');
    await assert.rejects(createDemoBudget(options)(), { code: 'DEMO_BUDGET_UNAVAILABLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rate-limit retry guidance is bounded, exact for the current window and never copied from unknown errors', () => {
  let now = 0;
  const limit = createRateLimiter({ limit: 1, windowMs: 60000, clock: () => now });
  limit('synthetic-caller');
  now = 12000;
  assert.throws(() => limit('synthetic-caller'), { status: 429, retryAfterSeconds: 48 });
  now = 59999;
  assert.throws(() => limit('synthetic-caller'), { status: 429, retryAfterSeconds: 1 });
  now = 60000;
  assert.doesNotThrow(() => limit('synthetic-caller'));
  const error = new AppError(429, 'RATE_LIMITED', 'Wait.', { retryAfterSeconds: 48 });
  assert.equal(safeError(error, oid).retryAfterSeconds, 48);
  assert.equal(safeError(Object.assign(new Error('untrusted'), { status: 429, retryAfterSeconds: 48 }), oid).retryAfterSeconds, undefined);
  for (const seconds of [0, -1, 1.5, Infinity, '60', 86401]) {
    assert.throws(() => new AppError(429, 'RATE_LIMITED', 'Wait.', { retryAfterSeconds: seconds }), RangeError);
  }
});

test('HTTP daily quota reports UTC retry timing without executing work, then recovers only on a new-day request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fraud-http-budget-'));
  let now = new Date('2026-10-19T23:59:00.001Z'), work = 0;
  const app = createApplication(demoConfig, {
    authenticate: () => publicDemoUser(demoConfig),
    demoBudget: createDemoBudget({ filePath: path.join(dir, 'budget.json'), dailyLimit: 1, clock: () => now }),
    web: { ask: async () => { work++; return { synthetic: true }; } },
  });
  try {
    await listening(app, async (base) => {
      const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"Compare monthly losses"}' };
      assert.equal((await fetch(`${base}/api/ask`, options)).status, 200);
      const blocked = await fetch(`${base}/api/ask`, options);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '60');
      assert.equal((await blocked.json()).error.code, 'DEMO_DAILY_LIMIT');
      assert.equal(work, 1, 'Quota rejection cannot run the planner or broker.');
      now = new Date('2026-10-20T00:00:00Z');
      const recovered = await fetch(`${base}/api/ask`, options);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.headers.get('retry-after'), null);
      assert.equal(work, 2);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP burst limit returns a bounded Retry-After without charging a thirteenth shared request', async () => {
  let budgetCalls = 0;
  const app = createApplication(demoConfig, {
    authenticate: () => publicDemoUser(demoConfig), demoBudget: async () => { budgetCalls++; },
    web: { knowledge: async () => ({ status: 'available', sources: [] }) },
  });
  await listening(app, async (base) => {
    for (let index = 0; index < 12; index++) assert.equal((await fetch(`${base}/api/knowledge?q=R017`)).status, 200);
    const blocked = await fetch(`${base}/api/knowledge?q=R017`);
    assert.equal(blocked.status, 429);
    const retry = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isSafeInteger(retry) && retry >= 1 && retry <= 60);
    assert.equal(budgetCalls, 12);
  });
});

test('anonymous routes ignore identity headers and require budget before model execution', async () => {
  let calls = 0;
  let budgetCalls = 0;
  const app = createApplication(demoConfig, {
    authenticate: () => publicDemoUser(demoConfig),
    demoBudget: async () => { budgetCalls++; },
    web: {
      ask: async (question, user) => {
        calls++;
        assert.equal(user.oid, secondOid);
        assert.deepEqual(user.roles, ['analyst']);
        return { synthetic: true, question };
      },
    },
  });

  await listening(app, async base => {
    const response = await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fraud-user-oid': oid, 'x-fraud-roles': 'PolicyOwner' },
      body: JSON.stringify({ question: 'Compare monthly losses' }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal(budgetCalls, 1);
  });
  const closed = createApplication(demoConfig, {
    authenticate: () => publicDemoUser(demoConfig),
    web: { ask: async () => assert.fail('No model call without a budget') },
  });
  await listening(closed, async base => {
    assert.equal((await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"Compare losses"}',
    })).status, 503);
  });
});

test('public demo limits concurrent work and rejects cross-origin writes before charging budget', async () => {
  const finish = [];
  let budgetCalls = 0;
  const app = createApplication(demoConfig, {
    authenticate: () => publicDemoUser(demoConfig),
    demoBudget: async () => { budgetCalls++; },
    web: { ask: async () => new Promise(resolve => finish.push(() => resolve({ synthetic: true }))) },
  });
  await listening(app, async base => {
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"Compare monthly losses"}' };
    const cross = await fetch(`${base}/api/ask`, { ...options, headers: { ...options.headers, origin: 'https://untrusted.example' } });
    assert.equal(cross.status, 403);
    assert.equal(budgetCalls, 0);
    const first = fetch(`${base}/api/ask`, options);
    const second = fetch(`${base}/api/ask`, options);
    for (let i = 0; i < 100 && finish.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    try {
      assert.equal(finish.length, 2);
      const busy = await fetch(`${base}/api/ask`, options);
      assert.equal(busy.status, 429);
      assert.equal(busy.headers.get('retry-after'), null, 'Concurrent completion time is unknown; no fabricated countdown.');
      assert.equal((await busy.json()).error.code, 'DEMO_BUSY');
      assert.equal(budgetCalls, 2);
    } finally { finish.forEach(resolve => resolve()); }
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  });
});
