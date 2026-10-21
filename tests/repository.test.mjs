import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');

test('public sample pins its supported toolchain and excludes customer deployment state', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(pkg.engines.node, '>=22 <23');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, true);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(lock.packages[''].devDependencies.playwright, pkg.devDependencies.playwright);
  const ignored = (await read('.gitignore')).split(/\r?\n/);
  for (const item of ['.deployment/', 'node_modules/', '.env', '*.pfx', '*.publishsettings']) assert(ignored.includes(item));
  assert.match(pkg.scripts['test:browser'], /--test-concurrency=1/);
});

test('Deploy to Azure points at the public checked-in template and documents the bootstrap boundary', async () => {
  const readme = await read('README.rst');
  const target = readme.match(/:target: (https:\/\/portal\.azure\.com\/#create\/Microsoft\.Template\/uri\/\S+)/);
  assert(target);
  assert.equal(decodeURIComponent(target[1].split('/uri/')[1]),
    'https://raw.githubusercontent.com/Carcamo-ben/fraud-analytics-azure-poc/main/azuredeploy.json');
  const template = JSON.parse(await read('azuredeploy.json'));
  assert.equal(template.parameters.publicDemoEnabled.defaultValue, false);
  assert.equal(template.parameters.bootstrapEnabled.defaultValue, false);
  assert.match(readme, /button provisions infrastructure only/i);
  const deployment = await read('docs/deployment.rst');
  for (const phase of ['Validate', 'Initialize', 'Provision', 'Bootstrap', 'Status', 'Finalize', 'Abort']) {
    assert(deployment.includes(`-Phase ${phase}`), `Missing documented ${phase} command`);
  }
  assert.match(deployment, /setupStatus.*succeeded/);
  assert.match(deployment, /30 days/);
  assert.match(deployment, /does \*\*not\*\* delete billable infrastructure/);
});

test('customer documentation links resolve inside the repository', async () => {
  for (const name of ['README.rst', 'docs/deployment.rst', 'docs/architecture.rst', 'SECURITY.rst']) {
    const content = await read(name);
    for (const match of content.matchAll(/<([^<>]+)>`_/g)) {
      if (/^https?:\/\//.test(match[1])) continue;
      const resolved = path.resolve(root, path.dirname(name), match[1]);
      assert(resolved.startsWith(root), `Documentation link must stay in the sample: ${match[1]}`);
      await access(resolved);
    }
  }
});
