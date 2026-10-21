// Optional browser regression: node --test tests/frontend-assistant.browser.mjs
// Uses an already-installed Playwright and Edge; never downloads browser tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { SCENARIOS } from '../src/web/services.mjs';
import { calculate } from '../src/broker/metrics.mjs';
import { resultFor, listening, fixtureRows, config, oid } from './helpers.mjs';

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const status = {
  publicDemo: true, synthetic: true,
  capabilities: { naturalLanguage: true, guided: true, knowledge: true, evidence: true },
  services: { broker: { status: 'ready' }, model: { status: 'ready' }, knowledge: { status: 'ready' } },
  source: { label: 'Browser-test synthetic fixture' },
  limits: { maxQuestionLength: 1000 },
};
const policyVersion = (version, extra = {}) => ({
  policyId: 'r017-rule', documentId: 'synthetic-r017-change', title: 'Fictional R017 rule',
  version, approvalStatus: 'approved', effectiveFrom: '2026-09-12', effectiveTo: null,
  publishedAt: '2026-07-01T00:00:00Z', approvedAt: '2026-07-01T00:00:00Z',
  owner: 'Fictional policy stewardship', supersedes: [],
  scope: { businessUnit: 'poc', subject: 'r017-rule', channel: '*', province: '*' }, ...extra
});
const policyCatalog = {
  status: 'available', synthetic: true, registry: 'synthetic-policy-manifest',
  policySetVersion: 'browser-test-policy-set', snapshotHash: 'f'.repeat(64), evaluatedAt: '2026-10-20T03:00:00Z',
  policies: [
    policyVersion('2.2', { effectiveFrom: '2026-08-01', effectiveTo: '2026-09-12' }),
    policyVersion('2.3', { supersedes: [{ policyId: 'r017-rule', version: '2.2' }] }),
    policyVersion('3.0', { effectiveFrom: '2026-11-01' }),
    policyVersion('9.0-draft', { approvalStatus: 'draft', approvedAt: null })
  ], scenarios: []
};
async function assertNoPageOverflow(page, label) {
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('body *')]
      .filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8)
      .map(node => ({ element: node.id || node.className || node.tagName, right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) }))
  }));
  assert.equal(geometry.document <= geometry.viewport, true, `${label}: ${JSON.stringify(geometry)}`);
}
async function assertResponsivePage(page, label) {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoPageOverflow(page, `${label} at ${width}px`);
  }
}
const makeAnswer = (id, mode = 'natural-language', result = resultFor()) => ({
  ...result, answerId: id, synthetic: true,
  knowledge: { status: 'available', sources: [{ citationId: 'C1', title: 'Synthetic test definition', version: '1', documentId: 'definition', chunkId: 'chunk-1', effectiveFrom: '2026-07-01', excerpt: '<script>Not markup</script> Synthetic definition.' }] },
  provenance: { mode, traceId: `trace-${id}`, sourceId: 'browser-test-fixture', generatedAt: '2026-10-01T00:00:00Z',
    ...(mode === 'natural-language' ? { plannerExecution: {
      reportedModel: 'reported-browser-fixture-model', configuredModelVersion: 'unverified', completionId: 'chatcmpl-browser-fixture',
      completionCreatedAt: '2026-10-01T00:00:00Z', promptSha256: 'a'.repeat(64), responseSchemaSha256: 'b'.repeat(64),
      responseSha256: 'c'.repeat(64), requestSha256: 'd'.repeat(64), questionSha256: 'e'.repeat(64),
      parameters: { temperature: 0, max_tokens: 600 }, systemFingerprint: null, apiVersion: '2024-10-21', provider: 'azure-openai',
    } } : {}) },
  evidenceUrl: `/api/evidence/${id}`,
});
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'user-stories.json', 'favicon.svg'].includes(name)) {
    response.writeHead(404).end();
    return;
  }
  const content = await readFile(new URL(`../src/web/public/${name}`, import.meta.url));
  response.writeHead(200, {
    'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html',
    'content-security-policy': csp,
  }).end(content);
});

