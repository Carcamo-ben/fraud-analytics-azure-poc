import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateConfig, validateModels, assertLifecycle, assertOwned, validateExistingSnapshot, checkedPollingUrl, sha256,
} from '../deploy/portability.mjs';
import { POLICY_SNAPSHOT } from '../src/knowledge/policies.mjs';
import { policyIndexDefinition } from '../src/knowledge/search-schema.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const template = JSON.parse(read('azuredeploy.json'));
const script = read('deploy/Deploy.ps1');
const runner = read('deploy/bootstrap-runner.cjs');
const fresh = () => ({
  ...JSON.parse(read('deploy/customer.example.json')),
  subscriptionId: randomUUID(), authClientId: randomUUID(), allowedUserOid: randomUUID(), sqlAdminObjectId: randomUUID(),
  sqlAdminLogin: 'Customer SQL Administrators', ownerTag: 'Customer team', reviewAfter: '2027-01-01',
});
test('customer parameters are mandatory, target-specific and closed to unknown configuration', () => {
  assert.throws(() => validateConfig(JSON.parse(read('deploy/customer.example.json'))));
  const good = fresh();
  assert.deepEqual(validateConfig(good), good);
  for (const patch of [
    { subscriptionId: '' }, { authClientId: '00000000-0000-0000-0000-000000000000' }, { resourceGroup: '../other' },
    { location: 'eastus' }, { aiLocation: 'global' }, { chatCapacity: 0 }, { embeddingCapacity: 1.2 },
    { embeddingModelName: 'text-embedding-3-large' }, { sqlAdminPrincipalType: 'Application' },
    { ownerTag: '' }, { reviewAfter: '2027-02-30' }, { secret: 'must-not-be-in-config' },
  ]) assert.throws(() => validateConfig({ ...good, ...patch }), JSON.stringify(patch));
});
test('anonymous synthetic identity is an explicit opt-in, never a default or an existing user', () => {
  const good = fresh();
  assert.equal(validateConfig(good).publicDemoEnabled, false);
  for (const patch of [
    { publicDemoEnabled: 'false' }, { publicDemoEnabled: true },
    { publicDemoEnabled: true, publicDemoUserOid: good.allowedUserOid },
    { publicDemoUserOid: randomUUID() },
  ]) assert.throws(() => validateConfig({ ...good, ...patch }));
  assert.equal(validateConfig({ ...good, publicDemoEnabled: true, publicDemoUserOid: randomUUID() }).publicDemoEnabled, true);
  assert.equal(template.parameters.publicDemoEnabled.defaultValue, false);
  assert.equal(template.parameters.bootstrapEnabled.defaultValue, false);
  assert.match(script, /if \(\$Phase -eq 'Finalize' -and \$cfg\.publicDemoEnabled\)/);
});
test('public demo identity collisions are rejected regardless of GUID letter casing', () => {
  const good = fresh();
  const lower = `a${randomUUID().slice(1)}`;
  for (const field of ['allowedUserOid', 'sqlAdminObjectId', 'authClientId']) {
    for (const [identity, synthetic] of [[lower, lower.toUpperCase()], [lower.toUpperCase(), lower]]) {
      assert.throws(() => validateConfig({
        ...good, [field]: identity, publicDemoEnabled: true, publicDemoUserOid: synthetic,
      }), /distinct randomly generated synthetic user UUID/, field);
    }
  }
  const distinct = `b${randomUUID().slice(1)}`.toUpperCase();
  const accepted = { ...good, publicDemoEnabled: true, publicDemoUserOid: distinct };
  assert.deepEqual(validateConfig(accepted), accepted, 'Distinct GUIDs remain valid and original configuration casing is preserved.');
});
test('Canadian regional Standard model metadata and quota must explicitly match', () => {
  const config = fresh();
  const records = ['chat', 'embedding'].map(kind => ({ model: {
    name: config[`${kind}ModelName`], version: config[`${kind}ModelVersion`],
    skus: [{ name: 'Standard', usageName: `quota-${kind}`, capacity: { minimum: 1, maximum: 100, step: 1 } }],
  } }));
  const usages = ['chat', 'embedding'].map(kind => ({ name: { value: `quota-${kind}` }, currentValue: 0, limit: 100 }));
  validateModels(config, records, usages);
  assert.throws(() => validateModels(config, [], usages));
  const global = structuredClone(records); global[0].model.skus[0].name = 'GlobalStandard';
  assert.throws(() => validateModels(config, global, usages), /fallback/);
  const exhausted = structuredClone(usages); exhausted[0].currentValue = 100;
  assert.throws(() => validateModels(config, records, exhausted), /quota/);
  validateModels(config, records, exhausted, { existing: true });
  assert.throws(() => validateModels({ ...config, chatModelVersion: 'not-offered' }, records, usages));
  assert.throws(() => validateModels(config, records, []), /metadata/);
});
test('state pins customer configuration and refuses finalized bootstrap reruns', () => {
  const config = fresh();
  const state = { configHash: sha256(JSON.stringify(validateConfig(config))), deploymentId: randomUUID(), phase: 'initialized' };
  assertLifecycle(state, config, 'Provision');
  assert.throws(() => assertLifecycle(state, { ...config, subscriptionId: randomUUID() }, 'Provision'), /pinned/);
  for (const phase of ['finalized', 'aborted']) {
    assert.throws(() => assertLifecycle({ ...state, phase }, config, 'Bootstrap'), /Finalized/);
    assert.throws(() => assertLifecycle({ ...state, phase }, config, 'Provision'), /Finalized/);
    assertLifecycle({ ...state, phase }, config, 'Status');
  }
  assert.match(script, /Finalized bootstrap cannot be reactivated/);
  assert.match(runner, /Interrupted attempt requires explicit Bootstrap -Resume/);
  assert.match(runner, /journal\.packageHash !== process\.env\.BOOT_PACKAGE_SHA256/);
  assert.match(script, /Bootstrap runner changed since submission/);
});
test('cleanup cannot cross target or delete unowned resources and privileges', () => {
  const deploymentId = randomUUID(), groupId = `/subscriptions/${randomUUID()}/resourceGroups/sample`;
  const resource = { id: `${groupId}/providers/Microsoft.Web/sites/sample`, tags: { deploymentId } };
  assertOwned(resource, deploymentId, groupId);
  assert.throws(() => assertOwned(resource, randomUUID(), groupId));
  assert.throws(() => assertOwned({ ...resource, id: resource.id.replace('/sample/', '/other/') }, deploymentId, groupId));
  assert.match(script, /Unexpected bootstrap assignment/);
  assert.match(script, /SQL administrator changed independently/);
  assert.match(script, /setupStatus -ne 'succeeded'.*packageHash -ne \$state\.sourceHash/);
  assert.match(script, /Missing accepted checkpoint/);
  assert.doesNotMatch(script, /group', 'delete|--assignee.*delete|Remove-Item.*Recurse/);
});
test('checked-in template uses current immutable 16-chunk policy snapshot', () => {
  assert.equal(POLICY_SNAPSHOT.documents.length, 16);
  assert.equal(POLICY_SNAPSHOT.indexName, 'fraud-policy-f17745ee4ea35aba');
  assert(read('infra/main.bicep').includes(`SEARCH_INDEX: '${POLICY_SNAPSHOT.indexName}'`));
  assert(JSON.stringify(template).includes(POLICY_SNAPSHOT.indexName));
  assert.doesNotMatch(JSON.stringify(template), /fraud-knowledge-v1/);
});
test('resume verifies full immutable index schema, metadata, ACL and content without mutation', () => {
  const schema = policyIndexDefinition(POLICY_SNAPSHOT, 'hybrid', 1536);
  const inventory = { '@odata.count': POLICY_SNAPSHOT.documents.length, value: structuredClone(POLICY_SNAPSHOT.documents) };
  validateExistingSnapshot(schema, inventory);
  for (const change of [
    data => data.value.pop(),
    data => { data.value[0].allowedRoles = ['PolicyOwner']; },
    data => { data.value[0].content += 'tampered'; },
    data => { data['@odata.nextLink'] = 'https://example.invalid'; },
    data => { data.value[0].snapshotHash = 'wrong'; },
    data => { data.value[1] = data.value[0]; },
  ]) {
    const bad = structuredClone(inventory); change(bad);
    assert.throws(() => validateExistingSnapshot(schema, bad));
  }
  const badSchema = structuredClone(schema); badSchema.fields.find(field => field.name === 'contentVector').dimensions = 3072;
  assert.throws(() => validateExistingSnapshot(badSchema, inventory));
  assert.match(runner, /get\.status === 404/);
  assert.match(runner, /validateExistingSnapshot\(schema, await response\.json\(\)\)/);
  assert.doesNotMatch(runner, /method: 'DELETE'|\/docs\/index/);
});
test('deployment is Linux-built, stopped-before-cutover and waits full readiness, not liveness', () => {
  assert.match(runner, /'ci', '--omit=dev', '--ignore-scripts'/);
  assert.match(runner, /seed\/verify-readonly\.mjs/);
  assert.match(runner, /env\(cfg\.apps\.find\(app => app\.role === 'broker'\)\.clientId\)/);
  assert.match(runner, /site\.properties\.state === 'Stopped'/);
  assert(runner.indexOf("`${resource}/stop?") < runner.indexOf('/api/zipdeploy'));
  assert.match(runner, /status\.status === 4 && status\.complete === true/);
  assert.match(runner, /Date\.now\(\) \+ 900000/);
  assert.doesNotMatch(runner, /\/health\/live/);
  assert.match(runner, /z\.testzip\(\) is None/);
  assert.match(runner, /result\.allApiChecksPassed !== true/);
  assert.match(runner, /result\.policyReleaseVerified !== true/);
  assert.match(script, /package\.json package-lock\.json src seed deploy\/cloud-acceptance\.mjs deploy\/portability\.mjs/);
});
test('Kudu tokens only reach the configured HTTPS origin and deployment-specific path', () => {
  const origin = 'https://sample.scm.azurewebsites.net';
  assert.equal(checkedPollingUrl('http://sample.scm.azurewebsites.net/api/deployments/abc-123', origin), `${origin}/api/deployments/abc-123`);
  for (const value of ['https://evil.invalid/api/deployments/abc', '/api/command', 'https://user@sample.scm.azurewebsites.net/api/deployments/abc']) {
    assert.throws(() => checkedPollingUrl(value, origin));
  }
});
test('template keeps private endpoints, disabled local auth, private diagnostics and least-scope roles', () => {
  const resources = template.resources;
  for (const type of ['Microsoft.Search/searchServices', 'Microsoft.CognitiveServices/accounts', 'Microsoft.Sql/servers', 'Microsoft.Storage/storageAccounts', 'Microsoft.KeyVault/vaults']) {
    const resource = resources.find(item => item.type === type);
    assert.equal(resource.properties.publicNetworkAccess.toLowerCase(), 'disabled', type);
  }
  assert.equal(resources.find(item => item.type === 'Microsoft.OperationalInsights/workspaces').properties.publicNetworkAccessForIngestion, 'Disabled');
  assert.equal(resources.find(item => item.type === 'Microsoft.Insights/components').properties.DisableLocalAuth, true);
  assert(resources.some(item => item.type === 'Microsoft.Insights/diagnosticSettings'));
  const sites = resources.find(item => item.type === 'Microsoft.Web/sites');
  assert.equal(sites.properties.publicNetworkAccess, 'Disabled');
  for (const assignment of resources.filter(item => item.type === 'Microsoft.Authorization/roleAssignments')) {
    assert(assignment.scope, 'No resource-group role assignments.');
    assert.doesNotMatch(assignment.properties.roleDefinitionId, /b24988ac|8e3af657/);
    if (JSON.stringify(assignment.properties.principalId).includes('bootstrap')) assert.equal(assignment.condition, "[parameters('bootstrapEnabled')]");
  }
});
test('deployment files contain no local user paths, lab target identifiers, or local secrets', () => {
  const files = ['infra/main.bicep', 'azuredeploy.json', 'deploy/Deploy.ps1', 'deploy/bootstrap-runner.cjs', 'deploy/customer.example.json', 'infra/azuredeploy.parameters.example.json'];
  for (const file of files) {
    assert.doesNotMatch(read(file), /C:\\\\?Users\\|onmicrosoft\.com/i, file);
  }
  assert.doesNotMatch(script, /Set-Content[^\r\n]*(secret|token)|secretText\s*=\s*\$state/i);
  assert.match(script, /No response body is printed/);
  assert.match(script, /BOOT_AAD_CLIENT_SECRET = \$secret/);
  assert.match(script, /Arm DELETE "\$\(\$state\.setupId\)/);
});
test('compiled ARM semantically matches Bicep when VERIFY_BICEP_BUILD=1', { skip: process.env.VERIFY_BICEP_BUILD !== '1' }, () => {
  const file = fileURLToPath(new URL('../infra/main.bicep', import.meta.url));
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'az bicep build --file infra\\main.bicep --stdout --only-show-errors'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    })
    : spawnSync('az', ['bicep', 'build', '--file', file, '--stdout', '--only-show-errors'], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'templateHash').map(([key, item]) =>
      [key, key === 'dependsOn' ? [...new Set(item)].sort() : normalize(item)]));
  };
  assert.deepEqual(normalize(JSON.parse(result.stdout)), normalize(template), 'Run Deploy.ps1 -Phase Build and check in azuredeploy.json with its Bicep source.');
});
for (const [name, args] of [
  ['private finalize', []], ['explicit public finalize', ['-PublicDemo']],
  ['abort removes setup access', ['-Outcome', 'Abort']], ['abort before provisioning', ['-Outcome', 'AbortBeforeProvision']],
  ['owned private-endpoint NIC permits provision retry', ['-Scenario', 'OwnedEndpointNic']],
  ['unreferenced sibling NIC is rejected', ['-Scenario', 'UnrelatedNic']],
  ['private-endpoint NIC backlink mismatch is rejected', ['-Scenario', 'WrongNicBacklink']],
  ['private-endpoint NIC missing backlink is rejected', ['-Scenario', 'MissingNicBacklink']],
  ['private-endpoint NIC cannot escape the pinned group', ['-Scenario', 'CrossGroupNic']],
  ['interrupted inert host resumes without BOOT settings', ['-Scenario', 'InertResume']],
]) {
  test(`PowerShell mocked lifecycle: ${name}`, { skip: process.platform !== 'win32' }, t => {
    const executable = process.env.DEPLOYMENT_TEST_PWSH || 'pwsh';
    const result = spawnSync(executable, ['-NoProfile', '-File', fileURLToPath(new URL('./deployment-mock.ps1', import.meta.url)), ...args], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    });
    if (result.error?.code === 'ENOENT' && !process.env.DEPLOYMENT_TEST_PWSH) return t.skip('PowerShell 7 is required for the supported Windows workflow; install it or set DEPLOYMENT_TEST_PWSH.');
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /MOCK FLOW PASSED/);
  });
}
