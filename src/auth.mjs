import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from './errors.mjs';
import { GUID } from './validation.mjs';

const unauthorized = () => new AppError(401, 'UNAUTHENTICATED', 'A verified organizational identity is required.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'This identity is not authorized for the synthetic PoC.');

export function scopedUser(oid, config, displayName) {
  if (!GUID.test(oid ?? '') || !config.allowedUsers.has(oid.toLowerCase())) throw forbidden();
  const normalized = oid.toLowerCase();
  return Object.freeze({
    oid: normalized, displayName: typeof displayName === 'string' ? displayName.slice(0, 100) : undefined,
    businessUnit: 'poc',
    roles: config.policyOwnerOids.has(normalized) ? ['analyst', 'PolicyOwner'] : ['analyst'],
  });
}

function onlyClaim(claims, types) {
  const values = [...new Set(claims.filter((c) => types.includes(c.typ)).map((c) => c.val))];
  return values.length === 1 ? values[0] : undefined;
}

export function authenticateEasyAuth(headers, config) {
  // This adapter is deliberately unavailable outside App Service's production boundary.
  if (!config.productionEasyAuth) throw unauthorized();
  const header = headers['x-ms-client-principal'];
  if (typeof header !== 'string' || header.length > 16384) throw unauthorized();
  let principal;
  try { principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { throw unauthorized(); }
  if (principal.auth_typ !== 'aad' || !Array.isArray(principal.claims)) throw unauthorized();
  const tenant = onlyClaim(principal.claims, ['tid', 'http://schemas.microsoft.com/identity/claims/tenantid']);
  const oid = onlyClaim(principal.claims, ['oid', 'http://schemas.microsoft.com/identity/claims/objectidentifier']);
  if (tenant?.toLowerCase() !== config.tenantId) throw forbidden();
  const name = onlyClaim(principal.claims, ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']);
  return scopedUser(oid, config, name);
}

export function createApiAuthenticator(config, verify = undefined) {
  const keys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`), {
    timeoutDuration: 5000, cooldownDuration: 30000,
  });
  const verifyToken = verify ?? ((token) => verifyApiToken(token, keys, config));
  return async (request, { health = false } = {}) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization) || authorization.length > 16384) throw unauthorized();
    let payload;
    try { ({ payload } = await verifyToken(authorization.slice(7))); }
    catch { throw unauthorized(); }
    if (payload.tid?.toLowerCase() !== config.tenantId || !GUID.test(payload.oid ?? '') ||
        !config.allowedCallers.has(payload.oid.toLowerCase()) || payload.scp) throw forbidden();
    if (health) return { callerOid: payload.oid.toLowerCase() };
    // Only the explicitly allowlisted frontend service identity may assert this user OID.
    // No caller-supplied role, business unit, group, or model role is trusted.
    const user = scopedUser(request.headers['x-fraud-user-oid'], config);
    return Object.freeze({ ...user, callerOid: payload.oid.toLowerCase() });
  };
}

export function verifyApiToken(token, keys, config) {
  const canonicalClientId = config.audience.startsWith('api://') ? config.audience.slice(6) : undefined;
  const audiences = canonicalClientId && GUID.test(canonicalClientId) ? [config.audience, canonicalClientId] : [config.audience];
  return jwtVerify(token, keys, {
    issuer: [`https://sts.windows.net/${config.tenantId}/`, `https://login.microsoftonline.com/${config.tenantId}/v2.0`],
    audience: audiences, algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'tid', 'oid', 'aud', 'iss'], clockTolerance: 5,
  });
}
