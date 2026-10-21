import { buildFixtures, SOURCE_AS_OF } from '../seed/fixtures.mjs';
import { calculate } from '../src/broker/metrics.mjs';
import { SCENARIOS } from '../src/web/services.mjs';

export const oid = '11111111-1111-4111-8111-111111111111';
export const secondOid = '22222222-2222-4222-8222-222222222222';
export const callerOid = '33333333-3333-4333-8333-333333333333';
export const tenantId = '44444444-4444-4444-8444-444444444444';
export const user = { oid, roles: ['analyst'], businessUnit: 'poc', displayName: 'Test analyst' };
export const config = {
  role: 'web', sourceAsOf: SOURCE_AS_OF, tenantId, audience: 'api://fraud-api',
  allowedUsers: new Set([oid]), allowedCallers: new Set([callerOid]), policyOwnerOids: new Set(),
  productionEasyAuth: true, brokerUrl: 'https://broker.example.invalid',
  knowledgeUrl: 'https://knowledge.example.invalid', chatDeployment: 'canadian-chat', modelVersion: 'test',
};
export const defaultQuery = structuredClone(SCENARIOS[0].request);

export function fixtureRows(params = defaultQuery) {
  const fixtures = buildFixtures();
  const input = params.kind === 'loss_comparison' ? fixtures.losses : fixtures.rules;
  const results = new Map();
  for (const source of input) {
    const period = source.periodStart >= params.current.start && source.periodStart < params.current.end ? 'current'
      : source.periodStart >= params.previous.start && source.periodStart < params.previous.end ? 'previous' : undefined;
    if (!period) continue;
    const group = source[params.groupBy];
    const key = `${group}|${source.ruleId ?? ''}|${period}`;
    const row = results.get(key) ?? {
      group, period, ...(source.ruleId ? { ruleId: source.ruleId, adjudicated: 0, falsePositives: 0 } : { loss: 0 }),
      cohortCount: 0, months: 1, sourceAsOfMin: SOURCE_AS_OF, sourceAsOfMax: SOURCE_AS_OF,
    };
    row.cohortCount += source.cohortCount;
    if (params.kind === 'loss_comparison') row.loss += source.lossCad;
    else { row.adjudicated += source.adjudicatedCount; row.falsePositives += source.falsePositiveCount; }
    results.set(key, row);
  }
  return [...results.values()];
}
export const resultFor = (query = defaultQuery) => calculate(query, fixtureRows(query), { sourceAsOf: SOURCE_AS_OF, traceId: oid });

export async function listening(server, callback) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
