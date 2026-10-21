import { ManagedIdentityCredential } from '@azure/identity';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAzureHttp } from '../src/azure-http.mjs';
import { createModel, EMBEDDING_DIMENSIONS } from '../src/model.mjs';
import { SEARCH_API_VERSION, SEARCH_METADATA_FIELDS, validateIndexInventory } from '../src/knowledge/search.mjs';
import { POLICY_SNAPSHOT, MAX_POLICY_CHUNKS } from '../src/knowledge/policies.mjs';
import { policyIndexDefinition } from '../src/knowledge/search-schema.mjs';
import { GUID } from '../src/validation.mjs';

export async function ingestPolicyIndex({ endpoint, mode, indexName = POLICY_SNAPSHOT.indexName }, azureJson, model,
  { snapshot = POLICY_SNAPSHOT, wait = delay } = {}) {
  if (!/^https:\/\/[a-z0-9-]+\.search\.windows\.net\/?$/i.test(endpoint ?? '')) throw new Error('Azure AI Search endpoint required');
  if (indexName !== snapshot.indexName) throw new Error('Seed only the content-addressed policy index; never mutate an active legacy index');
  const index = policyIndexDefinition(snapshot, mode, EMBEDDING_DIMENSIONS);
  const scope = 'https://search.azure.com/.default';
  const values = [];
  for (const doc of snapshot.documents) {
    values.push({ '@search.action': 'upload', ...doc, ...(mode === 'hybrid' ? { contentVector: await model.embed(`${doc.title}\n${doc.content}`) } : {}) });
  }
  const base = `${endpoint.replace(/\/$/, '')}/indexes/${indexName}`;
  await azureJson(`${base}?api-version=${SEARCH_API_VERSION}`, {
    scope, method: 'PUT', headers: { 'if-none-match': '*' }, body: index, service: 'New immutable-name Search index creation',
  });
  const result = await azureJson(`${base}/docs/index?api-version=${SEARCH_API_VERSION}`, {
    scope, method: 'POST', body: { value: values }, service: 'Synthetic document ingestion',
  });
  if (result.value?.length !== snapshot.documents.length || result.value.some((item) => item.status !== true)) throw new Error('Not all synthetic chunks were indexed');
  for (let attempt = 0; attempt < 5; attempt++) {
    const inventory = await azureJson(`${base}/docs/search?api-version=${SEARCH_API_VERSION}`, {
      scope, method: 'POST', body: { search: '*', top: MAX_POLICY_CHUNKS + 1, count: true, select: SEARCH_METADATA_FIELDS.join(',') },
      service: 'Complete policy snapshot verification',
    });
    const stillIndexing = Array.isArray(inventory.value) && Number.isInteger(inventory['@odata.count']) &&
      inventory['@odata.count'] >= 0 && inventory['@odata.count'] < snapshot.documents.length &&
      inventory.value.length < snapshot.documents.length && !inventory['@odata.nextLink'] && !inventory['@search.nextPageParameters'];
    if (stillIndexing && attempt < 4) { await wait(1000); continue; }
    validateIndexInventory(inventory, snapshot);
    return { event: 'search_seed_complete', synthetic: true, chunks: snapshot.documents.length, mode,
      policySetVersion: snapshot.policySetVersion, snapshotHash: snapshot.snapshotHash, indexName,
      activation: 'Not activated. Separately set knowledge SEARCH_INDEX to this verified index with the matching application manifest, then require readiness before routing traffic. Retain the old index for rollback.',
      embeddingDimensions: mode === 'hybrid' ? EMBEDDING_DIMENSIONS : null };
  }
}

async function ingest() {
  if (!GUID.test(process.env.AZURE_CLIENT_ID ?? '')) throw new Error('Deployment managed identity client ID required');
  const mode = process.env.KNOWLEDGE_MODE ?? 'hybrid';
  if (!['hybrid', 'keyword-only'].includes(mode)) throw new Error('Unknown retrieval mode');
  const endpoint = process.env.SEARCH_ENDPOINT;
  if (!/^https:\/\/[a-z0-9-]+\.search\.windows\.net\/?$/i.test(endpoint ?? '')) throw new Error('Azure AI Search endpoint required');
  const config = { openaiEndpoint: process.env.OPENAI_ENDPOINT, embeddingDeployment: process.env.EMBEDDING_DEPLOYMENT };
  if (mode === 'hybrid' && (!config.openaiEndpoint || !config.embeddingDeployment)) throw new Error('Hybrid ingestion requires a Canadian embedding model');
  const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID });
  const azureJson = createAzureHttp(credential);
  const model = createModel(config, azureJson);
  console.log(JSON.stringify(await ingestPolicyIndex({ endpoint, mode, indexName: process.env.SEARCH_INDEX ?? POLICY_SNAPSHOT.indexName }, azureJson, model)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ingest().catch((error) => {
    console.error(JSON.stringify({
      event: 'search_seed_failed', code: error.code ?? 'INGEST_FAILED',
      ...(error.code === 'DEPENDENCY_UNAVAILABLE' ? { detail: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
