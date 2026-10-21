import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { monthCount, validateQuery, parseSourceSnapshotTime } from '../validation.mjs';

export const METRIC_VERSION = 'fraud-metrics-1.2.1';
export const TEMPLATE_VERSION = 'reporting-select-1.0.0';
export const SOURCE_ID = 'azure-sql-synthetic-fraud-v1';
export const BROKER_RECEIPT_VERSION = 'broker-receipt-v1';
export const BROKER_RESPONSE_FIELDS = Object.freeze([
  'metrics', 'table', 'narrative', 'params', 'sourceAsOf', 'traceId',
  'metricVersion', 'templateVersion', 'evidenceIds', 'sourceId', 'suppressionPolicy',
]);
export const COHORT_THRESHOLD = 10;
export const round = (number) => Math.round((number + Number.EPSILON) * 100) / 100;
export const percentage = (numerator, denominator) => denominator > 0 ? round(numerator / denominator * 100) : null;
export const percentChange = (current, previous) => previous > 0 ? round((current - previous) / previous * 100) : null;
const money = (amount) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(amount);
const metric = (key, label, value, format, detail) => ({ key, label, value, format, ...(format === 'currency' ? { currency: 'CAD' } : {}), ...(detail ? { detail } : {}) });
const column = (key, label, format) => ({ key, label, ...(format ? { format } : {}), ...(format === 'currency' ? { currency: 'CAD' } : {}) });
const integrity = () => new AppError(503, 'SOURCE_INTEGRITY_ERROR', 'The approved source did not satisfy the versioned metric contract.');
const noData = () => new AppError(422, 'NO_DATA', 'Complete current and previous periods are not available. Missing data is not zero.');

export function calculate(params, raw, { sourceAsOf, traceId }) {
  validateQuery(params);
  const snapshotTime = parseSourceSnapshotTime(sourceAsOf);
  if (!Number.isFinite(snapshotTime)) throw integrity();
  if (!Array.isArray(raw) || raw.length > 100) throw new AppError(422, 'ROW_LIMIT', 'This query exceeds the bounded reporting row limit.');
  if (raw.length === 0) throw noData();
  const groups = new Map();
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw integrity();
    if (!['current', 'previous'].includes(row.period) || typeof row.group !== 'string' || row.group.length > 80 ||
        !Number.isSafeInteger(row.cohortCount) || row.cohortCount < 0 ||
        row.months !== monthCount(params[row.period])) throw noData();
    if (parseSourceSnapshotTime(row.sourceAsOfMin) !== snapshotTime ||
        parseSourceSnapshotTime(row.sourceAsOfMax) !== snapshotTime) throw integrity();
    if (row.cohortCount < COHORT_THRESHOLD) {
      // Suppress the entire result, including totals, to prevent subtraction reconstruction.
      throw new AppError(422, 'COHORT_SUPPRESSED', 'A required cohort has fewer than 10 members. All details and totals are withheld.');
    }
    if (params.kind === 'loss_comparison') {
      if (typeof row.loss !== 'number' || !Number.isFinite(row.loss) || Math.abs(row.loss) > 1e12) throw integrity();
    } else if (!/^[A-Z][0-9]{3}$/.test(row.ruleId ?? '') ||
      !Number.isSafeInteger(row.adjudicated) || !Number.isSafeInteger(row.falsePositives) ||
      row.adjudicated < 0 || row.falsePositives < 0 || row.falsePositives > row.adjudicated) throw integrity();
    const key = `${row.group}\u0000${row.ruleId ?? ''}`;
    const pair = groups.get(key) ?? {};
    if (pair[row.period]) throw integrity();
    pair[row.period] = row;
    groups.set(key, pair);
  }
  if ([...groups.values()].some((pair) => !pair.current || !pair.previous)) throw noData();
  const pairs = [...groups.values()];
  const output = params.kind === 'loss_comparison' ? losses(pairs, params) : rules(pairs, params);
  const evidenceId = createHash('sha256').update(JSON.stringify({ params, sourceAsOf, metricVersion: METRIC_VERSION, output })).digest('hex');
  return {
    ...output, params, sourceAsOf, traceId, metricVersion: METRIC_VERSION,
    templateVersion: TEMPLATE_VERSION, evidenceIds: [`sql:${evidenceId}`], sourceId: SOURCE_ID,
    suppressionPolicy: { version: 'cohort-10-total-withholding-v1', threshold: COHORT_THRESHOLD },
  };
}

