import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../src/app.mjs';
import { calculate } from '../src/broker/metrics.mjs';
import { createEvidence } from '../src/evidence.mjs';
import { createKnowledge } from '../src/knowledge/search.mjs';
import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';
import { createWebServices } from '../src/web/services.mjs';
import { createDemoBudget } from '../src/public-demo.mjs';
import { AppError } from '../src/errors.mjs';
import { exactObject, validateKnowledgeQuery, validateQuery } from '../src/validation.mjs';
import { SOURCE_AS_OF } from '../seed/fixtures.mjs';
import { fixtureRows } from '../tests/helpers.mjs';
import { createLocalEvidenceContainer } from './local-evidence.mjs';
import { createLocalSearchTransport, LOCAL_SEARCH_ENDPOINT } from './local-fixture-transport.mjs';

export const LOCAL_USER = Object.freeze({
  oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', businessUnit: 'poc',
  roles: Object.freeze(['analyst']), displayName: 'Local synthetic analyst',
});
export const LOCAL_SOURCE_ID = 'local-synthetic-fixtures-fraud-v1';
export const LOCAL_SOURCE = Object.freeze({
  type: 'local-synthetic-fixtures',
  label: 'Local synthetic fixtures — not connected to Azure, Fabric or Foundry',
  asOf: SOURCE_AS_OF,
});
const MODEL_DETAIL = 'Unavailable in local preview: no language model, embeddings, OAuth, secrets or external calls.';
export const LOCAL_MODEL = Object.freeze({
  async probe() { return { status: 'unavailable', detail: MODEL_DETAIL }; },
  async plan() { throw new AppError(503, 'LOCAL_MODEL_UNAVAILABLE', MODEL_DETAIL); },
  async embed() { throw new AppError(503, 'LOCAL_MODEL_UNAVAILABLE', MODEL_DETAIL); },
});
const config = Object.freeze({
  role: 'web', publicDemo: true, sourceAsOf: SOURCE_AS_OF, requestTimeoutMs: 45000,
  brokerUrl: 'local-fixture://broker', knowledgeUrl: 'local-fixture://knowledge',
  searchEndpoint: LOCAL_SEARCH_ENDPOINT, searchIndex: POLICY_SNAPSHOT.indexName,
  knowledgeMode: 'keyword-only', chatDeployment: 'unavailable-local-preview', modelVersion: 'not-loaded',
});

export function assertLocalEnvironment(env = process.env) {
  if (env.NODE_ENV?.trim().toLowerCase() === 'production' ||
      ['WEBSITE_SITE_NAME', 'WEBSITE_INSTANCE_ID', 'CONTAINER_APP_NAME', 'CONTAINER_APP_REVISION',
        'KUBERNETES_SERVICE_HOST', 'ROLE'].some((name) => Boolean(env[name]))) {
    throw new Error('Local preview refuses production/cloud service environments. Run explicitly from a local development terminal.');
  }
}

function createLocalServiceCaller(knowledge) {
  return async (base, route, options = {}) => {
    exactObject(options, ['body', 'user', 'signal', 'traceId'], []);
    const { body, user, signal, traceId } = options;
    signal?.throwIfAborted();
    if (route === '/health/ready' && body === undefined) {
      if (base === config.brokerUrl) {
        return { service: { status: 'ready', detail: 'Local seed fixtures and production broker calculations; no SQL connection.' } };
      }
      if (base === config.knowledgeUrl) {
        const service = await knowledge.probe(signal);
        return { service: { ...service, detail: 'Local keyword-only fixture transport; production manifest, resolver and citation checks. No Azure Search or embeddings.' } };
      }
    }
    if (user !== LOCAL_USER) throw new AppError(403, 'LOCAL_IDENTITY_ONLY', 'Only the fixed local synthetic analyst is supported.');
    if (base === config.brokerUrl && route === '/v1/analytics/query' && body !== undefined) {
      const params = validateQuery(body);
      const result = calculate(params, fixtureRows(params), { sourceAsOf: SOURCE_AS_OF, traceId });
      return { ...result, sourceId: LOCAL_SOURCE_ID,
        evidenceIds: result.evidenceIds.map((id) => id.replace(/^sql:/, 'local-fixture:')),
        narrative: { ...result.narrative, caveats: result.narrative.caveats.map((item) =>
          item === 'Synthetic aggregate Azure SQL data only.' ? 'Local synthetic seed aggregates only; no live SQL query was executed.' : item) } };
    }
    if (base === config.knowledgeUrl && route === '/v1/knowledge/search' && body !== undefined) {
      return knowledge.retrieve(validateKnowledgeQuery(body), user, signal);
    }
    if (base === config.knowledgeUrl && route === '/v1/knowledge/compare' && body !== undefined) {
      return knowledge.compare(validateQuery(body), user, signal);
    }
    if (base === config.knowledgeUrl && route === '/v1/knowledge/policies' && body === undefined) {
      return knowledge.catalog(user, signal);
    }
    throw new AppError(503, 'LOCAL_SERVICE_CONTRACT', 'Unsupported local service path or method; no network fallback exists.');
  };
}

