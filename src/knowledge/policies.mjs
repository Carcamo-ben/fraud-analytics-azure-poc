import { createHash } from 'node:crypto';
import { unavailable } from '../errors.mjs';
import { parseDate, validateQuery, POLICY_SUBJECTS, POLICY_CHANNELS, POLICY_PROVINCES } from '../validation.mjs';
import { syntheticPolicyManifest } from './policy-manifest.mjs';

export { POLICY_SUBJECTS, POLICY_CHANNELS, POLICY_PROVINCES } from '../validation.mjs';
export const MAX_POLICY_CHUNKS = 64;
const ROLES = ['analyst', 'PolicyOwner'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (value) => `${value.policyId}|${value.version}`;
const fail = () => { throw unavailable('Synthetic policy manifest validation'); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const id = (value, max = 100) => text(value, max) && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
const date = (value) => typeof value === 'string' && /^(20\d{2}|2100)-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const containsScope = (broad, narrow) => ['businessUnit', 'subject', 'channel', 'province'].every((field) => broad[field] === '*' || broad[field] === narrow[field]);

export function createPolicySnapshot(input) {
  if (!exact(input, ['schemaVersion', 'policySetVersion', 'policies', 'access', 'scenarios']) ||
      input.schemaVersion !== 'synthetic-policy-manifest-v1' || !id(input.policySetVersion, 80) ||
      !Array.isArray(input.policies) || !input.policies.length || input.policies.length > 48 ||
      !Array.isArray(input.access) || input.access.length > 16 ||
      !Array.isArray(input.scenarios) || input.scenarios.length > 16 ||
      Buffer.byteLength(JSON.stringify(input)) > 262144) fail();
  const manifest = structuredClone(input), versions = new Map(), subjects = new Map(), chunks = new Set(), access = new Map();
  for (const item of manifest.access) {
    if (!exact(item, ['policyId', 'allowedRoles']) || !id(item.policyId) || access.has(item.policyId) ||
        !Array.isArray(item.allowedRoles) || !item.allowedRoles.length || item.allowedRoles.length > 2 ||
        new Set(item.allowedRoles).size !== item.allowedRoles.length || item.allowedRoles.some((role) => !ROLES.includes(role))) fail();
    access.set(item.policyId, item.allowedRoles);
  }
  for (const item of manifest.policies) {
    if (!exact(item, ['policyId', 'documentId', 'title', 'version', 'approvalStatus', 'publishedAt', 'approvedAt', 'effectiveFrom', 'effectiveTo', 'scope', 'supersedes', 'owner', 'chunks']) ||
        !id(item.policyId) || !id(item.documentId) || !text(item.title, 180) || !id(item.version, 30) ||
        !['approved', 'draft', 'withdrawn'].includes(item.approvalStatus) || !instant(item.publishedAt) ||
        (item.approvalStatus === 'approved' ? !instant(item.approvedAt) : item.approvedAt !== null) ||
        !date(item.effectiveFrom) || (item.effectiveTo !== null && (!date(item.effectiveTo) || item.effectiveTo <= item.effectiveFrom)) ||
        !text(item.owner, 120) || !access.has(item.policyId) || versions.has(key(item)) ||
        !exact(item.scope, ['businessUnit', 'subject', 'channel', 'province']) || item.scope.businessUnit !== 'poc' ||
        !POLICY_SUBJECTS.includes(item.scope.subject) || !['*', ...POLICY_CHANNELS].includes(item.scope.channel) ||
        !['*', ...POLICY_PROVINCES].includes(item.scope.province) ||
        !Array.isArray(item.supersedes) || item.supersedes.length > 8 || !Array.isArray(item.chunks) || !item.chunks.length || item.chunks.length > 4) fail();
    if (subjects.has(item.scope.subject) && subjects.get(item.scope.subject) !== item.policyId) fail();
    subjects.set(item.scope.subject, item.policyId);
    for (const chunk of item.chunks) {
      if (!exact(chunk, ['chunkId', 'content']) || !id(chunk.chunkId) || chunks.has(chunk.chunkId) ||
          typeof chunk.content !== 'string' || !chunk.content.trim() || chunk.content.length > 4000) fail();
      chunks.add(chunk.chunkId);
    }
    versions.set(key(item), item);
  }
  if (chunks.size > MAX_POLICY_CHUNKS || [...access.keys()].some((policyId) => !manifest.policies.some((item) => item.policyId === policyId))) fail();
  for (const item of manifest.policies) {
    const seen = new Set();
    for (const ref of item.supersedes) {
      const target = versions.get(key(ref));
      if (!exact(ref, ['policyId', 'version']) || !id(ref.policyId) || !id(ref.version, 30) ||
          seen.has(key(ref)) || !target || ref.policyId !== item.policyId || item.approvalStatus !== 'approved' ||
          target.approvalStatus !== 'approved' || !containsScope(target.scope, item.scope) ||
          item.effectiveFrom < target.effectiveFrom) fail();
      seen.add(key(ref));
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(item) {
    if (visiting.has(key(item))) fail();
    if (visited.has(key(item))) return;
    visiting.add(key(item));
    item.supersedes.forEach((ref) => visit(versions.get(key(ref))));
    visiting.delete(key(item)); visited.add(key(item));
  }
  manifest.policies.forEach(visit);
  const scenarioIds = new Set();
  for (const item of manifest.scenarios) {
    if (!exact(item, ['id', 'title', 'description', 'policyId', 'query']) || !id(item.id) || scenarioIds.has(item.id) ||
        !text(item.title, 180) || !text(item.description, 600) || !access.has(item.policyId) ||
        !item.query || Object.keys(item.query).some((field) => !['q', 'subject', 'asOf', 'channel', 'province'].includes(field)) ||
        !text(item.query.q, 400) || !date(item.query.asOf) || subjects.get(item.query.subject) !== item.policyId ||
        (item.query.channel !== undefined && !POLICY_CHANNELS.includes(item.query.channel)) ||
        (item.query.province !== undefined && !POLICY_PROVINCES.includes(item.query.province))) fail();
    scenarioIds.add(item.id);
  }
  const snapshotHash = hash(JSON.stringify(manifest));
  const documents = manifest.policies.flatMap((item) => item.chunks.map((chunk) => ({
    docId: item.documentId, title: item.title, version: item.version, ...chunk,
    domain: 'fraud', allowedRoles: access.get(item.policyId),
    policyId: item.policyId, approvalStatus: item.approvalStatus, publishedAt: item.publishedAt, approvedAt: item.approvedAt,
    effectiveFrom: `${item.effectiveFrom}T00:00:00Z`, effectiveTo: item.effectiveTo ? `${item.effectiveTo}T00:00:00Z` : null,
    scopeBusinessUnit: item.scope.businessUnit, scopeSubject: item.scope.subject, scopeChannel: item.scope.channel, scopeProvince: item.scope.province,
    supersedes: item.supersedes.map(key), owner: item.owner, contentSha256: hash(chunk.content),
    policySetVersion: manifest.policySetVersion, snapshotHash,
  })));
  return freeze({ ...manifest, snapshotHash, indexName: `fraud-policy-${snapshotHash.slice(0, 16)}`, documents });
}

export const POLICY_SNAPSHOT = createPolicySnapshot(syntheticPolicyManifest);
export function authorizedPolicies(snapshot, user) {
  const roles = [...new Set(user?.roles ?? [])].filter((role) => ROLES.includes(role));
  if (user?.businessUnit !== 'poc' || !roles.length) throw unavailable('Knowledge authorization scope');
  const allowed = new Set(snapshot.access.filter((item) => item.allowedRoles.some((role) => roles.includes(role))).map((item) => item.policyId));
  return snapshot.policies.filter((item) => allowed.has(item.policyId));
}

export function subjectsForQuery(query) {
  if (query.subject) return [query.subject];
  const q = query.q.toLowerCase();
  const subjects = [];
  if (/\br017\b/.test(q)) subjects.push('r017-rule');
  if (/\bloss(?:es)?\b|\bnet fraud\b/.test(q)) subjects.push('loss-kpi');
  if (/false.?positive|alert|fp share/.test(q)) subjects.push('alert-share-kpi');
  if (/investigation|sop/.test(q)) subjects.push('investigation-sop');
  if (/dictionary/.test(q)) subjects.push('r017-dictionary');
  if (/overlap/.test(q)) subjects.push('overlap-demo');
  if (/expired/.test(q)) subjects.push('expired-demo');
  if (/restricted|governance|appendix/.test(q)) subjects.push('restricted-governance');
  if (!subjects.length && /\bkpi\b/.test(q)) subjects.push('loss-kpi', 'alert-share-kpi');
  return [...new Set(subjects)];
}

const knownAt = (item, evaluatedAt) => item.approvalStatus === 'approved' &&
  Date.parse(item.publishedAt) <= Date.parse(evaluatedAt) && Date.parse(item.approvedAt) <= Date.parse(evaluatedAt);
const effective = (item, asOf) => item.effectiveFrom <= asOf && (!item.effectiveTo || asOf < item.effectiveTo);
const outcome = (decisions) => decisions.some((item) => item.status === 'conflict') ? 'conflict'
  : !decisions.length || decisions.some((item) => item.status === 'no-applicable-policy') ? 'no-applicable-policy' : 'resolved';
function reference(item) {
  return { policyId: item.policyId, documentId: item.documentId, title: item.title, version: item.version,
    effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, publishedAt: item.publishedAt, approvedAt: item.approvedAt,
    approvalStatus: item.approvalStatus, owner: item.owner, supersedes: item.supersedes };
}
function resolveAt(snapshot, user, query, subjects, evaluatedAt) {
  parseDate(query.asOf);
  const visible = authorizedPolicies(snapshot, user);
  const approved = visible.filter((item) => knownAt(item, evaluatedAt));
  const versions = new Map(approved.map((item) => [key(item), item]));
  function supersedes(item, target, cell, seen = new Set()) {
    if (seen.has(key(item))) return false;
    seen.add(key(item));
    return item.supersedes.some((ref) => {
      const ancestor = versions.get(key(ref));
      return ancestor && containsScope(ancestor.scope, cell) && (key(ref) === key(target) || supersedes(ancestor, target, cell, seen));
    });
  }
  const decisions = [], conflicts = [];
  for (const subject of subjects) {
    const relevant = approved.filter((item) => item.scope.subject === subject && effective(item, query.asOf));
    const channels = query.channel ? [query.channel] : ['*', ...new Set(relevant.map((item) => item.scope.channel).filter((v) => v !== '*'))];
    const provinces = query.province ? [query.province] : ['*', ...new Set(relevant.map((item) => item.scope.province).filter((v) => v !== '*'))];
    for (const channel of channels) for (const province of provinces) {
      const scope = { businessUnit: 'poc', subject, channel, province,
        ...(channel === '*' && channels.length > 1 ? { excludedChannels: channels.slice(1) } : {}),
        ...(province === '*' && provinces.length > 1 ? { excludedProvinces: provinces.slice(1) } : {}) };
      const candidates = relevant.filter((item) => containsScope(item.scope, scope));
      const winners = candidates.filter((candidate) => candidates.every((other) => key(other) === key(candidate) || supersedes(candidate, other, scope)));
      if (winners.length === 1) decisions.push({ status: 'resolved', subject, scope, ...reference(winners[0]) });
      else if (!candidates.length) decisions.push({ status: 'no-applicable-policy', subject, scope, reason: 'No authorized approved effective version applies.' });
      else {
        const conflict = { subject, scope, reason: 'Approved effective versions overlap without approved scoped precedence.', versions: candidates.map(reference) };
        conflicts.push(conflict);
        decisions.push({ status: 'conflict', subject, scope, reason: conflict.reason });
      }
    }
  }
  return { status: outcome(decisions), decisions, conflicts };
}
function envelope(snapshot, evaluatedAt) {
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw unavailable('Policy evaluation timestamp');
  return { evaluatedAt, policySetVersion: snapshot.policySetVersion, snapshotHash: snapshot.snapshotHash, registry: 'synthetic-policy-manifest' };
}

export function resolvePolicies(snapshot, user, query, evaluatedAt = new Date().toISOString()) {
  return { ...envelope(snapshot, evaluatedAt), asOf: query.asOf,
    ...resolveAt(snapshot, user, query, subjectsForQuery(query), evaluatedAt) };
}

export function resolveComparison(snapshot, user, value, evaluatedAt = new Date().toISOString()) {
  const params = validateQuery(value);
  const subjects = params.kind === 'loss_comparison' ? ['loss-kpi'] : ['alert-share-kpi', 'r017-rule', 'investigation-sop'];
  const relevant = authorizedPolicies(snapshot, user).filter((item) => subjects.includes(item.scope.subject) && knownAt(item, evaluatedAt));
  const segments = [];
  for (const period of ['previous', 'current']) {
    const { start, end } = params[period];
    const boundaries = [...new Set([start, end, ...relevant.flatMap((item) => [item.effectiveFrom, item.effectiveTo]).filter((day) => day && day > start && day < end)])].sort();
    for (let i = 0; i < boundaries.length - 1; i++) {
      const segment = { period, start: boundaries[i], end: boundaries[i + 1] };
      segments.push({ ...segment, ...resolveAt(snapshot, user, { asOf: segment.start }, subjects, evaluatedAt) });
    }
  }
  if (segments.length > 32) throw unavailable('Policy segment budget');
  const decisions = segments.flatMap((segment) => segment.decisions.map((item) => ({ period: segment.period, start: segment.start, end: segment.end, ...item })));
  if (decisions.length > 128) throw unavailable('Policy decision budget');
  return { ...envelope(snapshot, evaluatedAt), status: outcome(decisions), periods: { previous: params.previous, current: params.current },
    segments, decisions, conflicts: segments.flatMap((segment) => segment.conflicts.map((item) => ({ period: segment.period, start: segment.start, end: segment.end, ...item }))) };
}

export function policyCatalog(snapshot, user, evaluatedAt = new Date().toISOString()) {
  const visible = authorizedPolicies(snapshot, user);
  const ids = new Set(visible.map((item) => item.policyId));
  return { status: 'available', synthetic: true, ...envelope(snapshot, evaluatedAt),
    policies: visible.map((item) => ({ ...reference(item), scope: item.scope })),
    scenarios: snapshot.scenarios.filter((item) => ids.has(item.policyId)),
    limitations: ['Entirely fictional PoC policies; not actual Rogers policy or legal guidance.', 'Current ACLs apply even to historical dates.',
      'Publication does not confer precedence. Effective end dates are exclusive.', 'A validated synthetic manifest is the authority; this is not a live Fabric registry.'] };
}
