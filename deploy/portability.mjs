import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';
import { validateIndexInventory, SEARCH_METADATA_FIELDS } from '../src/knowledge/search.mjs';
import { policyIndexDefinition } from '../src/knowledge/search-schema.mjs';

export const GUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const CONFIG_FIELDS = ['subscriptionId', 'resourceGroup', 'location', 'aiLocation', 'authClientId',
  'allowedUserOid', 'sqlAdminObjectId', 'sqlAdminLogin', 'sqlAdminPrincipalType', 'ownerTag', 'reviewAfter',
  'chatModelName', 'chatModelVersion', 'chatCapacity', 'embeddingModelName', 'embeddingModelVersion',
  'embeddingCapacity', 'publicDemoEnabled', 'publicDemoUserOid'];
export function validateConfig(input) {
  assert(input && !Array.isArray(input) && typeof input === 'object', 'Configuration object required.');
  assert.deepEqual(Object.keys(input).sort(), [...CONFIG_FIELDS].sort(), 'Use exactly the documented customer.example.json fields.');
  const config = Object.fromEntries(CONFIG_FIELDS.map(key => [key, input[key]]));
  for (const field of ['subscriptionId', 'authClientId', 'allowedUserOid', 'sqlAdminObjectId']) {
    assert(GUID.test(config[field]), `${field} must be a nonzero UUID.`);
  }
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(config.resourceGroup), 'Use a simple resource group name (1-80 letters, digits, hyphens, underscores).');
  for (const field of ['location', 'aiLocation']) assert(['canadaeast', 'canadacentral'].includes(config[field]), `${field} must be Canadian.`);
  for (const field of ['sqlAdminLogin', 'ownerTag']) assert(typeof config[field] === 'string' && config[field].length > 0 && config[field].length <= 128 && !/[\x00-\x1f]/.test(config[field]), `${field} required.`);
  assert(['User', 'Group'].includes(config.sqlAdminPrincipalType), 'SQL administrator must be a customer User or Group.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(config.reviewAfter) && new Date(`${config.reviewAfter}T00:00:00Z`).toISOString().slice(0, 10) === config.reviewAfter, 'Review date must be YYYY-MM-DD.');
  for (const field of ['chatModelName', 'chatModelVersion', 'embeddingModelVersion']) assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(config[field]), `${field} invalid.`);
  assert.equal(config.embeddingModelName, 'text-embedding-3-small', 'Current runtime supports only this 1536-dimensional embedding model.');
  for (const field of ['chatCapacity', 'embeddingCapacity']) assert(Number.isInteger(config[field]) && config[field] >= 1 && config[field] <= 100, `${field} must be 1-100.`);
  assert.equal(typeof config.publicDemoEnabled, 'boolean', 'publicDemoEnabled must be an explicit boolean.');
  if (config.publicDemoEnabled) {
    assert(GUID.test(config.publicDemoUserOid) && ![config.allowedUserOid, config.sqlAdminObjectId, config.authClientId]
      .some(id => id.toLowerCase() === config.publicDemoUserOid.toLowerCase()), 'Public demo requires a distinct randomly generated synthetic user UUID (not an Entra user).');
  } else assert.equal(config.publicDemoUserOid, '', 'Private mode must not configure an anonymous identity.');
  return config;
}
export function assertLifecycle(state, config, phase) {
  assert.equal(state.configHash, sha256(JSON.stringify(validateConfig(config))), 'Configuration differs from pinned state.');
  assert(GUID.test(state.deploymentId), 'Invalid deployment ownership marker.');
  if (['finalized', 'aborted'].includes(state.phase)) {
    assert(['Status', 'Finalize', 'Abort'].includes(phase), 'Finalized bootstrap cannot be reactivated; use a new deployment.');
  }
}
export function assertOwned(resource, deploymentId, groupId) {
  assert.equal(resource.tags?.deploymentId, deploymentId, 'Resource is not owned by this deployment.');
  assert(typeof resource.id === 'string' && resource.id.toLowerCase().startsWith(`${groupId.toLowerCase()}/providers/`), 'Resource lies outside the deployment resource group.');
}
export function validateModels(config, records, usages, { existing = false } = {}) {
  for (const kind of ['chat', 'embedding']) {
    const model = records.map(record => record.model ?? record).find(model =>
      model.name === config[`${kind}ModelName`] && model.version === config[`${kind}ModelVersion`]);
    assert(model, `${kind} model/version not offered in ${config.aiLocation}.`);
    const sku = model.skus?.find(sku => sku.name === 'Standard');
    assert(sku, 'Regional Standard required; Global/DataZone fallback is forbidden.');
    const capacity = config[`${kind}Capacity`];
    if (sku.capacity?.minimum != null) assert(capacity >= sku.capacity.minimum, 'Capacity below minimum.');
    if (sku.capacity?.maximum != null) assert(capacity <= sku.capacity.maximum, 'Capacity above maximum.');
    if (sku.capacity?.step != null) assert((capacity - (sku.capacity.minimum ?? 0)) % sku.capacity.step === 0, 'Capacity step mismatch.');
    assert(sku.usageName, 'Model metadata has no quota name; cannot verify capacity safely.');
    const usage = usages.find(item => item.name?.value?.toLowerCase() === sku.usageName.toLowerCase());
    assert(usage && Number.isFinite(usage.limit) && Number.isFinite(usage.currentValue), 'Regional quota metadata unavailable.');
    if (!existing) assert(usage.limit - usage.currentValue >= capacity, 'Insufficient regional Standard quota. Request quota or choose an offered Canadian configuration.');
    if (model.deprecation?.inference) assert(Date.parse(model.deprecation.inference) > Date.now(), 'Model inference retirement has passed.');
  }
}
export function validateExistingSnapshot(schema, inventory, snapshot = POLICY_SNAPSHOT) {
  const wanted = policyIndexDefinition(snapshot, 'hybrid', 1536);
  assert.equal(schema.name, wanted.name, 'Index name mismatch.');
  assert.equal(schema.fields?.length, wanted.fields.length, 'Unexpected index fields.');
  for (const field of wanted.fields) {
    const actual = schema.fields.find(item => item.name === field.name);
    assert(actual, 'Missing index field.');
    for (const [key, value] of Object.entries(field)) assert.deepEqual(actual[key], value, `Index schema mismatch: ${field.name}.${key}`);
  }
  for (const expected of wanted.vectorSearch.algorithms) {
    const actual = schema.vectorSearch?.algorithms?.find(item => item.name === expected.name);
    assert.equal(actual?.kind, expected.kind);
    assert.equal(actual?.hnswParameters?.metric, expected.hnswParameters.metric);
  }
  for (const expected of wanted.vectorSearch.profiles) {
    const actual = schema.vectorSearch?.profiles?.find(item => item.name === expected.name);
    assert.equal(actual?.algorithm, expected.algorithm);
  }
  validateIndexInventory(inventory, snapshot);
  for (const doc of inventory.value) {
    const expected = snapshot.documents.find(item => item.chunkId === doc.chunkId);
    assert.equal(doc.content, expected.content, 'Existing index content mismatch; never silently overwrite.');
    assert.equal(sha256(doc.content), expected.contentSha256);
  }
}
export const INVENTORY_FIELDS = [...SEARCH_METADATA_FIELDS, 'content'];
export function checkedPollingUrl(location, origin) {
  const value = new URL(location, origin);
  assert(value.hostname === new URL(origin).hostname && !value.username && !value.password && !value.port &&
    ['http:', 'https:'].includes(value.protocol) && /^\/api\/deployments\/[a-z0-9-]+\/?$/i.test(value.pathname), 'Untrusted Kudu polling location.');
  return `${origin}${value.pathname}`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = validateConfig(JSON.parse(readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '')));
    if (['models', 'models-existing'].includes(process.argv[2])) {
      validateModels(config, JSON.parse(readFileSync(process.argv[4], 'utf8')), JSON.parse(readFileSync(process.argv[5], 'utf8')), { existing: process.argv[2] === 'models-existing' });
    } else assert.equal(process.argv[2], 'config');
    console.log(JSON.stringify({ config, configHash: sha256(JSON.stringify(config)), policyIndex: POLICY_SNAPSHOT.indexName, snapshotHash: POLICY_SNAPSHOT.snapshotHash }));
  } catch (error) { console.error(error.message.split('\n')[0]); process.exitCode = 1; }
}
