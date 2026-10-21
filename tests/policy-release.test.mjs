import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparePolicyRelease } from '../deploy/prepare-policy-release.mjs';
import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';
import { METRIC_VERSION, TEMPLATE_VERSION } from '../src/broker/metrics.mjs';

test('release preparation freezes only approved source inputs and cannot deploy or overwrite', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fraud-release-test-'));
  try {
    const root = path.join(temporary, 'project');
    const output = path.join(temporary, 'releases');
    for (const folder of ['src', 'seed', 'dev', 'deploy']) await mkdir(path.join(root, folder), { recursive: true });
    await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(root, name), '{}');
    await writeFile(path.join(root, 'src', 'example.mjs'), 'export const synthetic = true;\n');
    await writeFile(path.join(root, 'seed', 'fixture.sql'), 'SELECT 1;\n');
    await writeFile(path.join(root, 'dev', 'preview.mjs'), 'not part of production');
    await writeFile(path.join(root, 'deploy', 'private-state.json'), 'must not be packaged');
    const now = new Date('2026-10-20T03:30:00Z');
    const result = await preparePolicyRelease({ root, outputDirectory: output, now });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.deployed, false);
    assert.deepEqual(manifest.runtimeRoles, ['web', 'broker', 'knowledge']);
    assert.equal(manifest.metricVersion, METRIC_VERSION);
    assert.equal(manifest.templateVersion, TEMPLATE_VERSION);
    assert.ok(manifest.activationRequirements.some(step => /broker source-snapshot integrity/.test(step)));
    assert.equal(manifest.policySnapshotHash, POLICY_SNAPSHOT.snapshotHash);
    assert.equal(manifest.targetSearchIndex, POLICY_SNAPSHOT.indexName);
    assert.equal(manifest.runtimeContract.schemaVersion, 'fraud-runtime-contract-v3');
    assert.equal(manifest.runtimeContract.sha256,
      manifest.files.find(file => file.path === 'src/runtime-contract.json').sha256);
    assert.ok(manifest.files.some(file => file.path === 'src/knowledge/policy-manifest.mjs'));
    assert.ok(manifest.files.some(file => file.path === 'src/example.mjs'));
    assert.ok(manifest.files.some(file => file.path === 'seed/fixture.sql'));
    assert.ok(manifest.files.every(file => /^(package(-lock)?\.json|src\/|seed\/)/.test(file.path)));
    assert.equal(manifest.archive.sha256, createHash('sha256').update(await readFile(result.archivePath)).digest('hex'));
    const contents = spawnSync('tar.exe', ['-tzf', result.archivePath], { encoding: 'utf8' });
    assert.equal(contents.status, 0, contents.stderr);
    assert.match(contents.stdout, /src\/example\.mjs/);
    assert.match(contents.stdout, /src\/runtime-contract\.json/);
    assert.doesNotMatch(contents.stdout, /preview|private-state|node_modules/);
    await assert.rejects(preparePolicyRelease({ root, outputDirectory: output, now }), { code: 'EEXIST' });
    assert.equal(JSON.parse(await readFile(result.manifestPath, 'utf8')).policySnapshotHash, manifest.policySnapshotHash);
    await writeFile(path.join(root, 'src', '.env'), 'unexpected configuration');
    await assert.rejects(preparePolicyRelease({ root, outputDirectory: output, now: new Date(now.getTime() + 1000) }), /Unexpected release source/);
    assert.equal((await readdir(output)).length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('release preparation requires an explicit absolute output path', async () => {
  await assert.rejects(preparePolicyRelease(), /absolute release output/);
  await assert.rejects(preparePolicyRelease({ outputDirectory: 'relative' }), /absolute release output/);
});

test('release preparation rejects stale or unsafe runtime-contract metadata before producing an archive', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fraud-contract-test-'));
  try {
    const root = path.join(temporary, 'project'), output = path.join(temporary, 'releases');
    await mkdir(path.join(root, 'seed'), { recursive: true });
    await writeFile(path.join(root, 'seed', 'fixture.sql'), 'SELECT 1;\n');
    await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(root, name), '{}');
    const filename = path.join(root, 'src', 'runtime-contract.json');
    const original = await readFile(filename, 'utf8');
    const mutations = [
      value => { value.roleConfiguration.knowledge.SEARCH_INDEX = 'fraud-knowledge-v1'; },
      value => { value.schemaVersion = 'fraud-runtime-contract-v2'; },
      value => { value.knowledgeContract.schemaVersion = 'old-policy-schema'; },
      value => { value.knowledgeContract.registry = 'fabric'; },
      value => { value.knowledgeContract.policySetVersion = 'old-policy-set'; },
      value => { value.knowledgeContract.indexName = 'fraud-knowledge-v1'; },
      value => { value.knowledgeContract.chunkCount = 6; },
      value => { value.knowledgeContract.snapshotHash = '0'.repeat(64); },
      value => { value.sqlContract.metrics = 'fraud-metrics-1.0.0'; },
      value => { value.sqlContract.templates = 'old-template'; },
      value => { value.runtime.roles = ['web', 'knowledge']; },
      value => { value.releaseControl.publicationRequiresExplicitApproval = false; },
      value => { value.releaseControl.sourceOnly = false; },
      value => { value.releaseControl.deployed = true; },
      value => { value.releaseControl.bootstrapFinalized = false; },
      value => { value.knowledgeContract.ingestion.createOnly = false; },
      value => { value.knowledgeContract.ingestion.activateOnSeedSuccess = true; },
      value => { value.knowledgeContract.ingestion.requireSeparateIngestionIdentity = false; },
      value => { value.knowledgeContract.legacyIndexMayServeThisRuntime = true; },
      value => { value.knowledgeContract.ingestion.retainLegacyIndex = false; },
      value => { value.releaseControl.sqlReseedRequired = true; },
      value => { value.platformStatus.deployedDataPlatform = 'microsoft-fabric'; },
      value => { value.platformStatus.deployedModelPlatform = 'microsoft-foundry'; },
      value => { value.platformStatus.targetDataPlatform = 'azure-sql-database'; },
      value => { value.platformStatus.targetModelPlatform = 'azure-openai'; },
      value => { value.seedCommands.searchEnvironment = ['SEARCH_INDEX=fraud-knowledge-v1']; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const value = JSON.parse(original);
      mutate(value);
      await writeFile(filename, JSON.stringify(value));
      await assert.rejects(preparePolicyRelease({ root, outputDirectory: output,
        now: new Date(Date.UTC(2026, 9, 20, 5, 10, index)) }), /Runtime contract/);
      assert.deepEqual(await readdir(output), [], 'A rejected contract cannot leave a deployable-looking partial release.');
    }
    await writeFile(filename, original);
    const release = await preparePolicyRelease({ root, outputDirectory: output, now: new Date('2026-10-20T05:11:00Z') });
    const manifest = JSON.parse(await readFile(release.manifestPath, 'utf8'));
    assert.equal(manifest.runtimeContract.schemaVersion, 'fraud-runtime-contract-v3');
    assert.equal(manifest.runtimeContract.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(manifest.deployed, false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
