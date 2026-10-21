import { invalid, AppError } from './errors.mjs';

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KINDS = ['loss_comparison', 'rule_quality'];
export const GROUPS = ['channel', 'merchant', 'province'];
export const MAX_BODY_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 131072;
export const POLICY_SUBJECTS = ['loss-kpi', 'alert-share-kpi', 'r017-rule', 'r017-dictionary', 'investigation-sop', 'overlap-demo', 'expired-demo', 'restricted-governance'];
export const POLICY_CHANNELS = ['Card-not-present', 'Digital wallet', 'Card-present'];
export const POLICY_PROVINCES = ['ON', 'QC', 'BC'];

export function exactObject(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw invalid('Only the documented request fields are permitted.');
  }
  return value;
}

export function parseDate(value) {
  if (typeof value !== 'string' || !/^(20\d{2}|2100)-\d{2}-\d{2}$/.test(value)) throw invalid('Use a valid YYYY-MM-DD date.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid('Use a valid calendar date.');
  return parsed;
}

export function parseSourceSnapshotTime(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return NaN;
    value = value.toISOString();
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/(?:\.000)?Z$/, '.000Z') ? time : NaN;
}

function period(value) {
  exactObject(value, ['start', 'end']);
  const start = parseDate(value.start), end = parseDate(value.end);
  if (start >= end || start.getUTCDate() !== 1 || end.getUTCDate() !== 1) {
    throw invalid('Periods must be complete calendar months with an exclusive end date.');
  }
  return { start, end, days: (end - start) / 86400000 };
}

export function validateQuery(value) {
  exactObject(value, ['kind', 'groupBy', 'current', 'previous']);
  if (!KINDS.includes(value.kind) || !GROUPS.includes(value.groupBy)) throw invalid('Unsupported metric or grouping.');
  const current = period(value.current), previous = period(value.previous);
  if (current.days + previous.days > 93 || previous.end > current.start) {
    throw invalid('Comparison periods cannot overlap and must total at most 93 days.');
  }
  return structuredClone(value);
}

export function monthCount(value) {
  const start = parseDate(value.start), end = parseDate(value.end);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
}

export function validateQuestion(value, { minLength = 8 } = {}) {
  if (typeof value !== 'string' || value.trim().length < minLength || value.length > 1000) throw invalid(`Question must contain ${minLength} to 1,000 characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid('Control characters are not permitted.');
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:\d[ -]?){12,19}\b|\b\d{3}[- .]\d{3}[- .]\d{4}\b|\b(?:sin|ssn|passport|cardholder|account number|card number|customer name|email address|phone number|raw_sql)\b/i.test(value)) {
    throw new AppError(400, 'PII_NOT_PERMITTED', 'Use synthetic aggregate questions only; identifying data is not permitted.');
  }
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|execute|exec|merge)\b|\bselect\b.{0,100}\bfrom\b|\bunion\s+select\b|\b(write|disable|enable|remove|modify)\s+(?:the\s+)?(rule|threshold|database|table|data)\b|\bchange\s+(?:the\s+)?(?:rule\s+\w+\s+)?threshold\b|\bignore\b.{0,50}\b(instructions|rules|previous)\b|\b(system prompt|developer message|jailbreak)\b/i.test(value)) {
    throw new AppError(400, 'UNSAFE_REQUEST', 'Only read-only aggregate fraud analysis is supported.');
  }
  return value.trim();
}

export function validateKnowledgeQuery(value) {
  exactObject(value, ['q', 'asOf', 'subject', 'channel', 'province'], ['q']);
  if (typeof value.q !== 'string' || !value.q.trim() || value.q.length > 400) throw invalid('Knowledge query must contain 1 to 400 characters.');
  validateQuestion(value.q, { minLength: 1 });
  const asOf = value.asOf ?? '2026-09-30';
  parseDate(asOf);
  const scope = {};
  for (const [field, allowed] of [['subject', POLICY_SUBJECTS], ['channel', POLICY_CHANNELS], ['province', POLICY_PROVINCES]]) {
    if (value[field] !== undefined) {
      if (!allowed.includes(value[field])) throw invalid('Unsupported policy subject or scope.');
      scope[field] = value[field];
    }
  }
  return { q: value.q.trim(), asOf, ...scope };
}

export async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new AppError(415, 'JSON_REQUIRED', 'Content-Type application/json is required.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request exceeds the 8 KiB limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('Request body must be valid JSON.'); }
}
