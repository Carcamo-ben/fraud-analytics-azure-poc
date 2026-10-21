import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, safeError } from './errors.mjs';
import { GUID, exactObject, readJson, validateQuery, validateKnowledgeQuery, MAX_RESPONSE_BYTES } from './validation.mjs';
import { calculate } from './broker/metrics.mjs';
import { SCENARIOS } from './web/services.mjs';

const staticRoot = fileURLToPath(new URL('./web/public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(response, status, body) {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) throw new AppError(503, 'RESPONSE_BUDGET', 'Response exceeded the configured payload cap.');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}

export function createRateLimiter({ limit = 30, windowMs = 60000, clock = Date.now } = {}) {
  const entries = new Map();
  return (key) => {
    const time = clock();
    for (const [id, item] of entries) if (item.until <= time) entries.delete(id);
    const state = entries.get(key) ?? { until: time + windowMs, count: 0 };
    state.count += 1;
    entries.set(key, state);
    if (state.count > limit || entries.size > 2000) throw new AppError(429, 'RATE_LIMITED', 'Request rate exceeded. Wait before retrying.',
      { retryAfterSeconds: Math.max(1, Math.ceil((state.until - time) / 1000)) });
  };
}

export function createApplication(config, dependencies) {
  // Authentication is injectable only through this in-process constructor used by unit tests.
  // Public demo mode is an explicit synthetic-only product mode; backend JWTs remain required.
  const { authenticate, sql, knowledge, web, demoBudget } = dependencies;
  const limit = createRateLimiter();
  const demoBurst = createRateLimiter({ limit: 12 });
  const demoStatus = createRateLimiter({ limit: 120 });
  let demoActive = 0;
  const server = http.createServer(async (request, response) => {
    const start = Date.now();
    const incoming = request.headers['x-correlation-id'];
    const traceId = GUID.test(incoming ?? '') ? incoming : randomUUID();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.requestTimeoutMs ?? 45000);
    timeout.unref();
    request.on('aborted', () => abort.abort());
    response.on('close', () => { if (!response.writableEnded) abort.abort(); });
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('x-correlation-id', traceId);
    let route = 'unknown';
    let demoSlot = false;
    try {
      const url = new URL(request.url, 'http://localhost');
      const method = request.method;
      if (method === 'GET' && url.pathname === '/health/live') {
        route = 'live';
        json(response, 200, { status: 'live' });
        return;
      }
      const isReady = method === 'GET' && url.pathname === '/health/ready';
      const user = await authenticate(request, { health: isReady });
      if (!config.publicDemo) limit(user.oid ?? user.callerOid);
      else if (url.pathname.startsWith('/api/') || isReady) demoStatus('public-demo');
      if (method === 'POST' && config.role === 'web' && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Cross-origin writes are not permitted.');
      }
      const context = { signal: abort.signal, traceId };
      if (config.publicDemo && (
        (method === 'POST' && ['/api/ask', '/api/analyze'].includes(url.pathname)) ||
        (method === 'GET' && ['/api/knowledge', '/api/policies'].includes(url.pathname))
      )) {
        demoBurst('public-demo');
        if (demoActive >= 2) throw new AppError(429, 'DEMO_BUSY', 'Two demo analysis or knowledge requests are already running. Retry after one finishes.');
        if (typeof demoBudget !== 'function') throw new AppError(503, 'DEMO_BUDGET_UNAVAILABLE', 'The shared demo budget is unavailable.');
        demoActive += 1;
        demoSlot = true;
        await demoBudget();
      }
      if (isReady) {
        route = 'ready';
        const service = config.role === 'broker' ? await sql.probe(abort.signal)
          : config.role === 'knowledge' ? await knowledge.probe(abort.signal)
            : { status: (await web.status(user, abort.signal)).capabilities.guided ? 'ready' : 'unavailable' };
        json(response, ['ready', 'keyword-only'].includes(service.status) ? 200 : 503, { service });
        return;
      }
      if (config.role === 'broker' && method === 'POST' && url.pathname === '/v1/analytics/query') {
        route = 'analytics';
        const params = validateQuery(await readJson(request));
        const rows = await sql.analytics(params, user, abort.signal);
        json(response, 200, calculate(params, rows, { sourceAsOf: config.sourceAsOf, traceId }));
        return;
      }
      if (config.role === 'knowledge' && method === 'POST' && url.pathname === '/v1/knowledge/search') {
        route = 'knowledge';
        const query = validateKnowledgeQuery(await readJson(request));
        json(response, 200, await knowledge.retrieve(query, user, abort.signal));
        return;
      }
      if (config.role === 'knowledge' && method === 'POST' && url.pathname === '/v1/knowledge/compare') {
        route = 'policy-comparison';
        const params = validateQuery(await readJson(request));
        json(response, 200, await knowledge.compare(params, user, abort.signal));
        return;
      }
      if (config.role === 'knowledge' && method === 'GET' && url.pathname === '/v1/knowledge/policies') {
        route = 'policies';
        if (url.search) throw new AppError(400, 'INVALID_REQUEST', 'Policy catalog does not accept query parameters.');
        json(response, 200, await knowledge.catalog(user, abort.signal));
        return;
      }
      if (config.role !== 'web') throw new AppError(404, 'NOT_FOUND', 'Route not found.');
      if (method === 'GET' && url.pathname === '/api/status') {
        route = 'status'; json(response, 200, await web.status(user, abort.signal)); return;
      }
      if (method === 'GET' && url.pathname === '/api/scenarios') {
        route = 'scenarios'; json(response, 200, SCENARIOS); return;
      }
      if (method === 'GET' && url.pathname === '/api/policies') {
        route = 'policies';
        if (url.search) throw new AppError(400, 'INVALID_REQUEST', 'Policy catalog does not accept query parameters.');
        json(response, 200, await web.policies(user, abort.signal, traceId));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/analyze') {
        route = 'analyze'; json(response, 200, await web.analyze(await readJson(request), user, context)); return;
      }
      if (method === 'POST' && url.pathname === '/api/ask') {
        route = 'ask';
        const body = exactObject(await readJson(request), ['question']);
        json(response, 200, await web.ask(body.question, user, context)); return;
      }
      if (method === 'GET' && url.pathname === '/api/knowledge') {
        route = 'knowledge';
        const query = Object.fromEntries(url.searchParams);
        if ([...url.searchParams.keys()].length !== Object.keys(query).length) throw new AppError(400, 'INVALID_REQUEST', 'Duplicate query parameters are not permitted.');
        json(response, 200, await web.knowledge(query, user, abort.signal, traceId)); return;
      }
      if (method === 'GET' && /^\/api\/evidence\/[^/]+$/.test(url.pathname)) {
        route = 'evidence';
        json(response, 200, await web.evidence.get(user, url.pathname.split('/').at(-1), abort.signal)); return;
      }
      if (method === 'GET') {
        route = 'static';
        const name = url.pathname === '/' ? 'index.html' : url.pathname === '/api/user-stories' ? 'user-stories.json' : url.pathname.slice(1);
        if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(name) || name.split('/').some((part) => part === '..') || !MIME[path.extname(name)]) throw new AppError(404, 'NOT_FOUND', 'Route not found.');
        let content;
        try { content = await readFile(path.join(staticRoot, name)); }
        catch (error) {
          if (error.code === 'ENOENT') throw new AppError(503, 'NOT_READY', 'The requested frontend artifact is not deployed.');
          throw error;
        }
        if (content.length > 1048576) throw new AppError(503, 'RESPONSE_BUDGET', 'Static artifact exceeds the configured limit.');
        response.writeHead(200, { 'content-type': MIME[path.extname(name)] });
        response.end(content);
        return;
      }
      throw new AppError(404, 'NOT_FOUND', 'Route not found.');
    } catch (error) {
      const safe = safeError(error, traceId);
      if (!response.headersSent && !response.destroyed) {
        if (safe.retryAfterSeconds !== undefined) response.setHeader('retry-after', String(safe.retryAfterSeconds));
        json(response, safe.status, safe.body);
      }
    } finally {
      if (demoSlot) demoActive -= 1;
      clearTimeout(timeout);
      console.log(JSON.stringify({ event: 'request', traceId, role: config.role, route, status: response.statusCode, durationMs: Date.now() - start }));
    }
  });
  server.requestTimeout = 50000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5000;
  return server;
}