function lossCents(amount) {
  const decimal = amount.toFixed(2);
  const cents = Number(decimal.replace('.', ''));
  if (Number(decimal) !== amount || !Number.isSafeInteger(cents)) throw integrity();
  return cents;
}

function currencyFromCents(cents) {
  if (!Number.isSafeInteger(cents)) throw integrity();
  const amount = cents / 100;
  if (lossCents(amount) !== cents) throw integrity();
  return amount === 0 ? 0 : amount;
}

function lossPercentChange(current, previous) {
  const value = percentChange(current, previous);
  return value === 0 ? 0 : value;
}

function lossMovement(rows, increasing) {
  const delta = (increasing ? rows[0] : rows.at(-1)).delta;
  const tied = rows.filter(row => row.delta === delta);
  const label = tied.length <= 3 ? tied.map(row => row.group).join(', ') : `${tied.length} returned groups`;
  return `${label} ${tied.length > 1 ? 'tied for' : 'had'} the largest ${increasing ? 'increase' : 'decrease'}: ${money(Math.abs(delta))}${tied.length > 1 ? ' each' : ''}.`;
}

function losses(pairs, params) {
  const amounts = pairs.map(({ current, previous }) => {
    const currentCents = lossCents(current.loss), previousCents = lossCents(previous.loss);
    return { group: current.group, currentCents, previousCents, deltaCents: currentCents - previousCents };
  }).sort((a, b) => b.deltaCents - a.deltaCents || a.group.localeCompare(b.group));
  const currentCents = amounts.reduce((sum, row) => sum + row.currentCents, 0);
  const previousCents = amounts.reduce((sum, row) => sum + row.previousCents, 0);
  const current = currencyFromCents(currentCents), previous = currencyFromCents(previousCents);
  const delta = currencyFromCents(currentCents - previousCents), change = lossPercentChange(currentCents, previousCents);
  const rows = amounts.map(row => ({
    group: row.group, currentLoss: currencyFromCents(row.currentCents), previousLoss: currencyFromCents(row.previousCents),
    delta: currencyFromCents(row.deltaCents), deltaPercent: lossPercentChange(row.currentCents, row.previousCents),
  }));
  const headline = delta === 0 ? `Net fraud loss was unchanged at ${money(current)}`
    : `Net fraud loss ${delta > 0 ? 'increased' : 'decreased'} by ${money(Math.abs(delta))}`;
  const movement = delta > 0 ? lossMovement(rows, true) : delta < 0 ? lossMovement(rows, false)
    : rows.every(row => row.delta === 0) ? 'All returned groups were unchanged.'
      : `Group increases and decreases offset in the returned aggregates. ${lossMovement(rows, true)} ${lossMovement(rows, false)}`;
  return {
    metrics: [
      metric('currentLoss', 'Current net fraud loss', current, 'currency'),
      metric('previousLoss', 'Previous net fraud loss', previous, 'currency'),
      metric('lossDelta', 'Loss change', delta, 'currency'),
      metric('lossChangePercent', 'Loss change', change, 'percent', change === null ? 'Undefined for a zero or negative baseline.' : 'Relative to previous booked loss.'),
    ],
    table: { columns: [column('group', params.groupBy), column('currentLoss', 'Current loss', 'currency'), column('previousLoss', 'Previous loss', 'currency'), column('delta', 'Change', 'currency'), column('deltaPercent', 'Change', 'percent')], rows },
    narrative: {
      headline,
      text: `Booked net losses were ${money(current)} versus ${money(previous)}${change === null ? '; relative change is undefined for a zero or negative baseline.' : ` (${change}% change).`}` +
        ` ${movement}`,
      caveats: ['Synthetic aggregate Azure SQL data only.', 'Booked CAD net loss uses recognized losses less recoveries on loss date. Period totals are not daily-normalized.',
        'Monetary totals and differences use validated integer CAD cents; relative changes use those cent amounts before display rounding.',
        'Comparative association does not establish a cause.'],
      investigationSteps: ['Review cited KPI definitions before interpreting changes.', 'Compare channel, merchant, and province aggregates independently.', 'Validate any rule-change hypothesis with an authorized investigation; no automatic rule changes are made.'],
    },
  };
}

