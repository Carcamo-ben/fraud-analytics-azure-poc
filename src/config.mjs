import { GUID, parseSourceSnapshotTime } from './validation.mjs';

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

function guids(value, name) {
  const parts = (value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.some((x) => !GUID.test(x))) throw new Error(`Invalid configuration: ${name}`);
  return new Set(parts);
}

function httpsUrl(value, name) {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Invalid HTTPS endpoint: ${name}`);
  return parsed.origin;
}

export function loadConfig(env = process.env) {
  const role = required(env, 'ROLE');
  if (!['web', 'broker', 'knowledge'].includes(role)) throw new Error('ROLE must be web, broker, or knowledge');
  const tenantId = required(env, 'TENANT_ID');
  const clientId = required(env, 'AZURE_CLIENT_ID');
  if (!GUID.test(tenantId) || !GUID.test(clientId)) throw new Error('Tenant and managed identity client IDs must be GUIDs');
  const sourceAsOf = required(env, 'SOURCE_AS_OF');
  if (!Number.isFinite(parseSourceSnapshotTime(sourceAsOf))) throw new Error('SOURCE_AS_OF must be a valid fixed UTC seed timestamp');
  const config = {
    role, port: Number(env.PORT ?? 8080), tenantId: tenantId.toLowerCase(), clientId,
    audience: required(env, 'API_AUDIENCE'), sourceAsOf,
    allowedUsers: guids(required(env, 'ALLOWED_USER_OIDS'), 'ALLOWED_USER_OIDS'),
    allowedCallers: role === 'web' ? new Set() : guids(required(env, 'ALLOWED_CALLER_OIDS'), 'ALLOWED_CALLER_OIDS'),
    policyOwnerOids: env.POLICY_OWNER_OIDS ? guids(env.POLICY_OWNER_OIDS, 'POLICY_OWNER_OIDS') : new Set(),
    productionEasyAuth: env.NODE_ENV === 'production' && Boolean(env.WEBSITE_SITE_NAME),
    brokerUrl: httpsUrl(env.BROKER_URL, 'BROKER_URL'),
    knowledgeUrl: httpsUrl(env.KNOWLEDGE_URL, 'KNOWLEDGE_URL'),
    sqlServer: env.SQL_SERVER, sqlDatabase: env.SQL_DATABASE ?? 'fraudpoc',
    openaiEndpoint: httpsUrl(env.OPENAI_ENDPOINT, 'OPENAI_ENDPOINT'),
    chatDeployment: env.CHAT_DEPLOYMENT, embeddingDeployment: env.EMBEDDING_DEPLOYMENT,
    modelVersion: env.MODEL_VERSION ?? 'unverified',
    searchEndpoint: httpsUrl(env.SEARCH_ENDPOINT, 'SEARCH_ENDPOINT'),
    searchIndex: env.SEARCH_INDEX ?? 'fraud-knowledge-v1',
    knowledgeMode: env.KNOWLEDGE_MODE ?? 'hybrid',
    storageAccountUrl: httpsUrl(env.STORAGE_ACCOUNT_URL, 'STORAGE_ACCOUNT_URL'),
    evidenceContainer: env.EVIDENCE_CONTAINER ?? 'evidence',
    requestTimeoutMs: 45000,
    publicDemo: env.PUBLIC_DEMO_ENABLED === 'true',
    demoUserOid: env.PUBLIC_DEMO_USER_OID?.trim().toLowerCase(),
  };
  if (env.PUBLIC_DEMO_ENABLED && !['true', 'false'].includes(env.PUBLIC_DEMO_ENABLED)) throw new Error('PUBLIC_DEMO_ENABLED must be true or false');
  if (config.publicDemo && (role !== 'web' || env.PUBLIC_DEMO_DATASET !== 'azure-sql-synthetic-fraud-v1' ||
      env.SQL_DATABASE !== 'fraudpoc' || sourceAsOf !== '2026-10-01T00:00:00Z' ||
      !GUID.test(config.demoUserOid ?? '') || !config.allowedUsers.has(config.demoUserOid) ||
      config.policyOwnerOids.has(config.demoUserOid))) {
    throw new Error('Public access is supported only for the explicitly configured read-only synthetic demo');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT');
  if (role === 'web' && (!config.brokerUrl || !config.knowledgeUrl || !config.storageAccountUrl)) throw new Error('Web requires broker, knowledge, and evidence endpoints');
  if (role === 'broker' && (!config.sqlServer || !/^[a-z0-9.-]+\.database\.windows\.net$/i.test(config.sqlServer))) throw new Error('Broker requires an Azure SQL Database server');
  if (role === 'knowledge' && !config.searchEndpoint) throw new Error('Knowledge requires Search');
  if (!['hybrid', 'keyword-only'].includes(config.knowledgeMode)) throw new Error('KNOWLEDGE_MODE must be hybrid or keyword-only');
  if (role === 'knowledge' && config.knowledgeMode === 'hybrid' && (!config.openaiEndpoint || !config.embeddingDeployment)) throw new Error('Hybrid requires a configured embedding deployment; explicitly configure keyword-only otherwise');
  return Object.freeze(config);
}
