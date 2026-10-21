import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';

export const SOURCE_AS_OF = '2026-10-01T00:00:00Z';
export const MERCHANTS = ['Synthetic North Retail', 'Synthetic Maple Marketplace', 'Synthetic Pacific Travel'];
export const PROVINCES = ['ON', 'QC', 'BC'];
export const CHANNELS = ['Card-not-present', 'Digital wallet', 'Card-present'];
const weights = [0.5, 0.3, 0.2];
const distribution = MERCHANTS.flatMap((merchant, m) => PROVINCES.map((province, p) => ({ merchant, province, weight: weights[m] * weights[p] })));
const ruleDistribution = CHANNELS.flatMap((channel, c) => distribution.map((d) => ({ ...d, channel, weight: d.weight * weights[c] })));

export function allocate(total, distributionWeights) {
  const values = distributionWeights.map((weight) => Math.floor(total * weight));
  let remaining = total - values.reduce((sum, value) => sum + value, 0);
  const order = distributionWeights.map((weight, i) => ({ i, fraction: total * weight - values[i] })).sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let i = 0; i < remaining; i++) values[order[i % order.length].i]++;
  return values;
}

export function buildFixtures() {
  const losses = [], rules = [];
  for (const [periodStart, amounts] of [
    ['2026-08-01', [690000, 90000, 220000]], ['2026-09-01', [930000, 110000, 200000]],
  ]) {
    CHANNELS.forEach((channel, c) => {
      const cents = allocate(amounts[c] * 100, distribution.map((x) => x.weight));
      const cohorts = allocate(1200, distribution.map((x) => x.weight));
      distribution.forEach((d, i) => losses.push({ periodStart, channel, merchant: d.merchant, province: d.province, lossCad: cents[i] / 100, cohortCount: cohorts[i] }));
    });
  }
  for (const [periodStart, rows] of [
    ['2026-08-01', [['R017', 15000, 10200], ['R042', 10000, 6000], ['R063', 5000, 1750]]],
    ['2026-09-01', [['R017', 18000, 13680], ['R042', 12000, 7800], ['R063', 6000, 1800]]],
  ]) {
    for (const [ruleId, adjudicated, falsePositives] of rows) {
      const fps = allocate(falsePositives, ruleDistribution.map((x) => x.weight));
      const tps = allocate(adjudicated - falsePositives, ruleDistribution.map((x) => x.weight));
      ruleDistribution.forEach((d, i) => rules.push({
        periodStart, ruleId, channel: d.channel, merchant: d.merchant, province: d.province,
        adjudicatedCount: fps[i] + tps[i], falsePositiveCount: fps[i], cohortCount: fps[i] + tps[i],
      }));
    }
  }
  return { losses, rules };
}

export const documents = POLICY_SNAPSHOT.documents;
