import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, unavailable } from './errors.mjs';
import { exactObject, validateQuery, validateQuestion } from './validation.mjs';

export const PROMPT_VERSION = 'planner-v1';
const prompt = readFileSync(new URL('./prompts/planner-v1.txt', import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('./prompts/planner-v1.schema.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const PROMPT_SHA256 = hash(prompt);
export const RESPONSE_SCHEMA_SHA256 = hash(JSON.stringify(schema));
export const OPENAI_API_VERSION = '2024-10-21';
const parameters = Object.freeze({ temperature: 0, max_tokens: 600 });
const scope = 'https://cognitiveservices.azure.com/.default';
export const EMBEDDING_DIMENSIONS = 1536;

export function plannerRequestSha256(value) {
  const request = validatePlan({ supported: true, request: value, reason: 'approved' });
  return hash(JSON.stringify({ kind: request.kind, groupBy: request.groupBy,
    current: { start: request.current.start, end: request.current.end },
    previous: { start: request.previous.start, end: request.previous.end } }));
}

export function validatePlannerExecution(value, { request, question, deployment, configuredModelVersion } = {}) {
  const fields = ['schemaVersion', 'provider', 'apiVersion', 'deployment', 'configuredModelVersion', 'reportedModel',
    'completionId', 'completionCreatedAt', 'systemFingerprint', 'promptVersion', 'promptSha256', 'responseSchemaSha256',
    'responseSha256', 'requestSha256', 'questionSha256', 'parameters'];
  const identifier = (item) => typeof item === 'string' && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(item);
  const configured = value?.configuredModelVersion;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) ||
      value.schemaVersion !== 'planner-execution-v1' || value.provider !== 'azure-openai' ||
      value.apiVersion !== OPENAI_API_VERSION || !identifier(value.deployment) || value.deployment !== deployment ||
      !identifier(value.reportedModel) || !identifier(value.completionId) ||
      typeof configured !== 'string' || !configured.trim() || configured.length > 120 || /[\u0000-\u001f]/u.test(configured) ||
      (configuredModelVersion !== undefined && configured !== configuredModelVersion) ||
      typeof value.completionCreatedAt !== 'string' || !/^(20\d{2}|2100)-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value.completionCreatedAt) ||
      !Number.isFinite(Date.parse(value.completionCreatedAt)) ||
      new Date(value.completionCreatedAt).toISOString() !== value.completionCreatedAt ||
      (value.systemFingerprint !== null && !identifier(value.systemFingerprint)) ||
      value.promptVersion !== PROMPT_VERSION || value.promptSha256 !== PROMPT_SHA256 ||
      value.responseSchemaSha256 !== RESPONSE_SCHEMA_SHA256 || !isDeepStrictEqual(value.parameters, parameters) ||
      ['responseSha256', 'requestSha256', 'questionSha256'].some((field) => !/^[a-f0-9]{64}$/.test(value[field] ?? '')) ||
      value.requestSha256 !== plannerRequestSha256(request) ||
      (question !== undefined && value.questionSha256 !== hash(question))) throw unavailable('Planner execution provenance');
  return value;
}

export function validatePlan(value) {
  exactObject(value, ['supported', 'request', 'reason']);
  if (typeof value.supported !== 'boolean' || !['approved', 'unsupported', 'clarification_needed'].includes(value.reason)) throw unavailable('Planner validation');
  if (!value.supported) {
    if (value.request !== null || value.reason === 'approved') throw unavailable('Planner validation');
    throw new AppError(422, 'UNSUPPORTED_QUESTION', 'This question is outside the bounded aggregate analysis, or needs clarification. No numerical answer was generated.');
  }
  if (value.reason !== 'approved') throw unavailable('Planner validation');
  try { return validateQuery(value.request); }
  catch { throw unavailable('Planner output validation'); }
}

export function createModel(config, azureJson) {
  const deploymentUrl = (deployment, operation) =>
    `${config.openaiEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/${operation}?api-version=${OPENAI_API_VERSION}`;
  async function chat(messages, responseFormat, signal, maxTokens = 600) {
    if (!config.openaiEndpoint || !config.chatDeployment) throw unavailable('Canadian OpenAI planner');
    const result = await azureJson(deploymentUrl(config.chatDeployment, 'chat/completions'), {
      scope, method: 'POST', signal, service: 'Canadian OpenAI planner',
      body: { messages, temperature: 0, max_tokens: maxTokens, response_format: responseFormat },
    });
    if (result.choices?.length !== 1 || result.choices[0].finish_reason !== 'stop' || result.choices[0].message?.refusal) throw unavailable('Planner completion');
    return result;
  }
  return {
    async plan(question, signal) {
      validateQuestion(question);
      const result = await chat([
        { role: 'system', content: prompt },
        { role: 'user', content: question },
      ], { type: 'json_schema', json_schema: { name: 'fraud_plan_v1', strict: true, schema } }, signal);
      const content = result.choices[0].message.content;
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw unavailable('Planner JSON validation'); }
      const request = validatePlan(parsed);
      if (!Number.isSafeInteger(result.created) || result.created < 946684800 || result.created > 4133980799) throw unavailable('Planner completion timestamp');
      const provenance = validatePlannerExecution({
        schemaVersion: 'planner-execution-v1', provider: 'azure-openai', apiVersion: OPENAI_API_VERSION,
        deployment: config.chatDeployment, configuredModelVersion: config.modelVersion ?? 'unverified',
        reportedModel: result.model, completionId: result.id, completionCreatedAt: new Date(result.created * 1000).toISOString(),
        systemFingerprint: result.system_fingerprint ?? null,
        promptVersion: PROMPT_VERSION, promptSha256: PROMPT_SHA256, responseSchemaSha256: RESPONSE_SCHEMA_SHA256,
        responseSha256: hash(content), requestSha256: plannerRequestSha256(request), questionSha256: hash(question), parameters,
      }, { request, question, deployment: config.chatDeployment, configuredModelVersion: config.modelVersion ?? 'unverified' });
      return { request, provenance };
    },
    async embed(text, signal) {
      if (!config.openaiEndpoint || !config.embeddingDeployment) throw unavailable('Canadian embedding model');
      if (typeof text !== 'string' || text.length > 8000) throw unavailable('Embedding input budget');
      const result = await azureJson(deploymentUrl(config.embeddingDeployment, 'embeddings'), {
        scope, method: 'POST', signal, service: 'Canadian embedding model',
        body: { input: text, dimensions: EMBEDDING_DIMENSIONS },
      });
      const vector = result.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || vector.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw unavailable('Embedding vector validation');
      return vector;
    },
    async probe(signal) {
      const result = await chat([
        { role: 'system', content: 'Return only the JSON object {"ready":true}.' },
        { role: 'user', content: 'Dependency readiness probe.' },
      ], { type: 'json_object' }, signal, 32);
      const content = result.choices[0].message.content;
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw unavailable('Canadian model readiness'); }
      if (parsed.ready !== true) throw unavailable('Canadian model readiness');
      return { status: 'ready', detail: 'A live completion succeeded against the configured Canadian deployment.' };
    },
  };
}
