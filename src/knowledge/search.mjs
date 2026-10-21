import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDate, validateKnowledgeQuery, validateQuery } from '../validation.mjs';
import { unavailable } from '../errors.mjs';
import { POLICY_SNAPSHOT, MAX_POLICY_CHUNKS, authorizedPolicies, resolvePolicies, resolveComparison, policyCatalog } from './policies.mjs';

export const MAX_SOURCES = 4;
export const MAX_EXCERPT_CHARS = 1100;
export const MAX_TOTAL_EXCERPT_CHARS = 4000;
export const SEARCH_API_VERSION = '2024-07-01';
export const POLICY_CLOCK_SKEW_MS = 5000;
export const SEARCH_METADATA_FIELDS = [
  'chunkId', 'docId', 'title', 'version', 'effectiveFrom', 'effectiveTo', 'allowedRoles', 'domain',
  'policyId', 'approvalStatus', 'publishedAt', 'approvedAt', 'scopeBusinessUnit', 'scopeSubject', 'scopeChannel', 'scopeProvince',
  'supersedes', 'owner', 'contentSha256', 'policySetVersion', 'snapshotHash',
];
const key = (value) => `${value.policyId}|${value.version}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const dateFields = new Set(['effectiveFrom', 'effectiveTo', 'publishedAt', 'approvedAt']);

export function buildFilter(user, asOf, { snapshot = POLICY_SNAPSHOT, chunkIds } = {}) {
  authorizedPolicies(snapshot, user);
  const roles = [...new Set(user.roles)].filter((role) => ['analyst', 'PolicyOwner'].includes(role));
  const filters = [`domain eq 'fraud'`, `scopeBusinessUnit eq 'poc'`, `approvalStatus eq 'approved'`,
    `policySetVersion eq '${snapshot.policySetVersion}'`, `snapshotHash eq '${snapshot.snapshotHash}'`,
    `allowedRoles/any(r: search.in(r, '${roles.join(',')}', ','))`];
  if (asOf !== null) {
    parseDate(asOf);
    filters.push(`effectiveFrom le ${asOf}T00:00:00Z`, `(effectiveTo eq null or effectiveTo gt ${asOf}T00:00:00Z)`);
  }
  if (chunkIds) {
    if (!chunkIds.length || chunkIds.length > MAX_POLICY_CHUNKS ||
        chunkIds.some((id) => !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(id))) throw unavailable('Resolved policy chunk filter');
    filters.push(`search.in(chunkId, '${chunkIds.join(',')}', ',')`);
  }
  return filters.join(' and ');
}

export function validateIndexedMetadata(doc, expected) {
  if (!doc || !expected) throw unavailable('Policy index membership');
  for (const field of SEARCH_METADATA_FIELDS) {
    const actual = doc[field], wanted = expected[field];
    const matches = dateFields.has(field)
      ? wanted === null ? actual === null : typeof actual === 'string' && Number.isFinite(Date.parse(actual)) && Date.parse(actual) === Date.parse(wanted)
      : Array.isArray(wanted)
        ? Array.isArray(actual) && actual.length === wanted.length && actual.every((value) => typeof value === 'string') &&
          [...actual].sort().join('\0') === [...wanted].sort().join('\0')
        : actual === wanted;
    if (!matches) throw unavailable('Policy index snapshot coherence');
  }
}

export function validateIndexInventory(result, snapshot = POLICY_SNAPSHOT) {
  if (!result || !Array.isArray(result.value) || result.value.length !== snapshot.documents.length ||
      result['@odata.count'] !== snapshot.documents.length || result['@odata.nextLink'] || result['@search.nextPageParameters'] ||
      result.value.length > MAX_POLICY_CHUNKS) throw unavailable('Complete policy index snapshot');
  const expected = new Map(snapshot.documents.map((doc) => [doc.chunkId, doc])), seen = new Set();
  for (const doc of result.value) {
    if (seen.has(doc.chunkId)) throw unavailable('Unique policy index inventory');
    validateIndexedMetadata(doc, expected.get(doc.chunkId));
    seen.add(doc.chunkId);
  }
}

export function citationsFromResults(values, user, asOf, { snapshot = POLICY_SNAPSHOT, resolution } = {}) {
  if (!Array.isArray(values) || values.length > MAX_SOURCES) throw unavailable('Search result budget');
  const authorized = new Set(authorizedPolicies(snapshot, user).map(key));
  let remaining = MAX_TOTAL_EXCERPT_CHARS;
  const seen = new Set();
  return values.map((doc) => {
    const expected = snapshot.documents.find((item) => item.chunkId === doc.chunkId);
    validateIndexedMetadata(doc, expected);
    if (seen.has(doc.chunkId) || !authorized.has(key(doc)) || typeof doc.content !== 'string' || !doc.content ||
        doc.content.length > 4000 || hash(doc.content) !== expected.contentSha256) throw unavailable('Search authorization and content validation');
    seen.add(doc.chunkId);
    const applicable = resolution ?? resolvePolicies(snapshot, user, {
      q: '', subject: expected.scopeSubject, asOf,
    });
    const decisions = applicable.decisions.filter((item) => item.status === 'resolved' && key(item) === key(doc));
    if (!decisions.length) throw unavailable('Resolved policy citation validation');
    const excerpt = doc.content.slice(0, Math.min(MAX_EXCERPT_CHARS, remaining));
    remaining -= excerpt.length;
    const citationId = `cite-${hash(`${doc.docId}|${doc.version}|${doc.chunkId}`).slice(0, 20)}`;
    return { citationId, policyId: doc.policyId, documentId: doc.docId, title: doc.title, version: doc.version,
      effectiveFrom: expected.effectiveFrom.slice(0, 10), effectiveTo: expected.effectiveTo?.slice(0, 10) ?? null,
      chunkId: doc.chunkId, excerpt,
      appliesTo: decisions.map((item) => ({ ...(item.period ? { period: item.period, start: item.start, end: item.end } : { asOf: applicable.asOf }), scope: item.scope })) };
  });
}

function sourceCoverage(resolution, sources) {
  const resolvedVersions = new Set(resolution.decisions.filter((item) => item.status === 'resolved').map(key)).size;
  const citedVersions = new Set(sources.map(key)).size;
  return { allPolicyMetadataEvaluated: true, maxSources: MAX_SOURCES,
    resolvedVersions, citedVersions, omittedResolvedVersions: resolvedVersions - citedVersions };
}

function validateEvaluationWindow(value, window) {
  // Stored evidence is replayed at its recorded time; only live exchanges supply a window.
  if (window === undefined) return;
  const timestamp = Date.parse(value);
  const canonical = typeof value === 'string' && value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical ||
      !Number.isSafeInteger(window?.startedAt) || !Number.isSafeInteger(window?.completedAt) ||
      window.completedAt < window.startedAt ||
      timestamp < window.startedAt - POLICY_CLOCK_SKEW_MS || timestamp > window.completedAt + POLICY_CLOCK_SKEW_MS) {
    throw unavailable('Fresh policy evaluation window');
  }
}

export function validateKnowledgeResponse(value, user, { snapshot = POLICY_SNAPSHOT, query, request, evaluationWindow } = {}) {
  const resolution = value?.policyResolution;
  if (value?.status !== 'available' || !['hybrid', 'keyword-only'].includes(value.mode) ||
      !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES ||
      typeof resolution?.evaluatedAt !== 'string' || resolution.evaluatedAt.length > 40 ||
      !Number.isFinite(Date.parse(resolution.evaluatedAt))) throw unavailable('Authoritative policy response contract');
  validateEvaluationWindow(resolution.evaluatedAt, evaluationWindow);
  const expected = request ? resolveComparison(snapshot, user, request, resolution.evaluatedAt)
    : resolvePolicies(snapshot, user, query, resolution.evaluatedAt);
  if (!isDeepStrictEqual(resolution, expected)) throw unavailable('Complete authorized policy decisions');
  // Rebuild citations from immutable source content, not from private-service claims.
  const documents = value.sources.map((source) => {
    const doc = snapshot.documents.find((item) => item.chunkId === source?.chunkId);
    if (!doc) throw unavailable('Policy citation membership');
    return doc;
  });
  const sources = citationsFromResults(documents, user, expected.asOf, { snapshot, resolution: expected });
  if (!isDeepStrictEqual(value, { status: 'available', mode: value.mode, sources, policyResolution: expected,
    sourceCoverage: sourceCoverage(expected, sources) })) throw unavailable('Policy citations and coverage contract');
  return value;
}

export function validatePolicyCatalogResponse(value, user, snapshot = POLICY_SNAPSHOT, { evaluationWindow } = {}) {
  if (typeof value?.evaluatedAt !== 'string' || value.evaluatedAt.length > 40 ||
      !Number.isFinite(Date.parse(value.evaluatedAt)) ||
      !isDeepStrictEqual(value, policyCatalog(snapshot, user, value.evaluatedAt))) throw unavailable('Complete authorized policy catalog');
  validateEvaluationWindow(value.evaluatedAt, evaluationWindow);
  return value;
}

export function createKnowledge(config, azureJson, model, { snapshot = POLICY_SNAPSHOT, now = () => new Date() } = {}) {
  const endpoint = `${config.searchEndpoint}/indexes/${encodeURIComponent(config.searchIndex)}/docs/search?api-version=${SEARCH_API_VERSION}`;
  const search = (body, signal) => azureJson(endpoint, {
    scope: 'https://search.azure.com/.default', method: 'POST', body, signal, service: 'Azure AI Search',
  });
  async function inventory(signal) {
    if (config.searchIndex !== snapshot.indexName) throw unavailable('Activated version-specific policy index');
    const result = await search({ search: '*', top: MAX_POLICY_CHUNKS + 1, count: true, select: SEARCH_METADATA_FIELDS.join(',') }, signal);
    validateIndexInventory(result, snapshot);
  }
  async function retrieveResolved(q, user, resolution, signal) {
    const selected = new Set(resolution.decisions.filter((item) => item.status === 'resolved').map(key));
    const chunkIds = snapshot.documents.filter((doc) => selected.has(key(doc))).map((doc) => doc.chunkId);
    if (!['hybrid', 'keyword-only'].includes(config.knowledgeMode)) throw unavailable('Configured knowledge retrieval mode');
    let sources = [];
    if (chunkIds.length) {
      const body = { search: q, queryType: 'simple', searchMode: 'any', top: MAX_SOURCES,
        filter: buildFilter(user, resolution.asOf ?? null, { snapshot, chunkIds }),
        select: [...SEARCH_METADATA_FIELDS, 'content'].join(',') };
      if (config.knowledgeMode === 'hybrid') {
        body.vectorQueries = [{ kind: 'vector', vector: await model.embed(q, signal), fields: 'contentVector', k: 12 }];
        body.vectorFilterMode = 'preFilter';
      }
      const result = await search(body, signal);
      sources = citationsFromResults(result.value, user, resolution.asOf, { snapshot, resolution });
    }
    return { status: 'available', mode: config.knowledgeMode, sources, policyResolution: resolution,
      sourceCoverage: sourceCoverage(resolution, sources) };
  }
  return {
    async retrieve(value, user, signal) {
      const query = validateKnowledgeQuery(value);
      const resolution = resolvePolicies(snapshot, user, query, now().toISOString());
      await inventory(signal);
      return retrieveResolved(query.q, user, resolution, signal);
    },
    async compare(value, user, signal) {
      const params = validateQuery(value);
      const resolution = resolveComparison(snapshot, user, params, now().toISOString());
      await inventory(signal);
      return retrieveResolved(params.kind === 'rule_quality' ? 'R017 rule change alert false positive share investigation SOP' : 'Net fraud loss KPI booked CAD recognized recovered loss date', user, resolution, signal);
    },
    async catalog(user, signal) {
      const catalog = policyCatalog(snapshot, user, now().toISOString());
      await inventory(signal);
      return catalog;
    },
    async probe(signal) {
      const user = { businessUnit: 'poc', roles: ['analyst'] };
      const resolution = resolvePolicies(snapshot, user, { q: 'net fraud loss KPI', asOf: config.sourceAsOf.slice(0, 10) }, now().toISOString());
      await inventory(signal);
      const result = await retrieveResolved('net fraud loss KPI', user, resolution, signal);
      if (!result.sources.length) throw unavailable('Seeded authorized knowledge index');
      return { status: config.knowledgeMode === 'keyword-only' ? 'keyword-only' : 'ready',
        detail: `${config.knowledgeMode} retrieval and complete synthetic policy snapshot verified.`,
        policySetVersion: snapshot.policySetVersion, snapshotHash: snapshot.snapshotHash };
    },
  };
}
