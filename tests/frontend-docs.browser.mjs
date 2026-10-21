import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startLocalPreview } from '../dev/local-preview.mjs';

test('platform documentation is reachable, scoped and usable without analytics services', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fraud-platform-docs-'));
  let preview, browser;
  try {
    preview = await startLocalPreview({ evidenceDirectory: directory });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [], costlyRequests = [], externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (['/api/ask', '/api/analyze', '/api/knowledge', '/api/policies'].includes(url.pathname)) costlyRequests.push(url.pathname);
      if (url.origin !== preview.url) externalRequests.push(request.url());
    });
    await page.goto(preview.url);
    await page.getByRole('button', { name: 'Run analysis: Explain the September loss change', exact: true }).waitFor();
    const navigation = page.locator('#primary-nav a[data-page="documentation"]');
    await navigation.click();
    const docs = page.locator('#page-documentation');
    await docs.waitFor({ state: 'visible' });
    assert.equal(await navigation.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#documentation-title').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.page:visible').count(), 1);
    assert.equal(await docs.locator('[data-capability]').count(), 6);
    for (const id of ['data', 'governance', 'models', 'grounding', 'evaluation', 'security']) {
      const card = docs.locator(`[data-capability="${id}"]`);
      assert.match(await card.innerText(), /Platform provides/);
      assert.match(await card.innerText(), /Configure or integrate/);
      assert.ok(await card.locator('a[href^="https://learn.microsoft.com/"]').count() >= 2);
    }
    const content = await docs.innerText();
    assert.match(content, /Fabric and Foundry are target platforms, not deployed migrations/);
    assert.match(content, /correct numerical answers/i);
    assert.match(content, /approximately 1 TB/i);
    assert.match(content, /diagnostic/i);
    assert.match(content, /licens/i);
    assert.match(content, /not policy citations or answer evidence/i);
    const links = await docs.locator('a[href^="https://"]').evaluateAll(nodes => nodes.map(node => ({
      url: node.href, target: node.target, rel: node.rel, label: node.textContent,
      description: node.getAttribute('aria-describedby'),
    })));
    assert.equal(links.length, 18);
    for (const link of links) {
      const url = new URL(link.url);
      assert.equal(url.hostname, 'learn.microsoft.com');
      assert.equal(url.protocol, 'https:');
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      assert.equal(link.target, '_blank');
      assert.ok(link.rel.split(' ').includes('noopener'));
      assert.ok(link.rel.split(' ').includes('noreferrer'));
      assert.equal(link.description, 'documentation-link-note');
      assert.ok(link.label.trim().length > 10);
    }
    assert.deepEqual(externalRequests, [], 'Documentation is not embedded or fetched on page load.');
    assert.deepEqual(costlyRequests, [], 'Browsing reference docs does not consume analysis or policy quota.');

    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.click('#theme-toggle');
      for (const width of [320, 390, 768, 1001, 1100, 1200, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Documentation fits at ${width}px in ${theme}.`);
      }
    }
    await page.click('#assistant-open-header');
    for (const width of [1101, 1200, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Documentation fits beside the assistant at ${width}px.`);
    }
    await page.click('#assistant-close');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.click('#menu-toggle');
    await page.locator('#primary-nav a[data-page="investigate"]').click();
    await page.locator('#page-investigate').waitFor({ state: 'visible' });
    await page.click('#menu-toggle');
    await navigation.focus();
    await page.keyboard.press('Enter');
    await docs.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#documentation-title').evaluate(node => node === document.activeElement), true);

    await context.route('https://learn.microsoft.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Documentation navigation fixture</title>',
    }));
    const opened = context.waitForEvent('page');
    await docs.locator('a[href^="https://"]').first().focus();
    await page.keyboard.press('Enter');
    const popup = await opened;
    await popup.waitForURL(links[0].url, { waitUntil: 'domcontentloaded' });
    assert.equal(popup.url(), links[0].url);
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(await popup.evaluate(() => document.referrer), '');
    await popup.close();
    assert.match(page.url(), /#documentation$/);
    assert.deepEqual(costlyRequests, []);

    await page.route('**/api/**', route => route.abort('failed'));
    await page.goto(`${preview.url}/#documentation`);
    await docs.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#connection-alert').textContent.includes('unavailable'));
    assert.equal(await docs.locator('a[href^="https://"]').count(), links.length);
    assert.equal(await navigation.getAttribute('aria-current'), 'page');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (preview) await preview.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
