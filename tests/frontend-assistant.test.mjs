import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validateQuestion } from '../src/validation.mjs';

const [html, script, css, catalog] = await Promise.all(
  ['index.html', 'app.js', 'styles.css', 'user-stories.json']
    .map(name => readFile(new URL(`../src/web/public/${name}`, import.meta.url), 'utf8')),
);

test('public assistant keeps one bounded composer without browser identity or storage', () => {
  assert.equal([...html.matchAll(/id="ask-form"/g)].length, 1);
  assert.equal([...html.matchAll(/id="question-input"/g)].length, 1);
  assert.match(html, /id="question-input"[^>]*maxlength="1000"/);
  assert.match(html, /id="assistant-toggle"[^>]*aria-controls="assistant-panel"[^>]*aria-expanded="false"/);
  assert.match(html, /<dialog id="assistant-panel"[^>]*aria-labelledby="assistant-title"/);
  assert.match(html, /Each question stands alone/);
  assert.match(html, /Public demo · No sign-in/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|x-ms-client-principal|x-fraud-user|Authorization\s*:/i);
  assert.match(script, /credentials: "omit"/);
  assert.match(script, /if \(state\.analyzing \|\| !analysisAllowed\(requiredCapability\)\) return/);
  assert.match(script, /state\.turns\.length > 8/);
  assert.match(script, /response\.status === 429/);
  assert.match(script, /response\.status === 503/);
  assert.doesNotMatch(`${script}\n${catalog}`, /Entra-authenticated|provisioned private-network access|authenticated entry point|Confirm server identity/i);
  assert.match(css, /body\.assistant-open \{ overflow: hidden; \}/);
});

test('assistant suggestions are standalone supported synthetic month comparisons, not generated answers', () => {
  const match = script.match(/const supportedQuestions = (\[[\s\S]*?\n  \]);/);
  assert(match);
  const questions = runInNewContext(match[1]);
  assert.equal(questions.length, 3);
  for (const { label, question } of questions) {
    assert(label);
    assert.equal(validateQuestion(question), question);
    assert.match(question, /August.*September 2026|September 2026.*August 2026/);
    assert.match(question, /channel|province/);
    assert.match(question, /fraud losses|adjudicated-alert false-positive share/);
  }
  assert.match(script, /renderMetrics\(answer\.metrics\)/);
  assert.match(script, /renderSources\(sources\)/);
  assert.match(script, /showEvidence\(answer\)/);
  assert.match(script, /runAnalysis\("\/api\/ask", \{ question \}, question, "natural-language"\)/);
});

test('retry guidance handles seconds and HTTP dates without guessing missing or malformed cooldowns', () => {
  const start = script.indexOf('  function retryAfterHint(');
  assert(start >= 0, 'Retry guidance must have an independently exercised parser.');
  const source = script.slice(start, script.indexOf('\n  }', start) + 4);
  const { retryAfterHint } = runInNewContext(`${source}\n({ retryAfterHint })`);
  const now = Date.parse('2026-10-20T04:00:00Z');
  assert.equal(retryAfterHint('10', now), ' Retry after 10 seconds.');
  assert.equal(retryAfterHint('Tue, 20 Oct 2026 04:01:00 GMT', now), ' Retry after 60 seconds.');
  assert.equal(retryAfterHint('3601', now), ' Retry after 1 hour 1 minute.');
  assert.equal(retryAfterHint('86400', now), ' Retry after 24 hours.');
  for (const value of [null, '', 'invalid', '-2', '0', '1.5', 'Infinity', '999999999999999999', 'Tue, 20 Oct 2026 03:59:00 GMT']) {
    assert.equal(retryAfterHint(value, now), '', `No fabricated cooldown for ${value}`);
  }
});
