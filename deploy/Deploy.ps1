#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Build', 'Validate', 'Initialize', 'Provision', 'Bootstrap', 'Status', 'Finalize', 'Abort')]
    [string]$Phase,
    [string]$Config,
    [string]$PortalDeploymentName,
    [switch]$Resume
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$api = '2023-12-01'
function Invoke-AzJson([string[]]$Arguments) {
    $result = & az @Arguments --only-show-errors --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed ($($Arguments[0]) $($Arguments[1])); no success recorded. Check sign-in, permissions and deployment operations." }
    if ($result) { return ($result -join "`n" | ConvertFrom-Json -AsHashtable) }
}
function Control([string]$Method, [string]$Uri, $Body = $null, [switch]$Allow404) {
    if (!$Uri.StartsWith('https://management.azure.com/') -and !$Uri.StartsWith('https://graph.microsoft.com/v1.0/')) { throw 'Untrusted control-plane origin.' }
    $resource = if ($Uri.StartsWith('https://graph.')) { 'https://graph.microsoft.com/' } else { 'https://management.azure.com/' }
    $token = Invoke-AzJson @('account', 'get-access-token', '--subscription', $cfg.subscriptionId, '--resource', $resource)
    $arguments = @{
        Uri = $Uri; Method = $Method; Headers = @{ Authorization = 'Bearer ' + $token.accessToken }
        TimeoutSec = 120; SkipHttpErrorCheck = $true
    }
    if ($null -ne $Body) { $arguments.ContentType = 'application/json'; $arguments.Body = ($Body | ConvertTo-Json -Depth 60 -Compress) }
    $response = Invoke-WebRequest @arguments
    $token = $null; $arguments = $null
    if ($Allow404 -and $response.StatusCode -eq 404) { return $null }
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "Control-plane $Method failed: HTTP $($response.StatusCode). No response body is printed (may contain sensitive data)." }
    if ($response.Content) { return ($response.Content | ConvertFrom-Json -AsHashtable) }
}
function Arm([string]$Method, [string]$Path, $Body = $null, [switch]$Allow404) {
    if (!$Path.StartsWith($groupId + '/', [StringComparison]::OrdinalIgnoreCase)) { throw 'ARM operation outside the pinned resource group.' }
    return Control $Method ('https://management.azure.com' + $Path) $Body -Allow404:$Allow404
}
function Save-State {
    $state.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $state.updatedUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $state | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath ($statePath + '.new') -Encoding utf8NoBOM
    Move-Item -LiteralPath ($statePath + '.new') -Destination $statePath -Force
}
function Assert-Owned($Resource) {
    if (!$Resource -or $Resource.tags.deploymentId -ne $state.deploymentId -or
        !$Resource.id.StartsWith($groupId + '/', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Resource ownership/target mismatch. Refusing mutation or cleanup.'
    }
}
function Assert-OwnedInventory($Resources) {
    $owned = @($Resources | Where-Object { $_['tags'] -and $_['tags']['deploymentId'] -eq $state.deploymentId })
    $endpointNics = @{}
    $unownedNics = @($Resources | Where-Object {
        $_.type -ieq 'Microsoft.Network/networkInterfaces' -and
        (!$_['tags'] -or $_['tags']['deploymentId'] -ne $state.deploymentId)
    })
    if ($unownedNics.Count -gt 0) {
        foreach ($endpoint in $owned | Where-Object type -ieq 'Microsoft.Network/privateEndpoints') {
            Assert-Owned $endpoint
            $details = Arm GET "$($endpoint.id)?api-version=2024-05-01"
            Assert-Owned $details
            if ($details.id -ine $endpoint.id -or $details.type -ine 'Microsoft.Network/privateEndpoints' -or
                $details['properties'] -isnot [System.Collections.IDictionary]) {
                throw 'Private endpoint ownership response mismatch.'
            }
            foreach ($reference in @($details['properties']['networkInterfaces'])) {
                if ($null -eq $reference) { continue }
                $nicId = $reference['id']
                if ($nicId -isnot [string] -or $nicId -notmatch ("(?i)^" + [regex]::Escape($groupId) + '/providers/Microsoft\.Network/networkInterfaces/[^/?#]+$')) {
                    throw 'Private endpoint references a NIC outside the pinned resource group.'
                }
                if ($endpointNics.ContainsKey($nicId) -and $endpointNics[$nicId] -ine $endpoint.id) {
                    throw 'NIC is claimed by more than one owned private endpoint.'
                }
                $endpointNics[$nicId] = $endpoint.id
            }
        }
    }
    foreach ($item in $Resources) {
        if ($item['tags'] -and $item['tags']['deploymentId'] -eq $state.deploymentId) { Assert-Owned $item; continue }
        if ($item.type -ieq 'Microsoft.Network/networkInterfaces' -and $endpointNics.ContainsKey($item.id)) {
            if ($item['tags'] -and $item['tags']['deploymentId']) { throw 'Private endpoint NIC has a conflicting deployment owner.' }
            $nic = Arm GET "$($item.id)?api-version=2024-05-01"
            if ($nic.id -ine $item.id -or $nic.type -ine 'Microsoft.Network/networkInterfaces' -or
                $nic['properties'] -isnot [System.Collections.IDictionary] -or
                $nic['properties']['privateEndpoint'] -isnot [System.Collections.IDictionary] -or
                $nic['properties']['privateEndpoint']['id'] -ine $endpointNics[$item.id]) {
                throw 'NIC does not reference the owned private endpoint that claimed it.'
            }
            continue
        }
        $parents = @($owned | Where-Object { $item.id.StartsWith($_.id + '/', [StringComparison]::OrdinalIgnoreCase) })
        if ($parents.Count -eq 0) { throw 'Unowned resource appeared in the reserved resource group. Refusing to overwrite an existing customer resource.' }
    }
}
function Set-Lifecycle([string]$Value) {
    foreach ($app in $state.deployment.apps) {
        $id = "$groupId/providers/Microsoft.Web/sites/$($app.name)"
        $site = Arm GET "${id}?api-version=$api"
        Assert-Owned $site
        $site.tags.deploymentLifecycle = $Value
        Arm PATCH "${id}?api-version=$api" @{ tags = $site.tags } | Out-Null
    }
}
function Check-Models([switch]$Existing) {
    $models = Invoke-AzJson @('cognitiveservices', 'model', 'list', '--subscription', $cfg.subscriptionId, '--location', $cfg.aiLocation)
    $usage = Invoke-AzJson @('cognitiveservices', 'usage', 'list', '--subscription', $cfg.subscriptionId, '--location', $cfg.aiLocation)
    ConvertTo-Json -InputObject @($models) -Depth 50 | Set-Content (Join-Path $work 'models.json') -Encoding utf8NoBOM
    ConvertTo-Json -InputObject @($usage) -Depth 50 | Set-Content (Join-Path $work 'quota.json') -Encoding utf8NoBOM
    $mode = if ($Existing) { 'models-existing' } else { 'models' }
    & node (Join-Path $PSScriptRoot 'portability.mjs') $mode $Config (Join-Path $work 'models.json') (Join-Path $work 'quota.json') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Regional model/version/quota validation failed. No Global or DataZone fallback.' }
}
function Find-AppRegistration {
    $filter = [uri]::EscapeDataString("appId eq '$($cfg.authClientId)'")
    $result = Control GET ('https://graph.microsoft.com/v1.0/applications?$filter=' + $filter)
    if (@($result.value).Count -ne 1 -or $result.value[0].signInAudience -ne 'AzureADMyOrg') { throw 'Supply a dedicated, owned, single-tenant Entra app registration in the subscription tenant.' }
    return $result.value[0]
}
function Setup-Registration {
    $app = Find-AppRegistration
    if (@($app.identifierUris | Where-Object { $_ -ne "api://$($cfg.authClientId)" }).Count -gt 0 -or
        @($app.api.oauth2PermissionScopes | Where-Object { $_.value -ne 'access_as_user' }).Count -gt 0 -or
        @($app.api.preAuthorizedApplications | Where-Object { $_.appId -ne '04b07795-8ddb-461a-bbee-02f9e1bf7b46' }).Count -gt 0) {
        throw 'Use a dedicated application; refusing to replace unrelated API scopes or authorizations.'
    }
    $scope = @($app.api.oauth2PermissionScopes | Where-Object value -eq 'access_as_user')
    $scopeId = if ($scope.Count -eq 1) { $scope[0].id } else { [guid]::NewGuid().ToString() }
    $definition = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{
            id = $scopeId; value = 'access_as_user'; type = 'User'; isEnabled = $true
            adminConsentDisplayName = 'Access synthetic fraud analytics'; adminConsentDescription = 'Access this synthetic sample as the signed-in user.'
            userConsentDisplayName = 'Access synthetic fraud analytics'; userConsentDescription = 'Access this synthetic sample as you.'
        })
    }
    $appUri = "https://graph.microsoft.com/v1.0/applications/$($app.id)"
    Control PATCH $appUri @{ identifierUris = @("api://$($cfg.authClientId)"); api = $definition } | Out-Null
    $definition.preAuthorizedApplications = @(@{ appId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; delegatedPermissionIds = @($scopeId) })
    Control PATCH $appUri @{ api = $definition } | Out-Null
    $filter = [uri]::EscapeDataString("appId eq '$($cfg.authClientId)'")
    $principals = Control GET ('https://graph.microsoft.com/v1.0/servicePrincipals?$filter=' + $filter)
    if (@($principals.value).Count -eq 0) { Control POST 'https://graph.microsoft.com/v1.0/servicePrincipals' @{ appId = $cfg.authClientId } | Out-Null }
    $state.applicationObjectId = $app.id
    Save-State
}
function Get-OwnedResources {
    $items = Invoke-AzJson @('resource', 'list', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup)
    return @($items | Where-Object { $_['tags'] -and $_['tags']['deploymentId'] -eq $state.deploymentId })
}
function Recover-PartialDeployment {
    if ($state.deployment) { return }
    $exists = Invoke-AzJson @('group', 'exists', '--subscription', $cfg.subscriptionId, '--name', $cfg.resourceGroup)
    if (!$exists) { $state.deployment = @{ apps = @(); bootstrap = $null; sqlServer = $null }; return }
    $resources = Get-OwnedResources
    $identity = @($resources | Where-Object { $_.type -ieq 'Microsoft.ManagedIdentity/userAssignedIdentities' -and $_.name -like '*-bootstrap-mi' })
    if ($identity.Count -gt 1) { throw 'Ambiguous bootstrap identity; no cleanup attempted.' }
    if ($identity.Count -eq 0) {
        if (@($resources | Where-Object type -ieq 'Microsoft.Sql/servers').Count -gt 0) { throw 'SQL exists without identifiable bootstrap state; operator review required.' }
        $state.deployment = @{ apps = @(); bootstrap = $null; sqlServer = $null }
        return
    }
    $mi = Arm GET ($identity[0].id + '?api-version=2023-01-31')
    $base = $mi.name -replace '-bootstrap-mi$', ''
    $state.deployment = @{
        apps = @($resources | Where-Object { $_.type -ieq 'Microsoft.Web/sites' -and $_.name -in @("$base-web", "$base-broker", "$base-knowledge") } | ForEach-Object { @{ name = $_.name } })
        bootstrap = @{ identityId = $mi.id; principalId = $mi.properties.principalId; name = "$base-setup" }
        sqlServer = @($resources | Where-Object type -ieq 'Microsoft.Sql/servers' | ForEach-Object { $_.name }) | Select-Object -First 1
    }
    Save-State
}
function Get-TemporaryRoles {
    if (!$state.deployment.bootstrap) { return @() }
    $principal = $state.deployment.bootstrap.principalId
    $assignments = @(Invoke-AzJson @('role', 'assignment', 'list', '--subscription', $cfg.subscriptionId, '--assignee-object-id', $principal, '--all'))
    $resources = Get-OwnedResources
    $allowed = @{}
    foreach ($resource in $resources) {
        switch ($resource.type.ToLowerInvariant()) {
            'microsoft.web/sites' { $allowed[$resource.id.ToLowerInvariant()] = @('de139f84-1756-47ae-9be6-808fbbe84772') }
            'microsoft.search/searchservices' { $allowed[$resource.id.ToLowerInvariant()] = @('8ebe5a00-799e-43f5-93ac-243d3dce84a7', '7ca78c08-252a-4471-8644-bb5ff32d4ba0') }
            'microsoft.cognitiveservices/accounts' { $allowed[$resource.id.ToLowerInvariant()] = @('5e0bd9bd-7b93-4f28-af87-19fc36ad61bd') }
            'microsoft.keyvault/vaults' { $allowed[$resource.id.ToLowerInvariant()] = @('b86a8fe4-44ce-4948-aee5-eccb2c155cd7') }
            'microsoft.storage/storageaccounts' { $allowed[($resource.id + '/blobServices/default/containers/artifacts').ToLowerInvariant()] = @('ba92f5b4-2d11-453d-a403-e96b0029c9fe') }
        }
    }
    # A deleted setup host still has the exact recorded temporary assignment scope.
    if ($state.setupId) { $allowed[$state.setupId.ToLowerInvariant()] = @('de139f84-1756-47ae-9be6-808fbbe84772') }
    foreach ($assignment in $assignments) {
        $scope = $assignment.scope.ToLowerInvariant()
        $role = ($assignment.roleDefinitionId -split '/')[-1]
        if ($assignment.principalId -ne $principal -or !$allowed.ContainsKey($scope) -or $role -notin $allowed[$scope]) { throw 'Unexpected bootstrap assignment. Refusing to delete privileges not owned by this deployment.' }
    }
    return $assignments
}
function Handoff-Sql {
    if (!$state.deployment.sqlServer) { return }
    $id = "$groupId/providers/Microsoft.Sql/servers/$($state.deployment.sqlServer)"
    Assert-Owned (Arm GET "${id}?api-version=2023-08-01")
    $uri = "$id/administrators/ActiveDirectory?api-version=2023-08-01"
    $admin = Arm GET $uri
    if ($admin.properties.sid -notin @($cfg.sqlAdminObjectId, $state.deployment.bootstrap.principalId)) { throw 'SQL administrator changed independently. Refusing to overwrite it.' }
    if ($admin.properties.sid -ne $cfg.sqlAdminObjectId) {
        Arm PUT $uri @{ properties = @{
            administratorType = 'ActiveDirectory'; principalType = $cfg.sqlAdminPrincipalType
            login = $cfg.sqlAdminLogin; sid = $cfg.sqlAdminObjectId; tenantId = $state.tenantId
            azureADOnlyAuthentication = $true
        } } | Out-Null
    }
    for ($i = 0; $i -lt 60; $i++) {
        $admin = Arm GET $uri
        if ($admin.properties.sid -eq $cfg.sqlAdminObjectId) { return }
        Start-Sleep -Seconds 5
    }
    throw 'SQL administrator handoff did not converge; bootstrap cleanup remains incomplete.'
}
function Read-Setup {
    if (!$state.deployment.bootstrap) { return $null }
    $state.setupId = "$groupId/providers/Microsoft.Web/sites/$($state.deployment.bootstrap.name)"
    $site = Arm GET "$($state.setupId)?api-version=$api" -Allow404
    if ($site) { Assert-Owned $site }
    return $site
}
function Read-Outputs {
    $deployment = Invoke-AzJson @('deployment', 'group', 'show', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup, '--name', $state.armDeploymentName)
    if ($deployment.properties.provisioningState -ne 'Succeeded') { throw 'Infrastructure deployment is not Succeeded.' }
    $output = $deployment.properties.outputs.deployment.value
    if ($output.subscriptionId -ne $cfg.subscriptionId -or $output.resourceGroup -ne $cfg.resourceGroup -or
        $output.deploymentId -ne $state.deploymentId -or $output.authClientId -ne $cfg.authClientId) { throw 'ARM output target mismatch.' }
    $output.apps = $deployment.properties.outputs.apps.value
    $output.snapshotHash = $validated.snapshotHash
    $output.groupResourceId = $groupId
    $output.setupResourceId = "$groupId/providers/Microsoft.Web/sites/$($output.bootstrap.name)"
    $state.deployment = $output
    $output | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $work 'outputs.json') -Encoding utf8NoBOM
    Save-State
}