function compareRuleShares(a, b) {
  if (a.currentAdjudicated === 0) return b.currentAdjudicated === 0 ? 0 : 1;
  if (b.currentAdjudicated === 0) return -1;
  const left = BigInt(a.currentFalsePositives) * BigInt(b.currentAdjudicated);
  const right = BigInt(b.currentFalsePositives) * BigInt(a.currentAdjudicated);
  return left === right ? 0 : left > right ? -1 : 1;
}

function alertShareChange(row) {
  return row.currentAdjudicated > 0 && row.previousAdjudicated > 0
    ? round((row.currentFalsePositives / row.currentAdjudicated - row.previousFalsePositives / row.previousAdjudicated) * 100)
    : null;
}

function rules(pairs, params) {
  const rows = pairs.map(({ current, previous }) => {
    const currentShare = percentage(current.falsePositives, current.adjudicated);
    const previousShare = percentage(previous.falsePositives, previous.adjudicated);
    const row = {
      group: current.group, ruleId: current.ruleId, currentAdjudicated: current.adjudicated,
      currentFalsePositives: current.falsePositives, previousAdjudicated: previous.adjudicated,
      previousFalsePositives: previous.falsePositives, currentShare, previousShare,
    };
    return { ...row, shareChangePp: alertShareChange(row) };
  }).sort((a, b) => compareRuleShares(a, b) || a.ruleId.localeCompare(b.ruleId) || a.group.localeCompare(b.group));
  const totals = new Map();
  for (const row of rows) {
    const total = totals.get(row.ruleId) ?? { ruleId: row.ruleId, currentAdjudicated: 0, currentFalsePositives: 0, previousAdjudicated: 0, previousFalsePositives: 0 };
    for (const key of ['currentAdjudicated', 'currentFalsePositives', 'previousAdjudicated', 'previousFalsePositives']) {
      total[key] += row[key];
      if (!Number.isSafeInteger(total[key])) throw integrity();
    }
    totals.set(row.ruleId, total);
  }
  const ranked = [...totals.values()].map((row) => ({
    ...row, currentShare: percentage(row.currentFalsePositives, row.currentAdjudicated),
    previousShare: percentage(row.previousFalsePositives, row.previousAdjudicated),
  })).filter(row => row.currentAdjudicated > 0).sort((a, b) => compareRuleShares(a, b) || a.ruleId.localeCompare(b.ruleId));
  const focus = ranked[0];
  const tied = focus ? ranked.filter(row => compareRuleShares(row, focus) === 0).map(row => row.ruleId) : [];
  const tiedLabel = tied.length <= 3 ? tied.join(', ') : `${tied.length} rules`;
  const change = focus ? alertShareChange(focus) : null;
  const currentScope = focus ? focus.ruleId : 'All returned rules';
  const currentAdjudicated = focus ? focus.currentAdjudicated : [...totals.values()].reduce((sum, row) => sum + row.currentAdjudicated, 0);
  const currentFalsePositives = focus ? focus.currentFalsePositives : [...totals.values()].reduce((sum, row) => sum + row.currentFalsePositives, 0);
  return {
    metrics: [
      metric('focusRule', !focus ? 'Current rule ranking' : tied.length > 1 ? 'Displayed rule (tied highest FP share)' : 'Highest observed alert FP share',
        focus ? focus.ruleId : null, 'text', !focus ? 'No rule is ranked because every current adjudicated-alert denominator is zero.'
          : tied.length > 1 ? `${tiedLabel} have equal exact ratios. ${focus.ruleId} is shown alphabetically as context, not a unique winner.`
            : 'Ranking uses exact count ratios before display rounding.'),
      metric('currentFpShare', focus ? `${focus.ruleId} current FP share` : 'Current FP share', focus ? focus.currentShare : null, 'percent', 'FP / (TP + FP), adjudicated alerts only.'),
      metric('previousFpShare', focus ? `${focus.ruleId} previous FP share` : 'Previous FP share (no ranked rule)', focus ? focus.previousShare : null, 'percent',
        focus ? undefined : 'No current focus is selected. Previous per-rule shares remain in the returned breakdown.'),
      metric('fpShareChangePp', 'FP share change', change, 'percentagePoints', 'Computed from underlying counts before display rounding.'),
      metric('currentAdjudicated', `${currentScope} current adjudicated alerts`, currentAdjudicated, 'number'),
      metric('currentFalsePositives', `${currentScope} current false positives`, currentFalsePositives, 'number'),
    ],
    table: { columns: [
      column('group', params.groupBy), column('ruleId', 'Rule'),
      column('currentAdjudicated', 'Current adjudicated', 'number'), column('currentFalsePositives', 'Current FP', 'number'),
      column('previousAdjudicated', 'Previous adjudicated', 'number'), column('previousFalsePositives', 'Previous FP', 'number'),
      column('currentShare', 'Current FP share', 'percent'), column('previousShare', 'Previous FP share', 'percent'), column('shareChangePp', 'Change', 'percentagePoints'),
    ], rows },
    narrative: {
      headline: !focus ? 'Current adjudicated-alert FP shares cannot be ranked'
        : tied.length > 1 ? `${tiedLabel} share the highest observed adjudicated-alert FP share`
          : `${focus.ruleId} has the highest observed adjudicated-alert FP share`,
      text: !focus ? 'Every current adjudicated-alert denominator is zero, so current shares and ranking are undefined. Previous per-rule shares remain in the breakdown. No rule was selected and no comparative change is reported.' :
        `${focus.ruleId}: ${focus.currentFalsePositives} false positives out of ${focus.currentAdjudicated} adjudicated alerts (${focus.currentShare}%). ` +
        (focus.previousShare === null ? 'The previous denominator is zero; change is undefined.' : `Previous share: ${focus.previousShare}%; change: ${change} percentage points.`) +
        (tied.length > 1 ? ` ${tiedLabel} have the same exact current ratio; the displayed focus is not a unique winner.` : ''),
      caveats: ['Synthetic aggregate Azure SQL data only.', 'Alert false-positive share is FP / (TP + FP); it is not population false-positive rate FP / (FP + TN).',
        'Returned rule rows are ordered by exact current count ratios before display rounding; undefined current shares follow measured rows.',
        'Shares and percentage-point changes are independently rounded from underlying counts, not calculated from displayed rounded percentages.',
        !focus ? 'Zero adjudicated alerts do not mean zero fraud or zero underlying transactions.' : 'The displayed association with a rule change is a hypothesis, not proof of causation.',
        'No rule thresholds or production data are changed.'],
      investigationSteps: ['Review the cited rule-change log and rule dictionary.', 'Review adjudication consistency and cohort mix before attributing changes.', 'Use the investigation SOP to validate hypotheses through an authorized offline investigation.'],
    },
  };
}
