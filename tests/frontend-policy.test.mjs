import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const [script, html, favicon] = await Promise.all(['app.js', 'index.html', 'favicon.svg']
  .map(name => readFile(new URL(`../src/web/public/${name}`, import.meta.url), 'utf8')));

class Node {
  constructor(tag = '#text', value = '') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.value = value;
    this.listeners = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get firstElementChild() { return this.children[0]; }
  focus() {}
  scrollIntoView() {}
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(' '); }
}

function renderer() {
  const names = ['text', 'element', 'list', 'button', 'hasCapability', 'analysisAllowed', 'metadata', 'notice', 'formatValue', 'formatTime', 'sourceContextMessage',
    'periodLabel', 'structuredText', 'scopeLabel', 'policyReferenceDetails', 'jsonDetails',
    'renderPolicyResolution', 'renderPolicyContext', 'renderSourceCoverage', 'renderSources', 'policyDateLabel', 'renderComparisonChart',
    'renderPolicyRegister', 'populatePolicySubjects', 'preparePolicySearch', 'renderPlannerExecution'];
  const source = names.map(name => {
    const start = script.indexOf(`  function ${name}(`);
    assert(start >= 0, `Missing ${name}`);
    return script.slice(start, script.indexOf('\n  }', start) + 4);
  }).join('\n');
  const context = {
    document: { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: value => new Node('#text', value) },
    state: { status: { synthetic: true, capabilities: { knowledge: true } }, policyAsOf: '2026-09-30' },
    nodes: new Map(),
    numberFormat: new Intl.NumberFormat('en-CA', { maximumFractionDigits: 2 }),
    moneyFormat: new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'code' })
  };
  context.$ = id => {
    if (!context.nodes.has(id)) context.nodes.set(id, new Node('div'));
    return context.nodes.get(id);
  };
  runInNewContext(source, context);
  return context;
}
const descend = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descend(child, predicate))];
const scope = { businessUnit: 'poc', subject: 'r017-rule', channel: '*', province: 'QC' };
const reference = (version, overrides = {}) => ({
  policyId: 'r017-rule', documentId: 'test-rule', title: 'Synthetic policy',
  version, effectiveFrom: '2026-09-01', effectiveTo: null, approvalStatus: 'approved',
  owner: 'Fictional policy owner', publishedAt: '2026-09-01T00:00:00Z', supersedes: [], scope, ...overrides
});
const resolution = overrides => ({
  status: 'resolved', asOf: '2026-09-30', evaluatedAt: '2026-10-20T03:00:00Z',
  policySetVersion: 'test-policy-set-v1', decisions: [{ status: 'resolved', ...reference('2.3') }], conflicts: [],
  ...overrides
});

test('planner evidence distinguishes reported execution identity from configured labels and absent metadata', () => {
  const { renderPlannerExecution } = renderer();
  const guided = renderPlannerExecution({ mode: 'guided' });
  assert.match(guided.textContent, /no model was executed/);
  assert.equal(descend(guided, node => node.tagName === 'details').length, 0);
  assert.match(renderPlannerExecution({ mode: 'natural-language' }).textContent, /completion metadata not reported/);
  const rendered = renderPlannerExecution({ mode: 'natural-language', plannerExecution: {
    reportedModel: '<script>reported-model</script>', configuredModelVersion: 'unverified',
    completionId: 'chatcmpl-unit-test', promptSha256: 'a'.repeat(64), responseSchemaSha256: 'b'.repeat(64),
    systemFingerprint: null, parameters: { temperature: 0, max_tokens: 600 },
  } });
  assert.match(rendered.textContent, /Service-reported model/);
  assert.match(rendered.textContent, /Configured model version unverified/);
  assert.match(rendered.textContent, /Not supplied by service/);
  assert.match(rendered.textContent, /identical model reruns are not guaranteed/);
  assert.equal(descend(rendered, node => node.tagName === 'script').length, 0);
  assert.match(rendered.textContent, /Temperature 0/);
});