test('assistant uses real request lifecycle, preserves question pairing, and supports keyboard/mobile', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await listening(server, async base => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const calls = [];
      let pending;
      let askHandler = async route => {
        pending = route;
      };
      await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
        if (path === '/api/status') return json(status);
        if (path === '/api/scenarios') return json(SCENARIOS);
        if (path === '/api/policies') return json(policyCatalog);
        if (path === '/api/ask') {
          calls.push({ body: request.postDataJSON(), headers: request.headers() });
          return askHandler(route);
        }
        if (path === '/api/analyze') return json(makeAnswer('guided', 'guided'));
        if (path === '/api/knowledge') return json({ status: 'available', mode: 'keyword-only', sources: [] });
        if (path.startsWith('/api/evidence/')) return json({ answer: makeAnswer(path.split('/').pop()), request: SCENARIOS[0].request });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      });
      await page.goto(base);
      await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      await page.locator('.scenario-card').first().waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Light is the default, even with a dark OS preference');
      assert.equal(await page.title(), 'Fraud Intelligence | Public synthetic demo');
      assert.equal(await page.locator('.utility').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(31, 31, 31)');
      assert.equal(await page.locator('.site-header').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(218, 41, 28)');
      assert.equal(await page.locator('.site-header').evaluate(node => node.getBoundingClientRect().height >= 80), true);
      assert.equal(await page.locator('#primary-nav').evaluate(node => getComputedStyle(node).position), 'static', 'Restore horizontal navigation, not the overnight sidebar');
      assert.equal(await page.locator('.hero').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
      assert.equal(await page.locator('.metric-card').count(), 0, 'Landing page must not invent metrics');
      assert.equal(calls.length, 0, 'Opening the demo does not execute the model');
      assert.equal(await page.locator('.scenario-card').count(), SCENARIOS.length);
      assert.match(await page.locator('.period-label').first().textContent(), /Sep 2026 compared with Aug 2026/);
      assert.equal(await page.locator('.signal-illustration, .hero').count(), 2);
      assert.match(await page.locator('#investigate-title').textContent(), /Big questions\.Clearer answers\./);
      assert.equal(await page.locator('#primary-nav a[href="#stories"]').count(), 1);
      assert.equal(await page.locator('#walkthrough').isVisible(), false);
      assert.equal(await page.locator('#service-details').getAttribute('open'), null);
      assert.equal((await page.request.get(`${base}/favicon.svg`)).status(), 200);
      await page.waitForFunction(() => !document.getElementById('walkthrough-start-hero').disabled);
      await page.click('#walkthrough-start-hero');
      assert.equal(await page.locator('#walkthrough').isVisible(), true);
      assert.equal(calls.length, 0, 'The restored walkthrough control must not execute a model request');
      await page.click('#walkthrough-close');
      assert.equal(await page.locator('#walkthrough').isVisible(), false);
      for (const id of ['assistant-open-hero', 'assistant-open-header']) {
        await page.click(`#${id}`);
        assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open), true);
        assert.equal(await page.locator(`#${id}`).getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#ask-form').count(), 1);
        assert.equal(calls.length, 0);
        await page.click('#assistant-close');
        assert.equal(await page.evaluate(() => document.activeElement.id), id);
      }
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await assertNoPageOverflow(page, `No horizontal overflow at ${width}px`);
        if (width <= 1000) {
          assert.equal(await page.locator('#primary-nav').isVisible(), false);
          await page.locator('#menu-toggle').focus();
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
          assert.equal(await page.locator('#primary-nav').isVisible(), true);
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#primary-nav').isVisible(), false);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-toggle');
          await page.click('#menu-toggle');
          await page.locator('#primary-nav [data-page="knowledge"]').click();
          await page.waitForFunction(() => location.hash === '#knowledge');
          assert.equal(await page.locator('#primary-nav').isVisible(), false);
          assert.equal(await page.locator('#knowledge-title').isVisible(), true);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.click('#menu-toggle');
          await page.locator('#primary-nav [data-page="investigate"]').click();
          await page.waitForFunction(() => location.hash === '#investigate');
        }
      }
      if (process.env.FRAUD_SCREENSHOTS === '1') {
        await page.evaluate(() => { document.getElementById('identity').textContent = 'LOCAL FIXTURE · Not a live service'; window.scrollTo(0, 0); });
        await page.screenshot({ path: 'fraud-redesign-desktop.png', fullPage: true, animations: 'disabled' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: 'fraud-redesign-mobile.png', fullPage: true, animations: 'disabled' });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      await page.goto(`${base}/?scoutTheme=dark`);
      await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.click('#theme-toggle');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      await page.goto(`${base}/?scoutTheme=invalid`);
      await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      await page.click('#assistant-toggle');
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open && !node.matches(':modal')), true);
      assert.equal(await page.locator('#ask-form').count(), 1);
      assert.equal(await page.locator('#assistant-composer-home #ask-form').count(), 1);
      await page.locator('#assistant-suggestions button').first().click();
      assert.equal(calls.length, 0);
      const firstQuestion = await page.inputValue('#question-input');
      await page.click('#ask-submit');
      await page.waitForFunction(() => document.querySelector('.assistant-turn[aria-busy="true"]'));
      assert.equal(await page.locator('#ask-submit').isDisabled(), true);
      assert.equal(await page.locator('[data-scenario-id]').first().isDisabled(), true);
      await page.evaluate(() => document.getElementById('ask-form').dispatchEvent(new Event('submit', { cancelable: true })));
      await page.waitForTimeout(100);
      assert.equal(calls.length, 1, 'No duplicate API request while pending');
      assert.deepEqual(calls[0].body, { question: firstQuestion });
      assert.equal(Object.keys(calls[0].headers).some(key => /authorization|x-fraud|x-ms-client-principal/i.test(key)), false);
      await page.click('#assistant-close');
      assert.equal(await page.locator('#question-composer-home #ask-form').count(), 1);
      assert.equal(await page.locator('#ask-submit').isDisabled(), true);
      await page.click('#assistant-toggle');
      await pending.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeAnswer('first')) });
      await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      assert.equal(await page.locator('.assistant-turn .metric-card').count() > 0, true);
      assert.equal(await page.locator('#analysis-content .question-echo').textContent(), firstQuestion);
      assert.match(await page.locator('.assistant-turn').textContent(), /API response · model planned/);
      await page.locator('.assistant-citations > summary').click();
      assert.match(await page.locator('.assistant-citations').textContent(), /chunk-1/);
      assert.equal(await page.locator('.assistant-citations script').count(), 0);
      await page.locator('.assistant-turn [data-evidence-button]').click();
      await page.waitForFunction(() => document.querySelector('#dialog-body .evidence-json'));
      assert.match(await page.locator('#dialog-body').textContent(), /trace-first/);
      await page.locator('#dialog-body').getByText('Planner execution identity & hashes', { exact: true }).click();
      assert.match(await page.locator('#dialog-body').textContent(), /reported-browser-fixture-model/);
      assert.match(await page.locator('#dialog-body').textContent(), /Configured model version/);
      await assertResponsivePage(page, 'Expanded planner evidence dialog');
      await page.click('#dialog-close');
      await page.locator('.assistant-turn [data-answer-button]').click();
      await page.waitForFunction(() => location.hash === '#analysis');
      assert.equal(await page.locator('#analysis-content .question-echo').textContent(), firstQuestion);

      askHandler = route => route.fulfill({ status: 429, headers: { 'Retry-After': '10' }, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Limit reached' } }) });
      await page.locator('#assistant-suggestions button').nth(1).click();
      const secondQuestion = await page.inputValue('#question-input');
      await page.click('#ask-submit');
      await page.waitForFunction(() => document.querySelectorAll('.assistant-turn .notice.error').length === 1);
      assert.match(await page.locator('.assistant-turn').nth(1).textContent(), /HTTP 429.*RATE_LIMITED/s);
      assert.match(await page.locator('.assistant-turn').nth(1).textContent(), /Retry after 10 seconds/);
      assert.equal(await page.locator('.assistant-turn').nth(0).locator('h3').first().textContent(), firstQuestion);
      await page.fill('#question-input', 'Compare losses by merchant for September 2026 versus August 2026.');
      askHandler = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DEMO_BUSY', message: 'Busy' } }) });
      await page.locator('.assistant-turn').nth(1).getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.assistant-turn .notice.error').length === 2);
      assert.deepEqual(calls.at(-1).body, { question: secondQuestion }, 'Retry is tied to its original question');
      assert.match(await page.locator('.assistant-turn').nth(2).textContent(), /HTTP 503.*DEMO_BUSY/s);
      assert.equal(await page.locator('#analysis-content .metric-card').count(), 0);
      assert.equal(await page.locator('#assistant-history .metric-card').count() > 0, true, 'Earlier successful response remains labelled in history');

      const beforeInvalid = calls.length;
      await page.evaluate(() => {
        document.getElementById('question-input').value = 'x'.repeat(1001);
        document.getElementById('ask-form').dispatchEvent(new Event('submit', { cancelable: true }));
      });
      assert.match(await page.locator('#question-validation').textContent(), /8–1,000/);
      assert.equal(calls.length, beforeInvalid);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-toggle');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#assistant-toggle');
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.matches(':modal')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#assistant-close').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.getElementById('assistant-panel').contains(document.activeElement)), true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForFunction(() => document.getElementById('assistant-panel').open && !document.getElementById('assistant-panel').matches(':modal'));
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open && !node.matches(':modal')), true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.getElementById('assistant-panel').matches(':modal'));
      await page.locator('.assistant-turn [data-answer-button]').first().click();
      await page.waitForFunction(() => !document.getElementById('assistant-panel').open);
      assert.equal(await page.locator('#analysis-content .question-echo').textContent(), firstQuestion);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'analysis');
      await page.click('#assistant-toggle');
      assert.equal(await page.locator('#assistant-history .assistant-turn').count(), 3);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open), false);

      askHandler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeAnswer(`answer-${calls.length}`)) });
      await page.click('#assistant-toggle');
      for (let index = 0; index < 6; index++) {
        await page.fill('#question-input', firstQuestion);
        await page.locator('#question-input').press('Control+Enter');
        await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      }
      assert.equal(await page.locator('#assistant-history .assistant-turn').count(), 8);
      assert.match(await page.locator('.assistant-turn').first().textContent(), /Question 2 · standalone/);
      await page.setViewportSize({ width: 640, height: 360 });
      assert.equal(await page.locator('#assistant-composer-home').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1), true);
      await page.setViewportSize({ width: 320, height: 720 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.click('#assistant-close');
      await page.setViewportSize({ width: 390, height: 844 });

      askHandler = route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNSUPPORTED_QUESTION', message: 'Only supported aggregate fraud comparisons are available.' } }) });
      await page.fill('#question-input', 'What is the weather forecast for Ottawa tomorrow?');
      await page.click('#ask-submit');
      await page.waitForFunction(() => document.getElementById('analysis-state').textContent === 'Request failed · no result');
      assert.match(await page.locator('#analysis-content').textContent(), /UNSUPPORTED_QUESTION/);
      assert.equal(await page.locator('#analysis-content .metric-card').count(), 0);
      assert.equal(await page.locator('#assistant-history .assistant-turn').count(), 8);

      status.capabilities.naturalLanguage = false;
      await page.locator('#service-details > summary').click();
      await page.click('#refresh-status');
      await page.waitForFunction(() => document.getElementById('model-badge').textContent === 'Unavailable');
      assert.equal(await page.locator('#question-input').isDisabled(), true);
      await page.click('#assistant-toggle');
      assert.equal(await page.locator('#assistant-suggestions button').first().isDisabled(), true);
      await page.click('#assistant-close');
      assert.equal(await page.locator('[data-scenario-id]').first().isEnabled(), true);
      await page.locator('[data-scenario-id]').first().click();
      await page.waitForFunction(() => document.getElementById('analysis-state').textContent === 'Response received');
      assert.match(await page.locator('#analysis-content').textContent(), /Guided · deterministic/);
      await page.goto(`${base}/#stories`);
      await page.waitForFunction(() => !document.getElementById('walkthrough-start').disabled);
      await page.click('#walkthrough-start');
      await page.waitForFunction(() => !document.getElementById('walkthrough').hidden);
      assert.match(await page.locator('#walkthrough-step').textContent(), /1 of 6/);
      assert.deepEqual(errors.filter(message => !/status of (422|429|503)/.test(message)), []);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

test('evidence stays above the assistant across responsive modal changes and returns keyboard focus', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await listening(server, async base => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      let questions = 0, evidenceReads = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
        if (path === '/api/status') return json({ ...status, capabilities: { ...status.capabilities, naturalLanguage: true } });
        if (path === '/api/scenarios') return json(SCENARIOS);
        if (path === '/api/ask') { questions++; return json(makeAnswer('responsive-evidence')); }
        if (path.startsWith('/api/evidence/')) {
          evidenceReads++;
          return json({ answer: makeAnswer('responsive-evidence'), request: SCENARIOS[0].request });
        }
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      });
      await page.goto(base);
      await page.waitForFunction(() => !document.getElementById('ask-submit').disabled);
      await page.click('#assistant-toggle');
      await page.fill('#question-input', SCENARIOS[0].question);
      await page.click('#ask-submit');
      const evidenceButton = page.locator('.assistant-turn [data-evidence-button]');
      await evidenceButton.waitFor();
      for (const [index, width] of [390, 1440, 320, 768].entries()) {
        await evidenceButton.click();
        await page.locator('#dialog-body .evidence-json').waitFor();
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#detail-dialog').evaluate(node => node.matches(':modal')), true);
        assert.equal(await page.locator('#dialog-close').evaluate(node => {
          const box = node.getBoundingClientRect();
          const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return node === top || node.contains(top);
        }), true, `Evidence close control remains above the assistant at ${width}px.`);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.getElementById('detail-dialog').contains(document.activeElement)), true);
        await assertNoPageOverflow(page, `Responsive evidence overlay at ${width}px`);
        if (index % 2) await page.keyboard.press('Escape');
        else await page.click('#dialog-close');
        await page.waitForFunction(modal => {
          const assistant = document.getElementById('assistant-panel');
          return !document.getElementById('detail-dialog').open && assistant.open && assistant.matches(':modal') === modal;
        }, width <= 1100);
        assert.equal(await evidenceButton.evaluate(node => document.activeElement === node), true, 'Focus returns to the original evidence control.');
        assert.equal(await page.locator('#assistant-toggle').getAttribute('aria-expanded'), 'true');
      }
      assert.equal(questions, 1, 'Resizing and inspecting evidence never repeats the model request.');
      assert.equal(evidenceReads, 4);
      assert.equal(await page.locator('.assistant-turn').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#assistant-panel').evaluate(node => node.open), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'assistant-toggle');
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

test('policy library exposes real metadata, scoped decisions, conflicts and honest unavailable states', { timeout: 90000 }, async () => {
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        await listening(server, async base => {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const calls = [];
          let failCatalog = false;
          let failLookup = false;
          let emptyCatalog = false;
          let localMode = false;
          let knowledgeStatus = 'resolved';
          const resolution = () => ({
            status: knowledgeStatus, asOf: '2026-09-30', policySetVersion: 'browser-test-policy-set',
            evaluatedAt: '2026-10-20T03:00:00Z',
            decisions: knowledgeStatus === 'resolved' ? [
              { status: 'resolved', ...policyVersion('2.3'), scope: { ...policyVersion('2.3').scope, excludedProvinces: ['QC'] } },
              { status: 'resolved', ...policyVersion('2.4-qc'), scope: { ...policyVersion('2.4-qc').scope, province: 'QC' } }
            ] : [],
            conflicts: knowledgeStatus === 'conflict' ? [{
              subject: 'r017-rule', scope: policyVersion('2.3').scope, reason: 'Test unresolved overlapping versions',
              versions: [policyVersion('2.3'), policyVersion('2.4', { owner: '<script>not executable</script>' })]
            }] : []
          });

          await page.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
            const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
            if (url.pathname === '/api/status') return json({
              ...status, capabilities: { guided: true, naturalLanguage: !localMode, knowledge: true, evidence: true },
              source: localMode ? { type: 'local-synthetic-fixtures', label: 'Local synthetic fixtures — not connected to Azure, Fabric or Foundry' } : status.source
            });
            if (url.pathname === '/api/scenarios') return json(SCENARIOS);
            if (url.pathname === '/api/policies') {
              if (failCatalog) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"POLICY_UNAVAILABLE"}}' });
              return json(emptyCatalog ? { ...policyCatalog, policies: [] } : policyCatalog);
            }
            if (url.pathname === '/api/knowledge' && failLookup) return route.fulfill({
              status: 503, contentType: 'application/json', body: '{"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"Synthetic lookup outage"}}',
            });
            if (url.pathname === '/api/knowledge') return json({
              status: 'available', mode: 'keyword-only', policyResolution: resolution(),
              sources: knowledgeStatus === 'resolved' ? makeAnswer('policy-search').knowledge.sources.map(source => ({
                ...source, ...policyVersion('2.3'),
                appliesTo: [{ asOf: '2026-09-30', scope: { ...policyVersion('2.3').scope, excludedProvinces: ['QC'] } }]
              })) : [],
              sourceCoverage: { allPolicyMetadataEvaluated: true, maxSources: 4, resolvedVersions: knowledgeStatus === 'resolved' ? 2 : 0,
                citedVersions: knowledgeStatus === 'resolved' ? 1 : 0, omittedResolvedVersions: knowledgeStatus === 'resolved' ? 1 : 0 }
            });
            if (url.pathname === '/api/analyze') return json({
              ...makeAnswer('conflict-analysis', 'guided'), knowledge: { status: 'available', sources: [], policyResolution: resolution() }
            });
            if (url.pathname.startsWith('/api/evidence/')) return json({
              request: SCENARIOS[0].request,
              answer: { ...makeAnswer('conflict-analysis', 'guided'), knowledge: { status: 'available', sources: [], policyResolution: resolution() } }
            });
            return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
          });
          await page.goto(`${base}/#knowledge`);
          await page.waitForFunction(() => document.querySelectorAll('.policy-family').length === 1);
          assert.equal(calls.filter(call => call.path === '/api/policies').length, 1);
          assert.equal(calls.filter(call => call.path === '/api/knowledge').length, 0);
          await page.locator('.policy-family > summary').click();
          for (const text of ['Historical · approved', 'Approved · date-eligible', 'Future · approved', 'Draft · not approved', 'browser-test-policy-set', 'Fictional policy stewardship']) {
            assert.match(await page.locator('#policy-register').textContent(), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          }
          await assertResponsivePage(page, 'Expanded policy register');
          await page.fill('#policy-date', '2026-09-11');
          await page.locator('#policy-date').blur();
          assert.match(await page.locator('#policy-availability').textContent(), /No new policy decision/);
          assert.equal(calls.filter(call => call.path === '/api/policies').length, 1, 'Reference date changes classify metadata locally without claiming a resolved policy');
          await page.fill('#policy-filter', 'no-such-policy');
          assert.match(await page.locator('#policy-register').textContent(), /No returned policy metadata matches/);
          await page.fill('#policy-filter', '');
          await page.locator('.policy-family > summary').click();
          await page.locator('.policy-family button').filter({ hasText: 'Prepare definition search' }).first().click();
          assert.equal(calls.filter(call => call.path === '/api/knowledge').length, 0);
          assert.equal(await page.inputValue('#knowledge-subject'), 'r017-rule');
          assert.equal(await page.inputValue('#knowledge-date'), '2026-11-01', 'Preparing the future version targets its effective start, not the September reference date.');
          await page.fill('#knowledge-date', '2026-09-30');
          await page.selectOption('#knowledge-province', 'QC');
          await page.fill('#knowledge-query', '   ');
          await page.click('#knowledge-submit');
          assert.match(await page.locator('#knowledge-results').textContent(), /No request was sent/);
          assert.equal(calls.filter(call => call.path === '/api/knowledge').length, 0);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'knowledge-query');
          await page.fill('#knowledge-query', 'R017');
          await page.click('#knowledge-submit');
          await page.waitForFunction(() => document.querySelector('#knowledge-results [data-policy-status="resolved"]'));
          assert.equal(calls.filter(call => call.path === '/api/knowledge').at(-1).params.province, 'QC');
          assert.equal(calls.filter(call => call.path === '/api/knowledge').at(-1).params.asOf, '2026-09-30');
          assert.match(await page.locator('#knowledge-results').textContent(), /Version 2\.3/);
          assert.match(await page.locator('#knowledge-results .source-coverage').textContent(), /1 resolved version is not cited/);
          await page.locator('#knowledge-results .source-applicability > summary').click();
          assert.match(await page.locator('#knowledge-results .source-applicability').textContent(), /except provinces QC/);
          await assertResponsivePage(page, 'Resolved policy sources and coverage');
          assert.equal(await page.locator('#knowledge-results script').count(), 0);

          failLookup = true;
          await page.click('#knowledge-submit');
          await page.waitForFunction(() => document.getElementById('knowledge-results').textContent.includes('Definitions could not be retrieved'));
          const failedRequest = calls.filter(call => call.path === '/api/knowledge').at(-1).params;
          assert.match(await page.locator('#knowledge-results').textContent(), /Failed lookup.*R017.*2026-09-30/s);
          assert.match(await page.locator('#knowledge-results').textContent(), /Province: QC/);
          assert.equal(await page.locator('#knowledge-results .citation').count(), 0, 'A failed refresh cannot retain old policy excerpts.');
          await assertResponsivePage(page, 'Scoped lookup outage');
          await page.fill('#knowledge-query', 'Draft lookup to review next');
          await page.fill('#knowledge-date', '2026-08-31');
          await page.selectOption('#knowledge-province', 'ON');
          const beforeRetry = calls.filter(call => call.path === '/api/knowledge').length;
          failLookup = false;
          await page.evaluate(() => {
            const retry = document.querySelector('#knowledge-results button');
            retry.click();
            retry.click();
          });
          await page.waitForFunction(() => document.querySelector('#knowledge-results [data-policy-status="resolved"]'));
          assert.equal(calls.filter(call => call.path === '/api/knowledge').length, beforeRetry + 1, 'Rapid retry activation sends only one request.');
          assert.deepEqual(calls.filter(call => call.path === '/api/knowledge').at(-1).params, failedRequest, 'Retry retains the exact submitted subject, scope and date.');
          assert.equal(await page.inputValue('#knowledge-query'), 'Draft lookup to review next', 'Retry does not overwrite a newly edited draft.');
          assert.equal(await page.inputValue('#knowledge-date'), '2026-08-31');
          assert.equal(await page.inputValue('#knowledge-province'), 'ON');
          assert.match(await page.locator('#knowledge-results').textContent(), /Effective as of 2026-09-30/);
          assert.match(await page.locator('#knowledge-results').textContent(), /Province: QC/);
          await page.fill('#knowledge-query', failedRequest.q);
          await page.fill('#knowledge-date', failedRequest.asOf);
          await page.selectOption('#knowledge-province', failedRequest.province);

          knowledgeStatus = 'conflict';
          await page.click('#knowledge-submit');
          await page.waitForFunction(() => document.querySelector('#knowledge-results [data-policy-status="conflict"]'));
          assert.match(await page.locator('#knowledge-results').textContent(), /Interpretation withheld/);
          assert.match(await page.locator('#knowledge-results').textContent(), /Conflicting version 2\.4/);
          assert.equal(await page.locator('#knowledge-results script').count(), 0);
          assert.match(await page.locator('#knowledge-results').textContent(), /cannot approve policies or send escalations/);
          await assertResponsivePage(page, 'Unresolved policy conflict');
          await page.locator('#primary-nav [data-page="investigate"]').click();
          await page.locator('[data-scenario-id]').first().click();
          await page.waitForFunction(() => document.getElementById('analysis-state').textContent === 'Response received');
          assert.equal(await page.locator('#analysis-content .metric-card').count() > 0, true, 'Policy conflict does not discard valid broker metrics');
          assert.equal(await page.locator('#analysis-content .comparison-chart').count(), 1);
          assert.equal(await page.locator('#analysis-content [data-policy-status="conflict"]').count(), 1);
          await assertResponsivePage(page, 'Analysis with numerical evidence and policy conflict');
          await page.locator('#analysis-content [data-evidence-button]').click();
          await page.waitForFunction(() => document.querySelector('#dialog-body .evidence-json'));
          assert.match(await page.locator('#dialog-body').textContent(), /stored API response, not a fresh policy decision/);
          await page.locator('#dialog-close').focus();
          await page.keyboard.press('Shift+Tab');
          assert.equal(await page.evaluate(() => document.getElementById('detail-dialog').contains(document.activeElement)), true);
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#detail-dialog').evaluate(node => node.open), false);
          assert.equal(await page.locator('#analysis-content [data-evidence-button]').evaluate(node => node === document.activeElement), true);

          await page.locator('#primary-nav [data-page="knowledge"]').click();
          await page.setViewportSize({ width: 390, height: 844 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.click('#theme-toggle');
          assert.equal(await page.locator('#theme-toggle').getAttribute('aria-label'), 'Switch to light theme');
          await page.locator('#knowledge-results .resolution-decisions').first().evaluate(node => { node.open = true; });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          knowledgeStatus = 'no-applicable-policy';
          await page.click('#knowledge-submit');
          await page.waitForFunction(() => document.querySelector('#knowledge-results [data-policy-status="no-applicable-policy"]'));
          assert.match(await page.locator('#knowledge-results').textContent(), /No applicable policy/);
          emptyCatalog = true;
          await page.click('#policy-refresh');
          await page.waitForFunction(() => document.getElementById('policy-register').textContent.includes('empty authorized policy register'));
          failCatalog = true;
          await page.click('#policy-refresh');
          await page.waitForFunction(() => document.getElementById('policy-register').textContent.includes('Policy register unavailable'));
          assert.match(await page.locator('#policy-register').textContent(), /HTTP 503/);
          assert.equal(await page.locator('.policy-family').count(), 0, 'No stale policy history survives a failed refresh');
          localMode = true;
          await page.locator('#service-details > summary').click();
          await page.click('#refresh-status');
          await page.waitForFunction(() => document.getElementById('identity').textContent === 'Local preview · No sign-in');
          assert.equal(await page.locator('#question-input').isDisabled(), true);
          await page.click('#connection-open');
          assert.match(await page.locator('#dialog-body').textContent(), /Local synthetic fixtures — not connected to Azure, Fabric or Foundry/);
          assert.match(await page.locator('#dialog-body').textContent(), /not connected to Azure SQL, Fabric or Foundry/);
          assert.doesNotMatch(await page.locator('#dialog-body').textContent(), /Initial scope is a small synthetic Azure SQL Database/);
          await page.keyboard.press('Escape');
          assert.deepEqual(errors, []);
          await page.close();
    });
  } finally {
    await browser.close();
  }
});

