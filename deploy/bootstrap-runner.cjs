const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { lookup } = require('node:dns/promises');

const home = '/home/customer-bootstrap';
const project = path.join(home, 'project');
const cfg = JSON.parse(Buffer.from(process.env.BOOT_CONFIG_B64, 'base64').toString('utf8'));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const journalFile = path.join(home, 'journal.json');
fs.mkdirSync(home, { recursive: true });
let journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {
  deploymentId: cfg.deploymentId, packageHash: process.env.BOOT_PACKAGE_SHA256, steps: {}, attempt: null,
};
let phase = 'starting';
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ phase }));
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');
function save() {
  fs.writeFileSync(`${journalFile}.new`, JSON.stringify(journal, null, 2));
  fs.renameSync(`${journalFile}.new`, journalFile);
}
async function token(resource, clientId = cfg.bootstrap.clientId) {
  if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER) throw new Error('Managed identity endpoint unavailable.');
  const url = new URL(process.env.IDENTITY_ENDPOINT);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', resource);
  url.searchParams.set('client_id', clientId);
  const response = await fetch(url, {
    headers: { 'X-IDENTITY-HEADER': process.env.IDENTITY_HEADER }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Managed identity HTTP ${response.status}.`);
  const value = await response.json();
  if (!value.access_token) throw new Error('Managed identity token missing.');
  return value.access_token;
}
async function arm(method, resourcePath, body) {
  if (!resourcePath.toLowerCase().startsWith(`${cfg.groupResourceId.toLowerCase()}/providers/`)) throw new Error('ARM scope escaped customer resource group.');
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`https://management.azure.com${resourcePath}`, {
      method, headers: { Authorization: `Bearer ${await token('https://management.azure.com/')}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if ([403, 409, 429, 502, 503, 504].includes(response.status) && attempt < 19) {
      await response.body?.cancel(); await delay(15000); continue;
    }
    if (!response.ok) throw new Error(`ARM ${method} HTTP ${response.status}.`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}
async function mark(value) {
  phase = value;
  journal.phase = value;
  journal.updatedAt = new Date().toISOString();
  save();
  const current = await arm('GET', `${cfg.setupResourceId}?api-version=2023-12-01`);
  if (current.tags?.deploymentId !== cfg.deploymentId) throw new Error('Setup ownership changed.');
  await arm('PATCH', `${cfg.setupResourceId}?api-version=2023-12-01`, {
    tags: { ...current.tags, setupStatus: value, packageHash: journal.packageHash, updatedAt: journal.updatedAt },
  });
  console.log(JSON.stringify({ phase: value, at: journal.updatedAt }));
}
async function run(command, args, env, label, timeout = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + chunk.toString()).slice(-64000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      for (const secret of [process.env.BOOT_AAD_CLIENT_SECRET, process.env.BOOT_USER_TOKEN, process.env.IDENTITY_HEADER]) {
        if (secret) output = output.split(secret).join('[redacted]');
      }
      output = output.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
      fs.writeFileSync(path.join(home, `${label}.log`), output);
      code === 0 ? resolve() : reject(new Error(`${label} failed; inspect its private /home journal log. Exit ${code}.`));
    });
  });
}
function env(clientId) {
  return {
    PATH: process.env.PATH, HOME: home, NODE_ENV: 'production',
    IDENTITY_ENDPOINT: process.env.IDENTITY_ENDPOINT, IDENTITY_HEADER: process.env.IDENTITY_HEADER,
    AZURE_CLIENT_ID: clientId, SQL_SERVER: cfg.sqlHost, SQL_DATABASE: cfg.sqlDatabase,
    BROKER_CLIENT_ID: cfg.apps.find(app => app.role === 'broker').clientId, BROKER_SQL_USER: 'fraud_poc_broker',
    SOURCE_AS_OF: '2026-10-01T00:00:00Z', SEARCH_ENDPOINT: cfg.searchEndpoint, SEARCH_INDEX: cfg.searchIndex,
    KNOWLEDGE_MODE: 'hybrid', OPENAI_ENDPOINT: cfg.openaiEndpoint, EMBEDDING_DEPLOYMENT: cfg.embeddingDeployment,
    NPM_CONFIG_CACHE: path.join(home, 'npm-cache'),
  };
}
async function step(name, operation) {
  if (journal.steps[name]) return;
  await mark(name);
  await operation();
  journal.steps[name] = true; save();
}
async function assertPrivate(host) {
  const values = await lookup(host, { all: true });
  if (!values.length || values.some(value => !/^10\.87\.10\.\d+$/.test(value.address))) throw new Error('Dependency DNS must resolve exclusively to the private endpoint subnet.');
}
async function ensureIndex() {
  const { POLICY_SNAPSHOT } = await import(pathToFileURL(path.join(project, 'src/knowledge/policies.mjs')));
  const { validateExistingSnapshot, INVENTORY_FIELDS } = await import(pathToFileURL(path.join(project, 'deploy/portability.mjs')));
  if (cfg.searchIndex !== POLICY_SNAPSHOT.indexName) throw new Error('Infrastructure/runtime policy snapshot mismatch.');
  const base = `${cfg.searchEndpoint}/indexes/${cfg.searchIndex}`;
  const get = await fetch(`${base}?api-version=2024-07-01`, {
    headers: { Authorization: `Bearer ${await token('https://search.azure.com/')}` }, signal: AbortSignal.timeout(30000),
  });
  if (get.status === 404) {
    await run('node', ['seed/ingest.mjs'], env(cfg.bootstrap.clientId), 'seed-search');
  } else if (!get.ok) throw new Error(`Index inspection HTTP ${get.status}; no overwrite permitted.`);
  // Always revalidate, including resume after a partial upload. Never delete or overwrite an existing index.
  const schema = get.ok ? await get.json() : await (await fetch(`${base}?api-version=2024-07-01`, {
    headers: { Authorization: `Bearer ${await token('https://search.azure.com/')}` }, signal: AbortSignal.timeout(30000),
  })).json();
  const response = await fetch(`${base}/docs/search?api-version=2024-07-01`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token('https://search.azure.com/')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: '*', count: true, top: 65, select: INVENTORY_FIELDS.join(',') }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Existing snapshot could not be verified.');
  validateExistingSnapshot(schema, await response.json());
}
async function installSecret() {
  if (!process.env.BOOT_AAD_CLIENT_SECRET) throw new Error('Entra credential not supplied.');
  const response = await fetch(`${cfg.vaultUri}secrets/entra-web-client?api-version=7.4`, {
    method: 'PUT', headers: { Authorization: `Bearer ${await token('https://vault.azure.net')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: process.env.BOOT_AAD_CLIENT_SECRET, contentType: 'application/x-entra-client-secret',
      attributes: { enabled: true, exp: cfg.secretExpiresUnix } }), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Key Vault write HTTP ${response.status}.`);
  const id = (await response.json()).id;
  if (!id.startsWith(`${cfg.vaultUri}secrets/entra-web-client/`)) throw new Error('Unexpected Key Vault secret origin.');
  const web = cfg.apps.find(app => app.role === 'web');
  const resource = `${cfg.groupResourceId}/providers/Microsoft.Web/sites/${web.name}/config/appsettings`;
  const settings = await arm('POST', `${resource}/list?api-version=2023-12-01`);
  settings.properties.AAD_CLIENT_SECRET = `@Microsoft.KeyVault(SecretUri=${id})`;
  await arm('PUT', `${resource}?api-version=2023-12-01`, { properties: settings.properties });
  await arm('POST', `${cfg.groupResourceId}/providers/Microsoft.Web/sites/${web.name}/config/configreferences/appsettings/refresh?api-version=2023-12-01`);
}
async function deploy(app, zip) {
  const resource = `${cfg.groupResourceId}/providers/Microsoft.Web/sites/${app.name}`;
  await arm('POST', `${resource}/stop?api-version=2023-12-01`);
  let stopped = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const site = await arm('GET', `${resource}?api-version=2023-12-01`);
    if (site.properties.state === 'Stopped') { stopped = true; break; }
    await delay(5000);
  }
  if (!stopped) throw new Error('Old application did not stop. Refusing package cutover.');
  const origin = `https://${app.name}.scm.azurewebsites.net`;
  await assertPrivate(new URL(origin).hostname);
  const response = await fetch(`${origin}/api/zipdeploy?isAsync=true`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token('https://management.azure.com/')}`, 'Content-Type': 'application/zip' },
    body: zip, signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error(`ZIP deployment HTTP ${response.status}.`);
  const { checkedPollingUrl } = await import(pathToFileURL(path.join(project, 'deploy/portability.mjs')));
  if (!response.headers.get('location')) throw new Error('No deployment-specific Kudu completion URL.');
  const pollUrl = checkedPollingUrl(response.headers.get('location'), origin);
  let complete = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    await delay(5000);
    const poll = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${await token('https://management.azure.com/')}` }, signal: AbortSignal.timeout(30000),
    });
    if (!poll.ok) throw new Error(`Kudu polling HTTP ${poll.status}.`);
    const status = await poll.json();
    if (status.status === 3) throw new Error('Kudu deployment failed.');
    if (status.status === 4 && status.complete === true) { complete = true; break; }
  }
  if (!complete) throw new Error('Deployment completion deadline exceeded; application remains stopped.');
  await arm('POST', `${resource}/start?api-version=2023-12-01`);
  // No extra restart: settings updates already recycle the process.
}
async function readiness() {
  const web = cfg.apps.find(app => app.role === 'web');
  for (const app of cfg.apps) {
    await assertPrivate(new URL(app.url).hostname);
    let ready = false;
    const deadline = Date.now() + 900000; // Public status caches dependencies for five minutes.
    while (Date.now() < deadline) {
      try {
        const headers = app.role === 'web'
          ? cfg.publicDemoEnabled ? {} : { Authorization: `Bearer ${process.env.BOOT_USER_TOKEN}` }
          : { Authorization: `Bearer ${await token(`api://${cfg.authClientId}`, web.clientId)}`, 'x-fraud-user-oid': cfg.allowedUserOid };
        const response = await fetch(`${app.url}${app.role === 'web' ? '/api/status' : '/health/ready'}`, {
          headers, redirect: 'manual', signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
          const value = await response.json();
          if (app.role === 'web') ready = value.services?.broker?.status === 'ready' &&
            value.services?.knowledge?.status === 'ready' && value.services?.model?.status === 'ready' && value.services?.evidence?.status === 'ready';
          else ready = value.service?.status === 'ready' &&
            (app.role !== 'knowledge' || value.service.snapshotHash === cfg.snapshotHash);
          if (ready) break;
        }
      } catch { /* A bounded startup/propagation retry is not an acceptance result. */ }
      await delay(15000);
    }
    if (!ready) throw new Error(`${app.role} readiness did not converge within 15 minutes.`);
  }
}
async function main() {
  if (journal.deploymentId !== cfg.deploymentId || journal.packageHash !== process.env.BOOT_PACKAGE_SHA256) throw new Error('Pinned journal ownership/source mismatch.');
  if (journal.phase === 'succeeded') { await mark('succeeded'); return; }
  if (journal.attempt === process.env.BOOT_ATTEMPT) throw new Error('Interrupted attempt requires explicit Bootstrap -Resume; automatic mutation replay refused.');
  journal.attempt = process.env.BOOT_ATTEMPT; save();
  const count = Number(process.env.BOOT_PACKAGE_COUNT);
  if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error('Archive chunk limit exceeded.');
  const encoded = Array.from({ length: count }, (_, index) => process.env[`BOOT_PACKAGE_${String(index).padStart(3, '0')}`] || '').join('');
  const archive = Buffer.from(encoded, 'base64');
  if (archive.length > 1048576 || digest(archive) !== journal.packageHash) throw new Error('Archive size/hash mismatch.');
  const archivePath = path.join(home, 'source.tgz');
  fs.writeFileSync(archivePath, archive); fs.mkdirSync(project, { recursive: true });
  await run('tar', ['-xzf', archivePath, '-C', project], { PATH: process.env.PATH }, 'extract');
  await step('installing', () => run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], env(cfg.bootstrap.clientId), 'npm-ci'));
  for (const host of [cfg.sqlHost, new URL(cfg.searchEndpoint).hostname, new URL(cfg.openaiEndpoint).hostname,
    new URL(cfg.vaultUri).hostname, new URL(cfg.storageUrl).hostname]) await assertPrivate(host);
  await step('seeding-sql', () => run('node', ['seed/seed.mjs'], env(cfg.bootstrap.clientId), 'seed-sql'));
  await step('proving-sql-readonly', () => run('node', ['seed/verify-readonly.mjs'],
    env(cfg.apps.find(app => app.role === 'broker').clientId), 'sql-readonly'));
  await mark('verifying-policy-index'); await ensureIndex();
  await step('configuring-signin', installSecret);
  const zipFile = path.join(home, 'runtime.zip');
  await step('packaging', () => run('python3', ['-c', [
    'import pathlib, zipfile',
    `root = pathlib.Path(${JSON.stringify(project)})`,
    `with zipfile.ZipFile(${JSON.stringify(zipFile)}, "w", zipfile.ZIP_DEFLATED) as z:`,
    ' for name in ("package.json", "package-lock.json", "src", "node_modules"):',
    '  p = root / name',
    '  for f in ([p] if p.is_file() else sorted(p.rglob("*"))):',
    '   if f.is_file(): z.write(f, f.relative_to(root).as_posix())',
    `with zipfile.ZipFile(${JSON.stringify(zipFile)}) as z:`,
    ' assert z.testzip() is None, "ZIP CRC verification failed"',
  ].join('\n')], { PATH: process.env.PATH }, 'runtime-zip'));
  const zip = fs.readFileSync(zipFile);
  for (const role of ['broker', 'knowledge', 'web']) {
    await step(`deploying-${role}`, () => deploy(cfg.apps.find(app => app.role === role), zip));
  }
  await mark('readiness'); await readiness();
  await mark('acceptance');
  await run('node', ['deploy/cloud-acceptance.mjs'], {
    ...env(cfg.bootstrap.clientId), POC_CONFIG: JSON.stringify(cfg), POC_USER_TOKEN: process.env.BOOT_USER_TOKEN || '',
  }, 'cloud-acceptance', 1800000);
  const result = JSON.parse(fs.readFileSync(path.join(project, 'cloud-acceptance.json'), 'utf8'));
  if (result.allApiChecksPassed !== true || result.policyReleaseVerified !== true || result.failures?.length) throw new Error('API/policy acceptance report is not passed.');
  journal.acceptance = { outcome: result.outcome, checks: result.checks.length, snapshotHash: cfg.snapshotHash };
  await mark('succeeded');
}
const watchdog = setTimeout(async () => {
  try { await mark('failed'); } finally { process.exit(1); }
}, 5400000);
main().catch(async error => {
  journal.error = String(error.message).slice(0, 240);
  try { await mark('failed'); } catch { save(); }
  console.error(JSON.stringify({ phase: 'failed', error: journal.error }));
}).finally(() => clearTimeout(watchdog));
