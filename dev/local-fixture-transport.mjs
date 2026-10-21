import { POLICY_SNAPSHOT, MAX_POLICY_CHUNKS } from '../src/knowledge/policies.mjs';
import { buildFilter, SEARCH_METADATA_FIELDS, SEARCH_API_VERSION, MAX_SOURCES } from '../src/knowledge/search.mjs';
import { exactObject, parseDate, validateQuestion } from '../src/validation.mjs';
import { AppError } from '../src/errors.mjs';

export const LOCAL_SEARCH_ENDPOINT = 'local-fixture://search';
export const LOCAL_SEARCH_URL = `${LOCAL_SEARCH_ENDPOINT}/indexes/${POLICY_SNAPSHOT.indexName}/docs/search?api-version=${SEARCH_API_VERSION}`;
const metadata = SEARCH_METADATA_FIELDS.join(',');
const reject = () => { throw new AppError(503, 'LOCAL_SEARCH_CONTRACT', 'Only bounded, generated local fixture search requests are supported.'); };
const project = (doc, fields) => Object.fromEntries(fields.map((field) => [field, structuredClone(doc[field])]));

// This is a local transport for the real resolver, not Azure Search or an embedding implementation.
export function createLocalSearchTransport() {
  return async (url, options) => {
    exactObject(options, ['scope', 'method', 'body', 'signal', 'service']);
    options.signal?.throwIfAborted();
    if (url !== LOCAL_SEARCH_URL || options.method !== 'POST' ||
        options.scope !== 'https://search.azure.com/.default' || options.service !== 'Azure AI Search') reject();
    const body = options.body;
    if (body?.count === true) {
      exactObject(body, ['search', 'top', 'count', 'select']);
      if (body.search !== '*' || body.top !== MAX_POLICY_CHUNKS + 1 || body.select !== metadata) reject();
      return { '@odata.count': POLICY_SNAPSHOT.documents.length,
        value: POLICY_SNAPSHOT.documents.map((doc) => project(doc, SEARCH_METADATA_FIELDS)) };
    }
    exactObject(body, ['search', 'queryType', 'searchMode', 'top', 'filter', 'select']);
    if (typeof body.search !== 'string' || body.search.length > 400 ||
        body.queryType !== 'simple' || body.searchMode !== 'any' || body.top !== MAX_SOURCES ||
        body.select !== `${metadata},content` || typeof body.filter !== 'string' || body.filter.length > 10000) reject();
    validateQuestion(body.search, { minLength: 1 });
    const roles = body.filter.match(/allowedRoles\/any\(r: search\.in\(r, '(analyst|PolicyOwner|analyst,PolicyOwner|PolicyOwner,analyst)', ','\)\)/)?.[1].split(',');
    const chunkIds = body.filter.match(/search\.in\(chunkId, '([a-zA-Z0-9._,-]+)', ','\)$/)?.[1].split(',');
    const asOf = body.filter.match(/effectiveFrom le (\d{4}-\d{2}-\d{2})T00:00:00Z/)?.[1] ?? null;
    if (!roles || !chunkIds || !chunkIds.length || chunkIds.length > MAX_POLICY_CHUNKS ||
        new Set(chunkIds).size !== chunkIds.length) reject();
    if (asOf) parseDate(asOf);
    const user = { businessUnit: 'poc', roles };
    if (body.filter !== buildFilter(user, asOf, { chunkIds })) reject();
    const documents = chunkIds.map((id) => POLICY_SNAPSHOT.documents.find((doc) => doc.chunkId === id));
    if (documents.some((doc) => !doc || doc.approvalStatus !== 'approved' ||
        !doc.allowedRoles.some((role) => roles.includes(role)) ||
        (asOf && (doc.effectiveFrom.slice(0, 10) > asOf || (doc.effectiveTo && doc.effectiveTo.slice(0, 10) <= asOf))))) reject();
    const words = [...new Set(body.search.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    const ranked = documents.map((doc) => {
      const content = `${doc.title} ${doc.content}`.toLowerCase();
      return { doc, score: words.filter((word) => content.includes(word)).length };
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.chunkId.localeCompare(b.doc.chunkId));
    return { value: ranked.slice(0, body.top).map(({ doc, score }) => ({
      ...project(doc, [...SEARCH_METADATA_FIELDS, 'content']), '@search.score': score,
    })) };
  };
}
