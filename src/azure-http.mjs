import { unavailable, AppError } from './errors.mjs';

export async function boundedJson(response, maxBytes = 131072) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw unavailable('Bounded upstream response');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw unavailable('Upstream JSON response'); }
}

export function createAzureHttp(credential, fetchImpl = fetch) {
  return async function azureJson(url, { scope, method = 'GET', body, headers = {}, signal, maxBytes = 131072, service = 'Azure dependency' } = {}) {
    const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
    const access = await credential.getToken(scope, { abortSignal: boundedSignal });
    if (!access?.token) throw unavailable(`${service} authentication`);
    const response = await fetchImpl(url, {
      method, redirect: 'error', signal: boundedSignal,
      headers: { 'content-type': 'application/json', ...headers, authorization: `Bearer ${access.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', `${service} returned HTTP ${response.status}; no substitute results were generated.`);
    }
    if (response.status === 204) return null;
    return boundedJson(response, maxBytes);
  };
}