test('restored public shell preserves the earlier layout and current policy safeguards', () => {
  assert.match(html, /<title>Fraud Intelligence \| Public synthetic demo<\/title>/);
  assert.match(html, /<span class="brand-mark" aria-hidden="true">/);
  assert.match(favicon, /<svg/);
  assert.match(html, /Not real customer data/);
  assert.match(html, /not an official Rogers portal/i);
  assert.match(html, /Public demo · No sign-in/);
  assert.match(html, /<h1 id="investigate-title">Big questions\.<br>Clearer answers\./);
  const navigation = html.match(/<nav id="primary-nav"[\s\S]*?<\/nav>/)[0];
  assert.match(navigation, /Rule library/);
  assert.match(navigation, /Demonstration/);
  assert.match(html, /class="hero"/);
  assert.match(html, /class="signal-illustration"/);
  assert.doesNotMatch(html, /workbench-grid|scope-strip|nav-heading/);
  assert.doesNotMatch(html, /class="metric-card"/, 'No fabricated KPI placeholders');
  assert.match(script, /request\("\/api\/policies"\)/);
  assert.match(script, /No local policy snapshot/);
  assert.doesNotMatch(script, /\.innerHTML|insertAdjacentHTML|eval\(/);
});

test('explicit undefined rates are not confused with missing values or measured zero', () => {
  const { formatValue } = renderer();
  assert.equal(formatValue(null, 'percent'), 'Undefined');
  assert.equal(formatValue(null, 'percentagePoints'), 'Undefined');
  assert.equal(formatValue(null, 'text'), 'Not applicable');
  assert.equal(formatValue(undefined, 'percent'), 'Not returned');
  assert.equal(formatValue(0, 'percent'), '0%');
  assert.equal(formatValue(0, 'number'), '0');
});

test('policy dates distinguish approved candidates, historical, future, draft and exclusive endpoints', () => {
  const { policyDateLabel } = renderer();
  assert.equal(policyDateLabel(reference('2.2', { effectiveTo: '2026-09-12' }), '2026-09-11'), 'Approved · date-eligible');
  assert.equal(policyDateLabel(reference('2.2', { effectiveTo: '2026-09-12' }), '2026-09-12'), 'Historical · approved');
  assert.equal(policyDateLabel(reference('3.0', { effectiveFrom: '2026-11-01' }), '2026-09-30'), 'Future · approved');
  assert.equal(policyDateLabel(reference('draft', { approvalStatus: 'draft' }), '2026-09-30'), 'Draft · not approved');
  assert.equal(policyDateLabel(reference('withdrawn', { approvalStatus: 'withdrawn' }), '2026-09-30'), 'Withdrawn');
  assert.equal(policyDateLabel({ effectiveFrom: '2026-01-01' }, '2026-09-30'), 'Approval not reported');
  assert.equal(policyDateLabel(reference('2.3', { effectiveFrom: '2026-09-12T00:00:00Z' }), '2026-09-12'), 'Approved · date-eligible');
});

test('resolved policy presentation includes version, owner, exact scope, timestamps and traceable metadata', () => {
  const { renderPolicyResolution } = renderer();
  const node = renderPolicyResolution(resolution());
  assert.equal(node.dataset.policyStatus, 'resolved');
  for (const value of ['Applicable policy resolved', '2026-09-30', 'test-policy-set-v1', '2.3', 'Fictional policy owner', 'Province: QC', 'test-rule', 'Open-ended']) {
    assert(node.textContent.includes(value), `Missing ${value}`);
  }
  assert.match(node.textContent, /does not establish causation/);
});

test('conflicts are explicit, preserve all returned versions, and never offer a fake approval or escalation action', () => {
  const { renderPolicyResolution } = renderer();
  const node = renderPolicyResolution(resolution({
    status: 'conflict', decisions: [{ status: 'conflict', subject: 'r017-rule', scope }],
    conflicts: [{ subject: 'r017-rule', scope, reason: 'Overlapping approval windows',
      versions: [reference('2.3'), reference('2.4', { owner: '<img src=x onerror=alert(1)>' })] }]
  }));
  assert.equal(node.dataset.policyStatus, 'conflict');
  assert.match(node.textContent, /Interpretation withheld · broker figures remain available/);
  assert.match(node.textContent, /Do not resolve this by choosing the newest version/);
  assert.match(node.textContent, /Conflicting version 2\.3/);
  assert.match(node.textContent, /Conflicting version 2\.4/);
  assert.match(node.textContent, /Fictional policy owner/);
  assert.match(node.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(descend(node, node => node.attributes.role === 'alert').length, 1);
  assert.equal(descend(node, node => ['button', 'img'].includes(node.tagName)).length, 0);
});

test('unknown or no-applicable resolution never appears definition-verified', () => {
  const { renderPolicyResolution } = renderer();
  const absent = renderPolicyResolution(undefined);
  assert.match(absent.textContent, /Resolution not reported/);
  assert.match(absent.textContent, /not a policy-verified interpretation/);
  assert.equal(absent.dataset.policyStatus, undefined);
  const gap = renderPolicyResolution(resolution({ status: 'no-applicable-policy', decisions: [] }));
  assert.match(gap.textContent, /No applicable policy/);
  assert.doesNotMatch(gap.textContent, /Applicable policy resolved/);
});

test('comparison context renders actual prior/current segments without inventing segment metrics', () => {
  const { renderPolicyContext, scopeLabel } = renderer();
  const node = renderPolicyContext({ policyResolution: resolution({
    periods: { previous: { start: '2026-08-01', end: '2026-09-01' }, current: { start: '2026-09-01', end: '2026-10-01' } },
    segments: [
      { period: 'previous', start: '2026-08-01', end: '2026-09-01', status: 'resolved', decisions: [reference('2.2')], conflicts: [] },
      { period: 'current', start: '2026-09-12', end: '2026-10-01', status: 'resolved', decisions: [reference('2.3')], conflicts: [] }
    ]
  }) });
  assert.match(node.textContent, /2 effective segments/);
  assert.match(node.textContent, /previous · 2026-08-01 → 2026-09-01 \(exclusive\)/);
  assert.match(node.textContent, /Monthly numerical totals are not split/);
  assert.equal(descend(node, node => node.className === 'metric-card').length, 0);
  assert.match(scopeLabel({ ...scope, province: '*', excludedProvinces: ['QC'] }), /Province: all · except provinces QC/);
});

test('comparison charts use returned values, common scales and no missing-as-zero coercion', () => {
  const { renderComparisonChart } = renderer();
  const table = {
    columns: [{ key: 'currentLoss', format: 'currency' }, { key: 'previousLoss', format: 'currency' }],
    rows: [{ group: 'Test group', currentLoss: 200, previousLoss: 100 }]
  };
  const chart = renderComparisonChart(table);
  assert.match(chart.textContent, /CAD.*200\.00/);
  assert.match(chart.textContent, /CAD.*100\.00/);
  assert.deepEqual(descend(chart, node => node.tagName === 'rect').map(node => node.attributes.width), ['500', '250']);
  assert.match(chart.textContent, /1 of 1 returned rows, in API order/);
  for (const currentLoss of [null, undefined, '200', -1, Infinity, NaN]) {
    assert.equal(renderComparisonChart({ ...table, rows: [{ ...table.rows[0], currentLoss }] }), null);
  }
  assert.equal(renderComparisonChart({ ...table, rows: [] }), null);
});

test('authorized catalog metadata becomes grouped history, not an invented resolved policy or draft content', () => {
  const ui = renderer();
  ui.state.policyRegister = {
    status: 'available', policySetVersion: 'catalog-test-set', evaluatedAt: '2026-10-20T00:00:00Z',
    policies: [
      reference('2.2', { effectiveFrom: '2026-08-01', effectiveTo: '2026-09-12' }),
      reference('2.3'),
      reference('draft', { approvalStatus: 'draft', approvedAt: null }),
      reference('3.0', { effectiveFrom: '2026-11-01' })
    ], scenarios: [{ title: 'Scoped synthetic policy check', description: 'Description, not an observed outcome.', query: { q: 'R017', asOf: '2026-09-30', subject: 'r017-rule', province: 'QC' } }]
  };
  ui.renderPolicyRegister();
  const register = ui.$('policy-register');
  assert.match(register.textContent, /1 policy family · 4 of 4 authorized versions/);
  assert.match(register.textContent, /does not mean governing/);
  assert.match(register.textContent, /Historical · approved/);
  assert.match(register.textContent, /Draft · not approved/);
  assert.match(register.textContent, /No supersession references returned/);
  assert.equal(descend(register, node => node.dataset.policyStatus !== undefined).length, 0, 'Metadata is not a resolved decision');
  assert.equal(descend(register, node => node.tagName === 'button').length, 4, 'Only three approved-version lookups and one explicit scenario preparation');
  ui.$('policy-filter').value = 'missing-policy';
  ui.renderPolicyRegister();
  assert.match(register.textContent, /No returned policy metadata matches/);
  assert.equal(descend(register, node => node.className === 'policy-family').length, 0);
  ui.$('policy-filter').value = '';
  ui.state.policyRegister.policies = [];
  ui.renderPolicyRegister();
  assert.match(register.textContent, /empty authorized policy register/);
});

test('preparing a scoped policy query updates explicit form context without making an API call', () => {
  const ui = renderer();
  ui.populatePolicySubjects([reference('2.3')]);
  assert.equal(ui.$('knowledge-subject').children.length, 2, 'Only authorized subjects plus search-term inference');
  ui.preparePolicySearch({ q: 'Fictional R017', asOf: '2026-09-22', subject: 'r017-rule', province: 'QC' });
  assert.equal(ui.$('knowledge-query').value, 'Fictional R017');
  assert.equal(ui.$('knowledge-date').value, '2026-09-22');
  assert.equal(ui.$('knowledge-subject').value, 'r017-rule');
  assert.equal(ui.$('knowledge-province').value, 'QC');
  assert.equal(ui.$('knowledge-channel').value, '');
  assert.match(ui.$('knowledge-results').textContent, /Not submitted/);
});

test('version lookup preparation uses a future or historical effective start without forcing a governing version', () => {
  const ui = renderer();
  ui.state.policyRegister = { policies: [
    reference('2.2', { effectiveFrom: '2026-08-01', effectiveTo: '2026-09-12' }),
    reference('2.3'), reference('3.0', { effectiveFrom: '2026-11-01' }),
  ] };
  ui.renderPolicyRegister();
  const register = ui.$('policy-register');
  for (const [version, date] of [['3.0', '2026-11-01'], ['2.2', '2026-08-01'], ['2.3', '2026-09-30']]) {
    const row = descend(register, node => node.tagName === 'li' && node.textContent.includes(`Version ${version}`))[0];
    const action = descend(row, node => node.tagName === 'button')[0];
    assert.match(action.textContent, new RegExp(date));
    action.listeners.click();
    assert.equal(ui.$('knowledge-date').value, date);
    assert.equal(ui.$('knowledge-subject').value, 'r017-rule');
    assert.equal(ui.$('knowledge-province').value, 'QC');
    assert.equal(ui.state.policyAsOf, '2026-09-30', 'Lookup preparation does not mutate the register reference date.');
    assert.match(ui.$('knowledge-results').textContent, /Not submitted/);
  }
});

test('source applicability preserves reporting intervals and scoped exceptions rather than implying a global citation', () => {
  const { renderSources } = renderer();
  const sources = renderSources([{
    ...reference('2.3'), citationId: 'C1', chunkId: 'test-chunk', excerpt: '<script>Source text only</script>',
    appliesTo: [
      { period: 'current', start: '2026-09-12', end: '2026-10-01', scope: { ...scope, province: '*', excludedProvinces: ['QC'] } },
      { asOf: '2026-09-19', scope }
    ]
  }]);
  assert.match(sources.textContent, /Applicability · 2 returned contexts/);
  assert.match(sources.textContent, /current · 2026-09-12 → 2026-10-01 \(exclusive\)/);
  assert.match(sources.textContent, /except provinces QC/);
  assert.match(sources.textContent, /Applicable as of 2026-09-19/);
  assert.equal(descend(sources, node => node.tagName === 'script').length, 0);
});

test('source coverage reports uncited resolved versions without mistaking an excerpt cap for absent policy', () => {
  const { renderSourceCoverage } = renderer();
  const node = renderSourceCoverage({ allPolicyMetadataEvaluated: true, maxSources: 4, resolvedVersions: 6, citedVersions: 4, omittedResolvedVersions: 2 });
  assert.match(node.textContent, /4 of 6 resolved policy versions/);
  assert.match(node.textContent, /2 resolved versions are not cited/);
  assert.match(node.textContent, /all policy metadata was evaluated/);
  assert.match(node.textContent, /missing excerpt does not make a policy missing or inapplicable/);
  assert.match(node.textContent, /Service source limit: 4/);
  assert.equal(renderSourceCoverage(undefined), null);
  assert.match(renderSourceCoverage({ resolvedVersions: 6, citedVersions: 4 }).textContent, /Missing counts are not treated as zero/);
});

test('source context distinguishes local fixtures, API-reported Azure SQL and unknown connections', () => {
  const { sourceContextMessage } = renderer();
  const local = sourceContextMessage({ type: 'local-synthetic-fixtures' });
  assert.match(local, /Local preview uses synthetic fixtures/);
  assert.match(local, /not connected to Azure SQL, Fabric or Foundry/);
  assert.doesNotMatch(local, /small synthetic Azure SQL Database|identifies an Azure SQL Database source/);
  assert.match(sourceContextMessage({ type: 'azure-sql-database' }), /The API identifies an Azure SQL Database source/);
  assert.match(sourceContextMessage({ type: 'unknown' }), /source connection is not verified/);
  assert.match(sourceContextMessage(undefined), /source connection is not verified/);
});
