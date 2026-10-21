import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureHttp } from '../src/azure-http.mjs';

const credential = { getToken: async () => ({ token: 'test-only' }) };

test('an existing Search index update can return HTTP 204 without JSON', async () => {
  const call = createAzureHttp(credential, async () => new Response(null, { status: 204 }));
  assert.equal(await call('https://example.test/indexes/demo', { scope: 'test', method: 'PUT', body: {} }), null);
});

test('HTTP 200 still requires valid JSON; failures never become successful empty results', async () => {
  const success = createAzureHttp(credential, async () => Response.json({ value: [] }));
  assert.deepEqual(await success('https://example.test', { scope: 'test' }), { value: [] });
  for (const response of [new Response('', { status: 200 }), new Response('denied', { status: 403 })]) {
    const call = createAzureHttp(credential, async () => response);
    await assert.rejects(call('https://example.test', { scope: 'test' }), { code: 'DEPENDENCY_UNAVAILABLE' });
  }
});