foreach ($tool in @('az', 'node', 'tar')) { if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Install $tool and restart PowerShell 7." } }
$nodeMajor = & node -p 'process.versions.node.split(".")[0]'
if ($nodeMajor -ne '22') { throw 'Use Node.js 22 for the supported deployment workflow.' }
if ($Phase -eq 'Build') {
    & az bicep build --file (Join-Path $root 'infra\main.bicep') --outfile (Join-Path $root 'azuredeploy.json') --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Bicep build failed. Install Bicep with az bicep install only if missing.' }
    Write-Output 'Built azuredeploy.json from infra\main.bicep (local only).'
    return
}
if (!$Config) { throw '-Config is required; copy deploy\customer.example.json to .deployment\customer.json and fill customer values.' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$raw = & node (Join-Path $PSScriptRoot 'portability.mjs') config $Config
if ($LASTEXITCODE -ne 0) { throw 'Local configuration validation failed. No Azure operation was attempted.' }
$validated = $raw | ConvertFrom-Json -AsHashtable
$cfg = $validated.config
$groupId = "/subscriptions/$($cfg.subscriptionId)/resourceGroups/$($cfg.resourceGroup)"
$work = Join-Path $root ".deployment\$($cfg.subscriptionId)-$($cfg.resourceGroup)"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$statePath = Join-Path $work 'state.json'
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable } else { $null }
$account = Invoke-AzJson @('account', 'show', '--subscription', $cfg.subscriptionId)
if ($account.id -ne $cfg.subscriptionId -or $account.environmentName -ne 'AzureCloud') { throw 'Expected subscription in public Azure; sovereign clouds are not supported.' }
if ($state) {
    if ($state.configHash -ne $validated.configHash -or $state.tenantId -ne $account.tenantId) { throw 'Configuration/tenant differs from pinned state. Never edit or reuse state for another target.' }
    if ($state.phase -in @('finalized', 'aborted') -and $Phase -notin @('Status', 'Finalize', 'Abort')) { throw 'Finalized bootstrap cannot be reactivated. Use a new deployment.' }
}
if ($Phase -eq 'Validate') {
    Check-Models
    Find-AppRegistration | Out-Null
    Write-Output 'Configuration, subscription tenant, dedicated Entra registration and Canadian Standard model/version/quota metadata validated. Capacity allocation is not guaranteed.'
    return
}
if ($Phase -eq 'Initialize') {
    if ($state) {
        if ($state.phase -ne 'initializing') { throw 'State already initialized; continue with Provision, Bootstrap, Status, Finalize or Abort.' }
        if ($PortalDeploymentName -and $state.portalDeploymentName -ne $PortalDeploymentName) { throw 'Portal adoption target differs from pinned initialization state.' }
    } else {
        $state = @{
            schemaVersion = 1; configHash = $validated.configHash; deploymentId = [guid]::NewGuid().ToString()
            tenantId = $account.tenantId; phase = 'initializing'; deployment = $null
            setupId = $null; setupRoleId = $null; sourceHash = $null; runnerHash = $null; acceptedHash = $null; bootstrapSubmittedAt = $null
            secretKeyId = $null; secretExpiresAt = $null; secretExpiresUnix = 0; applicationObjectId = $null
            armDeploymentName = 'customer-sample'
            portalDeploymentName = $PortalDeploymentName
        }
        $groupExists = Invoke-AzJson @('group', 'exists', '--subscription', $cfg.subscriptionId, '--name', $cfg.resourceGroup)
        if ($PortalDeploymentName) {
            if (!$groupExists) { throw 'Portal resource group not found.' }
            $portal = Invoke-AzJson @('deployment', 'group', 'show', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup, '--name', $PortalDeploymentName)
            if ($portal.properties.provisioningState -ne 'Succeeded') { throw 'Portal infrastructure must have succeeded before adoption.' }
            $p = $portal.properties.parameters
            foreach ($key in $cfg.Keys | Where-Object { $_ -notin @('subscriptionId', 'resourceGroup') }) {
                if (!$p.ContainsKey($key) -or $p[$key].value -cne $cfg[$key]) { throw "Portal/config parameter mismatch: $key" }
            }
            if ($p.bootstrapEnabled.value -ne $false) { throw 'Portal bootstrap privileges must be disabled.' }
            $state.deploymentId = $portal.properties.outputs.deployment.value.deploymentId
            $state.armDeploymentName = $PortalDeploymentName
        } elseif ($groupExists) {
            $resources = @(Invoke-AzJson @('resource', 'list', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup))
            if ($resources.Count -gt 0) { throw 'Use an empty new resource group, or explicitly adopt a matching portal deployment. Existing/finalized targets are never reused.' }
        }
        Save-State
    }
    Check-Models -Existing:([bool]$state.portalDeploymentName)
    Setup-Registration
    if ($state.portalDeploymentName) {
        Read-Outputs
        foreach ($app in $state.deployment.apps) {
            $site = Arm GET "$groupId/providers/Microsoft.Web/sites/$($app.name)?api-version=$api"
            Assert-Owned $site
            if ($site.tags.deploymentLifecycle -ne 'infrastructure-only') { throw 'Cannot adopt an already bootstrapped or finalized deployment.' }
        }
    }
    $state.phase = 'initialized'; Save-State
    Write-Output 'Initialized. Entra owns only this sample API; no broad Graph consent granted. Continue with Provision.'
    return
}
if (!$state) { throw 'Run Initialize first. State is required for all writes and cleanup.' }
if ($Phase -eq 'Provision') {
    if ($state.phase -notin @('initialized', 'provisioning')) { throw 'Provision is initial-only; it must never reactivate finalized bootstrap privileges.' }
    if ($state.phase -eq 'initialized' -and !$state.deployment) { Check-Models }
    $groupExists = Invoke-AzJson @('group', 'exists', '--subscription', $cfg.subscriptionId, '--name', $cfg.resourceGroup)
    if (!$groupExists) {
        Invoke-AzJson @('group', 'create', '--subscription', $cfg.subscriptionId, '--name', $cfg.resourceGroup, '--location', $cfg.location,
            '--tags', "deploymentId=$($state.deploymentId)", 'application=fraud-intelligence-poc') | Out-Null
    }
    $resources = @(Invoke-AzJson @('resource', 'list', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup))
    Assert-OwnedInventory $resources
    foreach ($item in $resources) {
        if ($item['tags'] -and $item['tags']['deploymentLifecycle'] -in @('finalized', 'aborted')) {
            throw 'Remote finalized/aborted lifecycle marker refuses bootstrap reactivation, even if local state is stale.'
        }
    }
    $state.phase = 'provisioning'; Save-State
    $parameters = @{}
    foreach ($key in $cfg.Keys | Where-Object { $_ -notin @('subscriptionId', 'resourceGroup') }) { $parameters[$key] = @{ value = $cfg[$key] } }
    $parameters.deploymentId = @{ value = $state.deploymentId }
    $parameters.bootstrapEnabled = @{ value = $true }
    $parameterPath = Join-Path $work 'parameters.json'
    @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } |
        ConvertTo-Json -Depth 20 | Set-Content $parameterPath -Encoding utf8NoBOM
    try {
        Invoke-AzJson @('deployment', 'group', 'create', '--subscription', $cfg.subscriptionId, '--resource-group', $cfg.resourceGroup,
            '--name', $state.armDeploymentName, '--template-file', (Join-Path $root 'azuredeploy.json'), '--parameters', "@$parameterPath", '--mode', 'Incremental') | Out-Null
    } catch {
        Write-Warning 'Provisioning may have left resources and temporary privileges. No automatic rollback occurred. Retry Provision, or run Abort to transfer SQL administration and revoke setup access.'
        throw
    }
    Read-Outputs
    $state.phase = 'provisioned'; Save-State
    Write-Output 'Provisioned with TEMPORARY privileges and SQL bootstrap admin. Run Bootstrap, then Finalize; on abandonment run Abort. No automatic teardown.'
    return
}
if ($Phase -eq 'Status') {
    if (!$state.deployment) { Write-Output "Local phase: $($state.phase). Provision may be incomplete; Abort can discover tagged partial resources."; return }
    $site = Read-Setup
    $summary = @{
        phase = $state.phase; setupStatus = if ($site) { $site.tags.setupStatus } else { 'absent' }
        deploymentId = $state.deploymentId; sourceHash = $state.sourceHash
        publicDemoRequested = $cfg.publicDemoEnabled; finalized = $state.phase -eq 'finalized'
        report = 'Private blob: artifacts/acceptance/latest.json; setup journal: /home/customer-bootstrap/journal.json'
        warning = if ($state.phase -notin @('finalized', 'aborted')) { 'Temporary access may remain. Finalize on success; Abort on abandonment.' } else { '' }
    }
    $summary | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $work 'status.json') -Encoding utf8NoBOM
    $summary | ConvertTo-Json -Depth 10
    return
}
if ($Phase -eq 'Bootstrap') {
    if ($state.phase -notin @('provisioned', 'bootstrapping')) { throw 'Bootstrap requires a provisioned initial deployment.' }
    $site = Read-Setup
    $stale = $site -and $site.tags.setupStatus -eq 'submitted' -and
        $state.updatedUnix -lt [DateTimeOffset]::UtcNow.AddMinutes(-15).ToUnixTimeSeconds()
    if ($site -and (!$Resume -or ($site.tags.setupStatus -ne 'failed' -and !$stale))) { throw 'Existing setup may still be running or accepted. Use Status/Finalize; -Resume needs failed status or submitted for at least 15 minutes.' }
    if (!$site -and $Resume) { throw 'Resume requires the existing owned setup host and journal.' }
    $archive = Join-Path $work 'source.tgz'
    if (!$state.sourceHash) {
        & tar -czf $archive -C $root package.json package-lock.json src seed deploy/cloud-acceptance.mjs deploy/portability.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
    }
    $bytes = [IO.File]::ReadAllBytes($archive)
    if ($bytes.Length -gt 1048576) { throw 'Source archive exceeds 1 MiB; do not include dependencies, snapshots or secrets.' }
    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($state.sourceHash -and $state.sourceHash -ne $hash) { throw 'Resume source differs from pinned original; refusing a mixed release.' }
    $runnerHash = (Get-FileHash (Join-Path $PSScriptRoot 'bootstrap-runner.cjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($state.runnerHash -and $state.runnerHash -ne $runnerHash) { throw 'Bootstrap runner changed since submission; refusing mixed-runner resume.' }
    $state.runnerHash = $runnerHash
    $state.sourceHash = $hash
    $state.phase = 'bootstrapping'; Save-State
    if ($site) {
        Arm POST "$($state.setupId)/stop?api-version=$api" | Out-Null
        for ($i = 0; $i -lt 60; $i++) {
            $stopped = Read-Setup
            if ($stopped.properties.state -eq 'Stopped') { break }
            Start-Sleep -Seconds 5
        }
        if ($stopped.properties.state -ne 'Stopped') { throw 'Previous setup process did not stop; refusing concurrent bootstrap attempts.' }
    }
    $registered = Find-AppRegistration
    if ($registered.id -ne $state.applicationObjectId) { throw 'Application identity changed.' }
    $web = @($state.deployment.apps | Where-Object role -eq 'web')[0]
    $redirect = $web.url + '/.auth/login/aad/callback'
    $redirects = @(@($registered.web.redirectUris) + $redirect | Select-Object -Unique)
    Control PATCH "https://graph.microsoft.com/v1.0/applications/$($state.applicationObjectId)" @{ web = @{
        redirectUris = $redirects; implicitGrantSettings = @{ enableIdTokenIssuance = $true; enableAccessTokenIssuance = $false }
    } } | Out-Null
    $userToken = $null
    if (!$cfg.publicDemoEnabled) {
        $delegated = Invoke-AzJson @('account', 'get-access-token', '--subscription', $cfg.subscriptionId, '--resource', "api://$($cfg.authClientId)")
        $userToken = $delegated.accessToken
        $part = $userToken.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $part = $part.PadRight($part.Length + ((4 - $part.Length % 4) % 4), '=')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json -AsHashtable
        if ($claims.oid -ne $cfg.allowedUserOid -or $claims.tid -ne $state.tenantId -or $claims.exp -lt [DateTimeOffset]::UtcNow.AddMinutes(30).ToUnixTimeSeconds()) {
            throw 'Sign Azure CLI in as the allowed analyst with at least 30 minutes token validity. Refresh login after API preauthorization if necessary.'
        }
    }
    $secret = $null
    if ($site) {
        $prior = Arm POST "$($state.setupId)/config/appsettings/list?api-version=$api"
        if ($prior['properties'] -is [System.Collections.IDictionary]) {
            $secret = $prior['properties']['BOOT_AAD_CLIENT_SECRET']
        }
    }
    if (!$secret) {
        if ($state.secretKeyId) {
            Control POST "https://graph.microsoft.com/v1.0/applications/$($state.applicationObjectId)/removePassword" @{ keyId = $state.secretKeyId } | Out-Null
        }
        $expires = [DateTimeOffset]::UtcNow.AddDays(30)
        $credential = Control POST "https://graph.microsoft.com/v1.0/applications/$($state.applicationObjectId)/addPassword" @{
            passwordCredential = @{ displayName = "sample-$($state.deploymentId)"; endDateTime = $expires.ToString('o') }
        }
        $secret = $credential.secretText
        if (!$secret) { throw 'Entra credential was not returned.' }
        $state.secretKeyId = $credential.keyId; $state.secretExpiresAt = $expires.ToString('o')
        $state.secretExpiresUnix = $expires.ToUnixTimeSeconds(); Save-State
        $credential = $null
    }
    $runnerCfg = $state.deployment.Clone()
    if ($state.secretExpiresUnix -le [DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeSeconds()) { throw 'Bootstrap credential is expired or expires soon. Abort this initial setup; do not silently reactivate it.' }
    $runnerCfg.secretExpiresUnix = $state.secretExpiresUnix
    $settings = @{
        NODE_ENV = 'production'; PORT = '8080'; AZURE_CLIENT_ID = $runnerCfg.bootstrap.clientId
        BOOT_CONFIG_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($runnerCfg | ConvertTo-Json -Depth 40 -Compress)))
        BOOT_RUNNER_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'bootstrap-runner.cjs')))
        BOOT_PACKAGE_SHA256 = $hash; BOOT_ATTEMPT = [guid]::NewGuid().ToString()
        BOOT_AAD_CLIENT_SECRET = $secret; BOOT_USER_TOKEN = $userToken
        WEBSITES_CONTAINER_START_TIME_LIMIT = '1800'
    }
    $base64 = [Convert]::ToBase64String($bytes)
    $count = [int][Math]::Ceiling($base64.Length / 12000)
    if ($count -gt 128) { throw 'Archive settings chunk budget exceeded.' }
    $settings.BOOT_PACKAGE_COUNT = [string]$count
    for ($i = 0; $i -lt $count; $i++) { $settings[('BOOT_PACKAGE_{0:d3}' -f $i)] = $base64.Substring($i * 12000, [Math]::Min(12000, $base64.Length - $i * 12000)) }
    if ([Text.Encoding]::UTF8.GetByteCount(($settings | ConvertTo-Json -Compress -Depth 10)) -gt 240000) { throw 'Combined bootstrap settings exceed the conservative 240 KB transport budget.' }
    $identities = @{}
    $identities[$runnerCfg.bootstrap.identityId] = @{}
    # Initial proof only: actual broker for SQL denial and actual web for caller-auth/evidence acceptance.
    foreach ($app in $runnerCfg.apps | Where-Object role -in @('broker', 'web')) { $identities[$app.identityId] = @{} }
    $body = @{
        location = $cfg.location; kind = 'app,linux'
        tags = @{ deploymentId = $state.deploymentId; application = 'fraud-intelligence-poc'; temporary = 'true'; setupStatus = 'submitted'; packageHash = $hash }
        identity = @{ type = 'UserAssigned'; userAssignedIdentities = $identities }
        properties = @{
            serverFarmId = $runnerCfg.setupPlanId; publicNetworkAccess = 'Disabled'; httpsOnly = $true
            virtualNetworkSubnetId = $runnerCfg.setupSubnetId; vnetRouteAllEnabled = $false
            siteConfig = @{
                linuxFxVersion = 'NODE|22-lts'; alwaysOn = $true; minTlsVersion = '1.2'; scmMinTlsVersion = '1.2'; ftpsState = 'Disabled'
                scmIpSecurityRestrictionsDefaultAction = 'Deny'
                appCommandLine = 'printf %s "$BOOT_RUNNER_B64" | base64 --decode > /home/customer-bootstrap-runner.cjs && exec node /home/customer-bootstrap-runner.cjs'
                appSettings = @($settings.GetEnumerator() | ForEach-Object { @{ name = $_.Key; value = [string]$_.Value } })
            }
        }
    }
    # Create inert host first so its only control-plane assignment is site-scoped, never resource-group Contributor.
    if (!$site) {
        $inert = $body | ConvertTo-Json -Depth 60 | ConvertFrom-Json -AsHashtable
        $inert.properties.siteConfig.appCommandLine = 'node -e "require(''http'').createServer((q,s)=>s.end(''initializing'')).listen(process.env.PORT||8080)"'
        $inert.properties.siteConfig.appSettings = @(@{ name = 'PORT'; value = '8080' })
        Arm PUT "$($state.setupId)?api-version=$api" $inert | Out-Null
        for ($i = 0; $i -lt 60; $i++) {
            $created = Read-Setup
            if ($created -and $created.properties.state -eq 'Running') { break }
            Start-Sleep -Seconds 5
        }
    }
    if (!$state.setupRoleId) { $state.setupRoleId = "$($state.setupId)/providers/Microsoft.Authorization/roleAssignments/$([guid]::NewGuid())"; Save-State }
    Arm PUT "$($state.setupRoleId)?api-version=2022-04-01" @{ properties = @{
        principalId = $runnerCfg.bootstrap.principalId; principalType = 'ServicePrincipal'
        roleDefinitionId = "/subscriptions/$($cfg.subscriptionId)/providers/Microsoft.Authorization/roleDefinitions/de139f84-1756-47ae-9be6-808fbbe84772"
    } } | Out-Null
    foreach ($policy in @('scm', 'ftp')) { Arm PUT "$($state.setupId)/basicPublishingCredentialsPolicies/${policy}?api-version=$api" @{ properties = @{ allow = $false } } | Out-Null }
    Start-Sleep -Seconds 60
    Arm PUT "$($state.setupId)?api-version=$api" $body | Out-Null
    if ($site) { Arm POST "$($state.setupId)/start?api-version=$api" | Out-Null }
    $secret = $null; $userToken = $null; $settings = $null; $body = $null; $prior = $null; $delegated = $null
    $state.bootstrapSubmittedAt = [DateTimeOffset]::UtcNow.ToString('o'); Save-State
    Write-Output 'Bootstrap submitted (NOT accepted). Poll Status. Retry only failed attempts with Bootstrap -Resume; run Finalize after succeeded, or Abort. Temporary access is active until cleanup.'
    return
}
if ($Phase -in @('Finalize', 'Abort')) {
    if ($state.phase -in @('finalized', 'aborted')) { Write-Output "Already $($state.phase); initial bootstrap cannot be rerun."; return }
    Recover-PartialDeployment
    $site = Read-Setup
    if ($Phase -eq 'Finalize') {
        if ($site) {
            if ($site.tags.setupStatus -ne 'succeeded' -or $site.tags.packageHash -ne $state.sourceHash) { throw 'Finalize requires the accepted owned host with the pinned source hash. Use Abort to abandon failed setup.' }
            $state.acceptedHash = $state.sourceHash; Save-State
        } elseif (!$state.acceptedHash -or $state.acceptedHash -ne $state.sourceHash) { throw 'Missing accepted checkpoint; no Finalize.' }
    }
    $state.phase = if ($Phase -eq 'Finalize') { 'finalizing' } else { 'aborting' }; Save-State
    $roles = @(Get-TemporaryRoles)
    $state.cleanupRoles = @($roles | ForEach-Object { @{ id = $_.id; principalId = $_.principalId; scope = $_.scope; roleDefinitionId = $_.roleDefinitionId } })
    Save-State
    # Public ingress is withheld until cleanup succeeds. Abort also stops runtime apps.
    foreach ($app in $state.deployment.apps) {
        $id = "$groupId/providers/Microsoft.Web/sites/$($app.name)"
        $live = Arm GET "${id}?api-version=$api"; Assert-Owned $live
        Arm PATCH "${id}?api-version=$api" @{ properties = @{ publicNetworkAccess = 'Disabled' } } | Out-Null
        if ($Phase -eq 'Abort') { Arm POST "$id/stop?api-version=$api" | Out-Null }
    }
    if ($site) {
        Arm POST "$($state.setupId)/stop?api-version=$api" | Out-Null
        for ($i = 0; $i -lt 60; $i++) {
            $stopped = Read-Setup
            if ($stopped.properties.state -eq 'Stopped') { break }
            Start-Sleep -Seconds 5
        }
        if ($stopped.properties.state -ne 'Stopped') { throw 'Setup process is not stopped; cleanup is not complete.' }
    }
    Handoff-Sql
    foreach ($role in $roles) { Arm DELETE "$($role.id)?api-version=2022-04-01" | Out-Null }
    for ($i = 0; $i -lt 60; $i++) {
        if (@(Get-TemporaryRoles).Count -eq 0) { break }
        Start-Sleep -Seconds 5
    }
    if (@(Get-TemporaryRoles).Count -ne 0) { throw 'Temporary assignments remain. Cleanup not complete; rerun this phase.' }
    if ($site) { Arm DELETE "$($state.setupId)?api-version=$api" | Out-Null }
    for ($i = 0; $i -lt 60; $i++) {
        if (!(Read-Setup)) { break }
        Start-Sleep -Seconds 5
    }
    if (Read-Setup) { throw 'Setup host still exists. Cleanup not complete.' }
    if ($Phase -eq 'Abort' -and $state.secretKeyId) {
        Control POST "https://graph.microsoft.com/v1.0/applications/$($state.applicationObjectId)/removePassword" @{ keyId = $state.secretKeyId } | Out-Null
        $state.secretKeyId = $null; Save-State
    }
    if ($Phase -eq 'Finalize' -and $cfg.publicDemoEnabled) {
        $web = @($state.deployment.apps | Where-Object role -eq 'web')[0]
        Arm PATCH "$groupId/providers/Microsoft.Web/sites/$($web.name)?api-version=$api" @{ properties = @{ publicNetworkAccess = 'Enabled' } } | Out-Null
        $ready = $false
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(15)
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            try {
                $response = Invoke-WebRequest -Uri ($web.url + '/api/status') -Method GET -TimeoutSec 30 -SkipHttpErrorCheck -MaximumRedirection 0
                if ($response.StatusCode -eq 200) {
                    $status = $response.Content | ConvertFrom-Json -AsHashtable
                    $ready = $status.synthetic -eq $true -and $status.publicDemo -eq $true -and
                        $status.capabilities.guided -eq $true -and $status.capabilities.knowledge -eq $true -and
                        $status.capabilities.naturalLanguage -eq $true -and $status.capabilities.evidence -eq $true
                    if ($ready) { break }
                }
            } catch { }
            Start-Sleep -Seconds 15
        }
        if (!$ready) { throw 'Public ingress was enabled but full readiness did not converge within 15 minutes. Cleanup succeeded; Finalize can be retried without reopening bootstrap.' }
    }
    $finished = if ($Phase -eq 'Finalize') { 'finalized' } else { 'aborted' }
    Set-Lifecycle $finished
    foreach ($app in $state.deployment.apps) {
        $live = Arm GET "$groupId/providers/Microsoft.Web/sites/$($app.name)?api-version=$api"
        $expected = if ($Phase -eq 'Finalize' -and $cfg.publicDemoEnabled -and $app.role -eq 'web') { 'Enabled' } else { 'Disabled' }
        if ($live.properties.publicNetworkAccess -ne $expected) { throw 'Ingress did not match requested final state.' }
    }
    $state.phase = $finished; Save-State
    Write-Output "$finished : SQL administration handed to customer; temporary roles and setup host removed. Resources still incur costs. Entra web credential expiry: $($state.secretExpiresAt). Browser walkthrough still required."
}