test('daily, concurrent and offline failures recover manually without spending automatic requests or showing stale metrics', { timeout: 90000 }, async () => {
 const browser = await chromium.launch({ channel: 'msedge', headless: true });
 const ruleRequest = SCENARIOS.find(scenario => scenario.request.kind === 'rule_quality').request;
 const zeroRules = calculate(ruleRequest, fixtureRows(ruleRequest).map(row => row.period === 'current'
   ? { ...row, adjudicated: 0, falsePositives: 0 } : row), { sourceAsOf: config.sourceAsOf, traceId: oid });
 try {
   await listening(server, async (base) => {
     const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
     const errors = [], calls = [];
     let mode = 'daily';
     page.on('pageerror', error => errors.push(error.message));
     await page.route('**/api/**', async (route) => {
       const pathname = new URL(route.request().url()).pathname;
       const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
       if (pathname === '/api/status') return json({
         ...status, localPreview: true, source: { type: 'local-synthetic-fixtures', label: 'Local browser-test fixture' },
         capabilities: { guided: true, knowledge: true, evidence: true, naturalLanguage: false },
       });
       if (pathname === '/api/scenarios') return json(SCENARIOS);
       if (pathname === '/api/analyze') {
         calls.push(route.request().postDataJSON());
         if (mode === 'offline') return route.abort('internetdisconnected');
         if (mode === 'ok') return json(makeAnswer('recovered', 'guided'));
         if (mode === 'undefined-rules') return json(makeAnswer('undefined-rules', 'guided', zeroRules));
         return route.fulfill({
           status: 429, contentType: 'application/json', headers: mode === 'daily' ? { 'Retry-After': '3600' } : {},
           body: JSON.stringify({ error: { code: mode === 'daily' ? 'DEMO_DAILY_LIMIT' : 'DEMO_BUSY', message: 'Synthetic quota fixture.' } }),
         });
       }
       return json({});
     });
     await page.goto(base);
     const scenario = page.locator('[data-scenario-id]').first();
     await page.waitForFunction(() => {
       const button = document.querySelector('[data-scenario-id]');
       return button !== null && !button.disabled;
     });
     await page.clock.install();
     await scenario.click();
     await page.waitForFunction(() => document.getElementById('analysis-content').textContent.includes('DEMO_DAILY_LIMIT'));
     const content = page.locator('#analysis-content');
     assert.match(await content.textContent(), /after midnight UTC/);
     assert.match(await content.textContent(), /Retry after 1 hour/);
     assert.match(await content.textContent(), /No automatic retry/);
     assert.doesNotMatch(await content.textContent(), /try again shortly/i);
     assert.equal(await content.locator('.metric-card').count(), 0);
     await page.clock.fastForward(3600000);
     assert.equal(calls.length, 1, 'Even an elapsed retry window must not auto-execute billable work.');
     await assertResponsivePage(page, 'Daily budget error');

     mode = 'busy';
     await content.getByRole('button', { name: 'Try again', exact: true }).focus();
     await page.keyboard.press('Enter');
     await page.waitForFunction(() => document.getElementById('analysis-content').textContent.includes('DEMO_BUSY'));
     assert.match(await content.textContent(), /Wait for one to finish/);
     assert.doesNotMatch(await content.textContent(), /Retry after \d/);
     assert.deepEqual(calls[1], calls[0], 'Manual retry preserves the exact original request.');

     mode = 'offline';
     await content.getByRole('button', { name: 'Try again', exact: true }).click();
     await page.waitForFunction(() => document.getElementById('analysis-content').textContent.includes('CONNECTION_FAILED'));
     assert.match(await content.textContent(), /local preview.*server is still running/s);
     assert.match(await content.textContent(), /No cached or sample answer/);
     assert.equal(await content.locator('.metric-card').count(), 0);
     await page.clock.fastForward(90000);
     assert.equal(calls.length, 3);
     await assertResponsivePage(page, 'Offline error');

     mode = 'ok';
     await content.getByRole('button', { name: 'Try again', exact: true }).click();
     await page.waitForFunction(() => document.getElementById('analysis-state').textContent === 'Response received');
     assert.equal(calls.length, 4);
     assert.deepEqual(calls[3], SCENARIOS[0].request);
     assert.ok(await content.locator('.metric-card').count() > 0);
     assert.equal(await content.locator('.notice.error').count(), 0);
     mode = 'undefined-rules';
     await page.locator('[data-scenario-id="rule-quality"]').click();
     await page.waitForFunction(() => document.querySelector('#analysis-content .answer-header h3')?.textContent.includes('cannot be ranked'));
     assert.equal(calls.length, 5);
     assert.deepEqual(calls[4], ruleRequest);
     assert.match(await content.locator('.metric-card').first().textContent(), /Current rule ranking.*Not applicable/s);
     assert.equal(await content.locator('.metric-value').filter({ hasText: /^Undefined$/ }).count(), 3);
     assert.equal(await content.locator('.metric-value').filter({ hasText: /^0$/ }).count(), 2);
     assert.equal(await content.locator('.comparison-chart').count(), 0, 'Undefined rates cannot become zero-height measured bars.');
     assert.match(await content.locator('tbody').textContent(), /Undefined/);
     await assertResponsivePage(page, 'Undefined rule ranking and historical table');
     assert.deepEqual(errors, []);
     await page.close();
   });
 } finally { await browser.close(); }
});
