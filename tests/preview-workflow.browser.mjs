import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startLocalPreview } from '../dev/local-preview.mjs';

test('real local backend powers policy-aware analyst browser workflows without API mocks', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fraud-browser-workflow-'));
  let preview, browser;
  try {
    preview = await startLocalPreview({ evidenceDirectory: directory });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    let knowledgeRequests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/knowledge') knowledgeRequests++;
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.url);
    await page.getByRole('button', { name: 'Run analysis: Explain the September loss change', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#identity').textContent.includes('Local preview'));
    assert.equal(await page.title(), 'Fraud Intelligence | Public synthetic demo');
    assert.equal(await page.locator('#ask-submit').isDisabled(), true, 'No simulated model planning is enabled.');
    assert.match(await page.locator('#identity').textContent(), /Local preview/);

    const pending = page.waitForResponse(response => response.url().endsWith('/api/analyze'));
    await page.getByRole('button', { name: 'Run analysis: Explain the September loss change', exact: true }).click();
    const received = await pending;
    assert.equal(received.status(), 200);
    const answer = await received.json();
    assert.equal(answer.provenance.sourceId, 'local-synthetic-fixtures-fraud-v1');
    assert.equal(answer.metrics.find(item => item.key === 'currentLoss').value, 1240000);
    assert.equal(answer.metrics.find(item => item.key === 'lossChangePercent').value, 24);
    assert.deepEqual(answer.knowledge.policyResolution.decisions.map(item => [item.period, item.version]), [
      ['previous', '4.0'], ['current', '4.1'],
    ]);
    assert.ok(answer.knowledge.policyResolution.decisions.every(item => typeof item.approvedAt === 'string'));
    await page.locator('.metric-card').first().waitFor();
    await page.locator('#analysis-content .resolution-decisions > summary').first().click();
    const policyDetails = await page.locator('#analysis-content .resolution-decisions').first().innerText();
    assert.match(policyDetails, /Approved at/);
    assert.ok(policyDetails.includes(answer.knowledge.policyResolution.decisions[0].approvedAt));
    const breakdown = page.getByRole('region', { name: 'Analysis breakdown, horizontally scrollable when needed' });
    const luminance = color => {
      const channels = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
      assert.equal(channels.length, 3);
      return channels.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    };
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.click('#theme-toggle');
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await breakdown.evaluate(node => { node.scrollLeft = 0; });
        await page.locator('#analysis-content .policy-segments > summary').focus();
        await page.keyboard.press('Tab');
        const focus = await breakdown.evaluate(node => {
          const style = getComputedStyle(node), parent = getComputedStyle(node.parentElement);
          return { active: document.activeElement === node, visible: node.matches(':focus-visible'),
            activeElement: document.activeElement.id || document.activeElement.className || document.activeElement.tagName,
            width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), style: style.outlineStyle,
            color: style.outlineColor, background: parent.backgroundColor,
            clipped: ['hidden', 'clip'].includes(parent.overflowX), scrollable: node.scrollWidth > node.clientWidth };
        });
        assert.equal(focus.active && focus.visible, true, `Keyboard reaches the named breakdown region at ${width}px in ${theme}: ${JSON.stringify(focus)}`);
        assert.ok(focus.width >= 2 && focus.style === 'solid');
        assert.ok(!focus.clipped || focus.offset + focus.width <= 0, `The table focus ring must fit inside its clipping panel at ${width}px in ${theme}.`);
        const colors = [luminance(focus.color), luminance(focus.background)].sort((a, b) => b - a);
        assert.ok((colors[0] + 0.05) / (colors[1] + 0.05) >= 3, 'Table focus indicator has at least 3:1 contrast.');
        if (focus.scrollable) {
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(() => document.querySelector('#analysis-content .table-scroll').scrollLeft > 0);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const evidenceResponse = page.waitForResponse(response => response.url().endsWith(answer.evidenceUrl));
    await page.getByRole('button', { name: 'Inspect evidence ↗', exact: true }).click();
    const stored = await (await evidenceResponse).json();
    assert.deepEqual(stored.answer, answer);
    const uppercaseEvidence = await page.request.get(`${preview.url}/api/evidence/${answer.answerId.toUpperCase()}`);
    assert.equal(uppercaseEvidence.status(), 200);
    assert.deepEqual(await uppercaseEvidence.json(), stored);
    assert.equal(stored.brokerReceipt.schemaVersion, 'broker-receipt-v1');
    assert.equal(createHash('sha256').update(JSON.stringify(stored.brokerReceipt.response)).digest('hex'), answer.provenance.brokerResponseSha256);
    assert.deepEqual(stored.brokerReceipt.response.metrics, answer.metrics);
    await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog[open]').innerText(), /synthetic-policy-set-2026-10-20-v1/);
    assert.match(await page.locator('dialog[open]').innerText(), /Broker response SHA-256/);
    assert.ok((await page.locator('dialog[open]').innerText()).includes(answer.provenance.brokerResponseSha256));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('#detail-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true, `Broker receipt metadata fits its dialog at ${width}px.`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 0);

    const ruleResponse = page.waitForResponse(response => response.url().endsWith('/api/analyze'));
    await page.getByRole('button', { name: 'Run analysis: Investigate alert false-positive share', exact: true }).click();
    const ruleHttp = await ruleResponse;
    assert.equal(ruleHttp.status(), 200);
    const ruleAnswer = await ruleHttp.json();
    assert.equal(ruleAnswer.metrics.find(item => item.key === 'focusRule').value, 'R017');
    await page.getByRole('heading', { name: ruleAnswer.narrative.headline, exact: true }).waitFor();
    const ruleRows = ruleAnswer.table.rows;
    for (let index = 1; index < ruleRows.length; index++) {
      const before = ruleRows[index - 1], after = ruleRows[index];
      if (before.currentAdjudicated === 0) assert.equal(after.currentAdjudicated, 0);
      else if (after.currentAdjudicated > 0) assert.ok(
        BigInt(before.currentFalsePositives) * BigInt(after.currentAdjudicated) >=
        BigInt(after.currentFalsePositives) * BigInt(before.currentAdjudicated));
    }
    assert.equal(await page.locator('#analysis-content tbody tr').first().locator('td').nth(0).textContent(), ruleRows[0].group);
    assert.equal(await page.locator('#analysis-content tbody tr').first().locator('td').nth(1).textContent(), ruleRows[0].ruleId);
    assert.match(await page.locator('#analysis-content .answer-details').innerText(), /ordered by exact current count ratios/);

    const catalogResponse = page.waitForResponse(response => response.url().endsWith('/api/policies'));
    await page.getByRole('link', { name: 'Rule library', exact: true }).click();
    const catalog = await (await catalogResponse).json();
    assert.equal(catalog.policies.length, 15);
    assert.equal(catalog.policies.some(item => item.policyId === 'restricted-governance'), false);
    await page.getByRole('heading', { name: '7 policy families · 15 of 15 authorized versions', exact: true }).waitFor();

    const ruleFamily = page.locator('.policy-family > summary').filter({ hasText: /^r017-rule/ });
    await ruleFamily.click();
    await ruleFamily.locator('..').getByRole('button', { name: 'Prepare definition search · 2026-11-01', exact: true }).click();
    assert.equal(await page.inputValue('#knowledge-date'), '2026-11-01');
    assert.equal(knowledgeRequests, 0, 'Preparing a future lookup does not execute a request.');
    const futureResponse = page.waitForResponse(response => response.url().includes('/api/knowledge?'));
    await page.getByRole('button', { name: 'Find definitions', exact: true }).click();
    const futureHttp = await futureResponse;
    assert.equal(futureHttp.status(), 200);
    const future = await futureHttp.json();
    assert.equal(future.policyResolution.asOf, '2026-11-01');
    assert.equal(future.policyResolution.status, 'resolved');
    assert.deepEqual(future.policyResolution.decisions.map(item => item.version), ['3.0']);
    assert.ok(future.sources.length > 0 && future.sources.every(item => item.version === '3.0'));

    async function lookup({ q, asOf, subject, province = '' }) {
      await page.getByRole('searchbox', { name: 'Definition or rule', exact: true }).fill(q);
      await page.getByLabel('Effective as of', { exact: true }).fill(asOf);
      await page.getByRole('combobox', { name: 'Policy subject', exact: true }).selectOption(subject);
      await page.getByRole('combobox', { name: 'Province scope', exact: true }).selectOption(province);
      const pending = page.waitForResponse(response => response.url().includes('/api/knowledge?'));
      await page.getByRole('button', { name: 'Find definitions', exact: true }).click();
      const response = await pending;
      assert.equal(response.status(), 200);
      const result = await response.json();
      await page.waitForFunction(({ q, asOf }) => {
        const text = document.querySelector('#knowledge-results').textContent;
        return text.includes(q) && text.includes(asOf);
      }, { q, asOf });
      return result;
    }

    const historical = await lookup({ q: 'August net fraud loss KPI', asOf: '2026-08-31', subject: 'loss-kpi' });
    assert.equal(historical.policyResolution.decisions[0].version, '4.0');
    const current = await lookup({ q: 'September net fraud loss KPI', asOf: '2026-09-01', subject: 'loss-kpi' });
    assert.equal(current.policyResolution.decisions[0].version, '4.1');
    const boundary = await lookup({ q: 'R017 rule boundary', asOf: '2026-09-12', subject: 'r017-rule' });
    assert.equal(boundary.policyResolution.decisions[0].version, '2.3');
    const scoped = await lookup({ q: 'QC R017 exception', asOf: '2026-09-22', subject: 'r017-rule', province: 'QC' });
    assert.equal(scoped.policyResolution.decisions[0].version, '2.4-qc');
    const conflict = await lookup({ q: 'Fictional unresolved policy overlap', asOf: '2026-09-15', subject: 'overlap-demo' });
    assert.equal(conflict.policyResolution.status, 'conflict');
    assert.deepEqual(conflict.policyResolution.conflicts[0].versions.map(item => item.version), ['1.0', '2.0']);
    const conflictDetails = await page.locator('#knowledge-results .resolution-decisions').first().innerText();
    assert.match(conflictDetails, /Approved at/);
    for (const version of conflict.policyResolution.conflicts[0].versions) {
      assert.equal(typeof version.approvedAt, 'string');
      assert.ok(conflictDetails.includes(version.approvedAt));
    }
    assert.equal(conflict.sources.length, 0);
    await page.locator('#knowledge-results').getByText('Unresolved policy conflict', { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No real policy-page overflow at ${width}px.`);
    }
    const expired = await lookup({ q: 'Expired policy gap', asOf: '2026-09-30', subject: 'expired-demo' });
    assert.equal(expired.policyResolution.status, 'no-applicable-policy');
    assert.equal(expired.sources.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (preview) await preview.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
