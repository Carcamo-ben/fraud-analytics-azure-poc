import { BlobServiceClient } from '@azure/storage-blob';
import { GUID, MAX_RESPONSE_BYTES } from './validation.mjs';
import { AppError, unavailable } from './errors.mjs';
import { POLICY_SNAPSHOT, authorizedPolicies } from './knowledge/policies.mjs';

function authorizePolicyEvidence(answer, user, snapshot) {
  const visible = authorizedPolicies(snapshot, user);
  const policyIds = new Set(visible.map((item) => item.policyId));
  const resolution = answer?.knowledge?.policyResolution;
  const refs = [
    ...(answer?.knowledge?.sources ?? []), ...(resolution?.decisions ?? []),
    ...(resolution?.conflicts ?? []).flatMap((item) => item.versions ?? []),
    ...(resolution?.segments ?? []).flatMap((item) => [...(item.decisions ?? []), ...(item.conflicts ?? []).flatMap((conflict) => conflict.versions ?? [])]),
  ];
  for (const ref of refs) {
    if (ref.policyId ? !policyIds.has(ref.policyId)
      : ref.documentId ? !visible.some((item) => item.documentId === ref.documentId)
        : ref.title !== undefined || ref.excerpt !== undefined) {
      throw new AppError(403, 'EVIDENCE_SCOPE_FORBIDDEN', 'Current authorization does not permit access to this evidence artifact.');
    }
  }
}

function blobPath(user, id) {
  if (typeof user?.oid !== 'string' || typeof id !== 'string' || !GUID.test(user.oid) || !GUID.test(id)) {
    throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'Evidence is not available for this user.');
  }
  return `${user.oid.toLowerCase()}/${id.toLowerCase()}.json`;
}

export function createEvidence(config, credential, { container: injectedContainer, policySnapshot = POLICY_SNAPSHOT } = {}) {
  const container = injectedContainer ?? new BlobServiceClient(config.storageAccountUrl, credential, {
    retryOptions: { maxTries: 2, tryTimeoutInMs: 10000 },
  }).getContainerClient(config.evidenceContainer);
  return {
    async put(user, id, evidence, signal) {
      const content = JSON.stringify({ schemaVersion: 'evidence-v1', subjectOid: user.oid, ...evidence });
      if (Buffer.byteLength(content) > MAX_RESPONSE_BYTES) throw unavailable('Evidence byte budget');
      await container.getBlockBlobClient(blobPath(user, id)).upload(content, Buffer.byteLength(content), {
        abortSignal: signal, conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
      });
    },
    async get(user, id, signal) {
      const blob = container.getBlobClient(blobPath(user, id));
      const expectedSubject = user.oid.toLowerCase(), expectedId = id.toLowerCase();
      try {
        const download = await blob.download(0, undefined, { abortSignal: signal });
        if (download.contentLength > MAX_RESPONSE_BYTES) throw unavailable('Evidence byte budget');
        const chunks = [];
        let length = 0;
        for await (const chunk of download.readableStreamBody) {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) throw unavailable('Evidence byte budget');
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof data?.subjectOid !== 'string' || typeof data?.answer?.answerId !== 'string' ||
            data.subjectOid.toLowerCase() !== expectedSubject || data.answer.answerId.toLowerCase() !== expectedId) {
          throw unavailable('Evidence ownership validation');
        }
        // The stored artifact remains unchanged; revoked access withholds the entire read.
        authorizePolicyEvidence(data.answer, user, policySnapshot);
        return data;
      } catch (error) {
        if (error.statusCode === 404) throw new AppError(404, 'EVIDENCE_NOT_FOUND', 'Evidence is not available for this user.');
        throw error;
      }
    },
    async probe(signal) {
      await container.getProperties({ abortSignal: signal });
      return { status: 'ready', detail: 'Private evidence container reachable; each answer requires a successful write before return.' };
    },
  };
}
