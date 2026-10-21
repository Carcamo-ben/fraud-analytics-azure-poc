import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { buildFixtures, documents, SOURCE_AS_OF } from '../seed/fixtures.mjs';
import { SCENARIOS } from '../src/web/services.mjs';
import { validateKnowledgeQuery, validateQuestion } from '../src/validation.mjs';
import { SUPPORTED_QUESTION, UNSUPPORTED_QUESTION } from '../deploy/cloud-acceptance.mjs';

const [catalogText, html, script, css] = await Promise.all(
  ['user-stories.json', 'index.html', 'app.js', 'styles.css']
    .map(name => readFile(new URL(`../src/web/public/${name}`, import.meta.url), 'utf8')),
);
const catalog = JSON.parse(catalogText);
const story = id => catalog.stories.find(item => item.id === id);
const expected = id => story(id).presenter.expected.join(' ');
const fixtures = buildFixtures();
const format = new Intl.NumberFormat('en-CA');
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

test('six capability-gated stories form a nine-minute walkthrough without claiming acceptance', () => {
  assert.deepEqual(catalog.stories.map(item => item.id), ['FI-01', 'FI-02', 'FI-03', 'FI-04', 'FI-05', 'FI-06']);
  const seconds = catalog.stories.reduce((total, item) => total + item.presenter.durationSeconds, 0);
  assert.equal(seconds, catalog.walkthrough.durationMinutes * 60);
  assert(seconds >= 480 && seconds <= 600);
  assert.match(catalog.walkthrough.preflight, /expected synthetic fixture facts, not observed results/i);
  assert.match(catalog.readinessPolicy, /Ready is not completed or validated/);
  for (const item of catalog.stories) {
    assert(item.requiredCapabilities.length > 0);
    assert(item.presenter.question.endsWith('?'));
    assert(item.presenter.pointOut.length >= 2);
    assert(item.presenter.expected.length >= 2);
    if (item.scenarioKind) assert(SCENARIOS.some(scenario => scenario.request.kind === item.scenarioKind));
  }
  assert.deepEqual(story('FI-06').requiredCapabilities, ['naturalLanguage']);
  assert.match(expected('FI-05'), /HTTP 400 \+ INVALID_REQUEST/);
  assert.match(story('FI-06').presenter.pointOut.join(' '), /HTTP 422 \+ UNSUPPORTED_QUESTION/);
});

test('presenter loss expectations match the actual fixture totals and all channel partitions', () => {
  const previous = sum(fixtures.losses.filter(row => row.periodStart === '2026-08-01'), 'lossCad');
  const current = sum(fixtures.losses.filter(row => row.periodStart === '2026-09-01'), 'lossCad');
  assert(expected('FI-01').includes(`August CAD ${format.format(previous)} → September CAD ${format.format(current)}`));
  assert(expected('FI-01').includes(`CAD +${format.format(current - previous)} (+${(current - previous) / previous * 100}%)`));
  for (const channel of new Set(fixtures.losses.map(row => row.channel))) {
    const before = sum(fixtures.losses.filter(row => row.channel === channel && row.periodStart === '2026-08-01'), 'lossCad');
    const after = sum(fixtures.losses.filter(row => row.channel === channel && row.periodStart === '2026-09-01'), 'lossCad');
    assert(expected('FI-01').includes(channel));
    assert(expected('FI-01').includes(`${format.format(before)} → ${format.format(after)}`));
  }
});

test('R017 presenter expectations use adjudicated totals, not population FP rate or a single channel row', () => {
  const shares = [];
  for (const period of ['2026-08-01', '2026-09-01']) {
    const rows = fixtures.rules.filter(row => row.ruleId === 'R017' && row.periodStart === period);
    const numerator = sum(rows, 'falsePositiveCount');
    const denominator = sum(rows, 'adjudicatedCount');
    const share = numerator / denominator * 100;
    shares.push(share);
    assert(expected('FI-02').includes(`${format.format(numerator)} / ${format.format(denominator)} = ${share}%`));
  }
  assert(expected('FI-02').includes(`+${shares[1] - shares[0]} percentage points`));
  assert.match(story('FI-02').presenter.pointOut.join(' '), /totals across channels/);
  assert.doesNotMatch(`${catalogText}\n${html}`, /R-017/);
});

test('knowledge examples use real rule IDs and a date before every document for the empty case', () => {
  const examples = story('FI-03').presenter.examples;
  for (const example of examples) {
    assert.equal(example.query, 'R017');
    assert.deepEqual(validateKnowledgeQuery({ q: example.query, asOf: example.asOf }), { q: example.query, asOf: example.asOf });
  }
  const reporting = examples.find(item => item.asOf === '2026-09-30');
  const earlier = examples.find(item => item.asOf === '2026-09-01');
  const empty = examples.find(item => item.label === 'Before all documents');
  assert(reporting && earlier && empty);
  assert(documents.every(doc => empty.asOf < doc.effectiveFrom.slice(0, 10)));
  const rule = documents.find(doc => doc.docId === 'synthetic-r017-change');
  assert(expected('FI-03').includes(`version ${rule.version}`));
  assert(expected('FI-03').includes(rule.effectiveFrom.slice(0, 10)));
  assert(earlier.asOf < rule.effectiveFrom.slice(0, 10));
  assert.match(story('FI-03').presenter.pointOut.join(' '), /nearest neighbors.*lexical absence does not guarantee/i);
  assert.match(story('FI-03').acceptanceCriteria.join(' '), /available response with zero sources/);
});

test('evidence notes name seeded provenance, and natural-language examples match acceptance inputs', () => {
  assert.equal(story('FI-04').action, 'evidence');
  assert(expected('FI-04').includes(SOURCE_AS_OF));
  assert.match(expected('FI-04'), /generated by the backend, not prewritten/);
  assert.deepEqual(story('FI-06').presenter.examples.map(item => item.question), [SUPPORTED_QUESTION, UNSUPPORTED_QUESTION]);
  for (const example of story('FI-06').presenter.examples) assert.equal(validateQuestion(example.question), example.question);
});

test('frontend uses external self-hosted assets, existing theme variables and accessible guide controls', () => {
  assert.doesNotThrow(() => new Script(script, { filename: 'app.js' }));
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=|\son(?:click|change|submit)\s*=/i);
  assert.deepEqual([...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g)].map(match => [match[1], match[2]]), [['/app.js', '']]);
  assert.match(html, /href="\/styles\.css"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g)) assert(ids.includes(match[1]), `Missing element ${match[1]}`);
  assert.match(html, /id="walkthrough"[^>]*aria-labelledby="walkthrough-title"[^>]*tabindex="-1"[^>]*hidden/);
  assert.match(html, /id="walkthrough-observation"[^>]*role="status"/);
  assert.match(script, /Not observed yet\. Expected notes above are not API results/);
  assert.match(script, /node\.disabled = !analysisAllowed\(capability\)/);
  const stylesWithoutTokens = css.replace(/--cp-[a-z-]+:\s*[^;]+;/g, '');
  assert.doesNotMatch(stylesWithoutTokens, /#[\da-f]{3,8}\b|\brgba?\(/i);
  for (const token of ['bg', 'surface', 'text', 'text-muted', 'accent', 'accent-hover', 'accent-fg', 'border', 'success', 'danger', 'warning', 'link']) {
    assert.equal([...css.matchAll(new RegExp(`--cp-${token}:`, 'g'))].length, 2);
  }
});