export async function startLocalPreview(options = {}) {
  assertLocalEnvironment();
  exactObject(options, ['port', 'evidenceDirectory'], ['evidenceDirectory']);
  const { port = 0, evidenceDirectory } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
  const container = await createLocalEvidenceContainer(evidenceDirectory);
  try {
    const knowledge = createKnowledge(config, createLocalSearchTransport(), LOCAL_MODEL);
    const evidence = createEvidence(config, undefined, { container });
    const originalProbe = evidence.probe;
    evidence.probe = async (signal) => {
      await originalProbe(signal);
      return { status: 'ready', detail: 'Dedicated local filesystem evidence; create-only files, bounded reads and current policy ACL checks. Not Azure Blob Storage.' };
    };
    const web = createWebServices(config, { call: createLocalServiceCaller(knowledge), model: LOCAL_MODEL, evidence,
      expectedBrokerSource: { id: LOCAL_SOURCE_ID, evidencePrefix: 'local-fixture:' } });
    const originalStatus = web.status;
    web.status = async (...args) => {
      const result = await originalStatus(...args);
      return { ...result, localPreview: true, source: LOCAL_SOURCE,
        limitations: [
          LOCAL_SOURCE.label,
          'Actual analyst UI and backend policy decisions; local keyword scoring does not emulate Azure Search ranking.',
          'Guided metrics use the existing seed aggregation helper and real broker calculate(); no SQL, Fabric, Azure Search, Foundry or embeddings are exercised.',
          'Natural-language planning is unavailable. Use the guided comparisons and effective-dated policy library.',
          'One fixed synthetic analyst; no OAuth. Only 127.0.0.1 is bound and no outbound transport is configured.',
          'Evidence is persisted in the explicitly selected local folder, not a cloud container. Existing evidence is never overwritten.',
          'Choose a dedicated nonsynced folder for evidence: filesystem backups or OneDrive synchronization are outside this process.',
          'Local readiness probes only; this is not deployment, SQL write-denial, scalability or cloud acceptance testing.',
          ...result.limitations.filter((item) => !item.startsWith('Readiness is based on live probes') &&
            !item.startsWith('No sign-in.') && !item.startsWith('Evidence is shared')),
        ] };
    };
    const budget = createDemoBudget({ filePath: path.join(container.directory, '.demo-budget.json') });
    let budgetPending = Promise.resolve();
    const demoBudget = () => {
      const operation = budgetPending.then(async () => { await container.checkBudgetFiles(); await budget(); });
      budgetPending = operation.catch(() => {});
      return operation;
    };
    let expectedHost;
    const server = createApplication(config, {
      web, demoBudget,
      authenticate: async (request) => {
        if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== expectedHost ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)) {
          throw new AppError(403, 'LOCAL_ORIGIN_ONLY', 'Use this preview only at its printed http://127.0.0.1 URL.');
        }
        return LOCAL_USER;
      },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    expectedHost = `127.0.0.1:${address.port}`;
    let stopping;
    const stop = () => {
      stopping ??= new Promise((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 5000);
        deadline.unref();
        server.close(async (error) => {
          clearTimeout(deadline);
          try { await budgetPending; await container.close(); }
          catch (closeError) { reject(closeError); return; }
          if (error) reject(error); else resolve();
        });
      });
      return stopping;
    };
    return { server, stop, url: `http://${expectedHost}`, port: address.port, evidenceDirectory: container.directory };
  } catch (error) {
    await container.close();
    throw error;
  }
}

export function parseArguments(args) {
  const result = { port: 0 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--port', '--evidence-directory'].includes(flag) || seen.has(flag)) throw new Error(`Unsupported or duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--port') {
      if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer from 0 to 65535.');
      result.port = Number(value);
    } else result.evidenceDirectory = value;
  }
  if (!result.evidenceDirectory) throw new Error('An explicit dedicated --evidence-directory is required.');
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('node .\\dev\\local-preview.mjs --evidence-directory "<dedicated-local-folder>" [--port 0]');
    console.log('Loopback only. Port 0 selects a free port. Ctrl+C / SIGINT / SIGTERM closes the server and preserves evidence.');
    console.log('Use a nonsynced local folder. Existing nonempty unmarked folders and concurrent instances using the same evidence folder are refused.');
  } else {
    try {
      const preview = await startLocalPreview(parseArguments(process.argv.slice(2)));
      console.log(JSON.stringify({ event: 'local-preview-listening', pid: process.pid, url: preview.url,
        evidenceDirectory: preview.evidenceDirectory, source: LOCAL_SOURCE.label,
        shutdown: 'Ctrl+C / SIGINT / SIGTERM; drains requests for up to five seconds, preserves evidence.' }));
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        try { await preview.stop(); console.log(JSON.stringify({ event: 'local-preview-stopped', signal })); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
