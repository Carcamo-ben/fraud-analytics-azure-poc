export function policyIndexDefinition(snapshot, mode, dimensions) {
  if (!['hybrid', 'keyword-only'].includes(mode)) throw new Error('Unknown retrieval mode');
  const fields = [
    { name: 'chunkId', type: 'Edm.String', key: true, filterable: true },
    { name: 'title', type: 'Edm.String', searchable: true },
    { name: 'content', type: 'Edm.String', searchable: true },
    ...['docId', 'version', 'domain', 'policyId', 'approvalStatus', 'scopeBusinessUnit', 'scopeSubject', 'scopeChannel', 'scopeProvince',
      'owner', 'contentSha256', 'policySetVersion', 'snapshotHash'].map((name) => ({ name, type: 'Edm.String', filterable: true })),
    ...['effectiveFrom', 'effectiveTo', 'publishedAt', 'approvedAt'].map((name) => ({ name, type: 'Edm.DateTimeOffset', filterable: true })),
    ...['allowedRoles', 'supersedes'].map((name) => ({ name, type: 'Collection(Edm.String)', filterable: true })),
  ];
  const index = { name: snapshot.indexName, fields };
  if (mode === 'hybrid') {
    fields.push({ name: 'contentVector', type: 'Collection(Edm.Single)', searchable: true, dimensions, vectorSearchProfile: 'fraud-hybrid-profile', retrievable: false });
    index.vectorSearch = {
      algorithms: [{ name: 'fraud-hnsw', kind: 'hnsw', hnswParameters: { metric: 'cosine' } }],
      profiles: [{ name: 'fraud-hybrid-profile', algorithm: 'fraud-hnsw' }],
    };
  }
  return index;
}
