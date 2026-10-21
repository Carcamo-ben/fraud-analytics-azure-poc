import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const allowedExtensions = new Set(['.mjs', '.js', '.json', '.txt', '.sql', '.html', '.css', '.svg', '.png', '.ico']);
const digest = data => createHash('sha256').update(data).digest('hex');

async function sourceFiles(root, relativeDirectory) {
  const files = [];
  const directory = path.join(root, relativeDirectory);
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Expected source directory: ${relativeDirectory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release source cannot contain a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, relative));
    else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name)) && !entry.name.startsWith('.')) files.push(relative);
    else throw new Error(`Unexpected release source file: ${relative}`);
  }
  return files.sort();
}

function validateRuntimeContract(contract, snapshot, metricVersion, templateVersion) {
  const knowledge = contract?.knowledgeContract, release = contract?.releaseControl, ingestion = knowledge?.ingestion;
  const roles = contract?.runtime?.roles;
  const expected = { schemaVersion: snapshot.schemaVersion, registry: 'synthetic-policy-manifest',
    policySetVersion: snapshot.policySetVersion, snapshotHash: snapshot.snapshotHash,
    indexName: snapshot.indexName, chunkCount: snapshot.documents.length };
  if (contract?.schemaVersion !== 'fraud-runtime-contract-v3' ||
      !Array.isArray(roles) || roles.length !== 3 || !['web', 'broker', 'knowledge'].every(role => roles.includes(role)) ||
      Object.entries(expected).some(([field, value]) => knowledge?.[field] !== value) ||
      knowledge.legacyIndexMayServeThisRuntime !== false ||
      contract.roleConfiguration?.knowledge?.SEARCH_INDEX !== snapshot.indexName ||
      contract.sqlContract?.metrics !== metricVersion || contract.sqlContract?.templates !== templateVersion ||
      release?.sourceOnly !== true || release.deployed !== false || release.publicationRequiresExplicitApproval !== true ||
      release.bootstrapFinalized !== true || release.sqlReseedRequired !== false ||
      ingestion?.createOnly !== true || ingestion.activateOnSeedSuccess !== false ||
      ingestion.retainLegacyIndex !== true || ingestion.requireSeparateIngestionIdentity !== true ||
      !Array.isArray(contract.seedCommands?.searchEnvironment) ||
      !contract.seedCommands.searchEnvironment.includes(`SEARCH_INDEX=${snapshot.indexName}`) ||
      contract.platformStatus?.deployedDataPlatform !== 'azure-sql-database' ||
      contract.platformStatus?.deployedModelPlatform !== 'azure-openai' ||
      contract.platformStatus?.targetDataPlatform !== 'microsoft-fabric' ||
      contract.platformStatus?.targetModelPlatform !== 'microsoft-foundry') {
    throw new Error('Runtime contract does not match the frozen policy, metric or safe activation requirements.');
  }
}

export async function preparePolicyRelease({ root = projectRoot, outputDirectory, now = new Date() } = {}) {
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error('An absolute release output directory is required.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('A valid release timestamp is required.');
  const inputs = ['package.json', 'package-lock.json', ...await sourceFiles(root, 'src'), ...await sourceFiles(root, 'seed')];
  const name = `fraud-policy-release-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const directory = path.join(outputDirectory, name);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(directory);
  const stage = path.join(directory, 'source');
  const archivePath = path.join(directory, `${name}.tgz`);
  const manifestPath = path.join(directory, 'release-manifest.json');
  try {
    await mkdir(stage);
    const files = [];
    for (const relative of inputs) {
      const source = path.join(root, relative);
      if (!(await lstat(source)).isFile()) throw new Error(`Release input must be a regular file: ${relative}`);
      const before = await readFile(source);
      const target = path.join(stage, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      if (digest(await readFile(target)) !== digest(before)) throw new Error(`Source changed while packaging: ${relative}`);
      files.push({ path: relative.replaceAll(path.sep, '/'), bytes: before.length, sha256: digest(before) });
    }
    // All application roles must use one unchanged source snapshot.
    for (const file of files) {
      if (digest(await readFile(path.join(root, file.path))) !== file.sha256) throw new Error(`Source changed before release freeze: ${file.path}`);
    }
    const { POLICY_SNAPSHOT: snapshot } = await import(pathToFileURL(path.join(stage, 'src', 'knowledge', 'policies.mjs')).href);
    const { METRIC_VERSION, TEMPLATE_VERSION } = await import(pathToFileURL(path.join(stage, 'src', 'broker', 'metrics.mjs')).href);
    const runtimeContractText = await readFile(path.join(stage, 'src', 'runtime-contract.json'), 'utf8');
    const runtimeContract = JSON.parse(runtimeContractText);
    validateRuntimeContract(runtimeContract, snapshot, METRIC_VERSION, TEMPLATE_VERSION);
    const archive = spawnSync('tar.exe', ['-czf', archivePath, '-C', stage, 'package.json', 'package-lock.json', 'src', 'seed'], { encoding: 'utf8', windowsHide: true });
    if (archive.error) throw archive.error;
    if (archive.status !== 0) throw new Error(`Release archive failed: ${archive.stderr.trim()}`);
    const manifest = {
      schemaVersion: 'fraud-policy-release-v1',
      preparedAt: now.toISOString(),
      packageType: 'source-only; install locked dependencies on the target Linux build host',
      deployed: false,
      syntheticOnly: true,
      runtimeRoles: ['web', 'broker', 'knowledge'],
      metricVersion: METRIC_VERSION,
      templateVersion: TEMPLATE_VERSION,
      runtimeContract: { schemaVersion: runtimeContract.schemaVersion, sha256: digest(runtimeContractText) },
      policySetVersion: snapshot.policySetVersion,
      policySnapshotHash: snapshot.snapshotHash,
      targetSearchIndex: snapshot.indexName,
      chunkCount: snapshot.documents.length,
      archive: { name: path.basename(archivePath), sha256: digest(await readFile(archivePath)) },
      activationRequirements: [
        'User review and explicit approval before public publication.',
        'Seed and verify the new private, version-specific Search index without changing the legacy index.',
        'Build and stage matching web, broker and knowledge applications from this source snapshot.',
        'Retain the existing private service identity, source read-only controls, request budgets, and authentication settings.',
        'Verify broker source-snapshot integrity and expected metrics, authenticated knowledge readiness, policy catalog snapshot, historical/conflict/scoped retrieval, and evidence roundtrip.',
        'Switch matching application/index versions together; retain prior artifacts and index for coordinated rollback.',
      ],
      platformStatus: {
        data: 'Existing synthetic Azure SQL Database; no Fabric migration performed.',
        models: 'Existing Azure OpenAI deployment; no Foundry migration performed.',
      },
      files,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { directory, archivePath, manifestPath, files: files.length, policySetVersion: manifest.policySetVersion };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-directory') {
    throw new Error('Usage: node deploy\\prepare-policy-release.mjs --output-directory ABSOLUTE_PATH');
  }
  console.log(JSON.stringify(await preparePolicyRelease({ outputDirectory: args[1] })));
}
