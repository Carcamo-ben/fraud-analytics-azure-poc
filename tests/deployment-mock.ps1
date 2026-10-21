#requires -Version 7.0
param(
    [switch]$PublicDemo,
    [ValidateSet('Finalize','Abort','AbortBeforeProvision')][string]$Outcome = 'Finalize',
    [ValidateSet('Lifecycle','OwnedEndpointNic','UnrelatedNic','WrongNicBacklink','MissingNicBacklink','CrossGroupNic','InertResume')]
    [string]$Scenario = 'Lifecycle'
)
$ErrorActionPreference = 'Stop'
$script:root = Split-Path -Parent $PSScriptRoot
$script:node = (Get-Command node.exe).Source
$script:cfg = Get-Content (Join-Path $script:root 'deploy\customer.example.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($key in @('subscriptionId','authClientId','allowedUserOid','sqlAdminObjectId')) { $script:cfg[$key] = [guid]::NewGuid().ToString() }
$script:cfg.sqlAdminLogin = 'Customer Admin'; $script:cfg.ownerTag = 'Validation'; $script:cfg.reviewAfter = '2027-01-01'
$script:cfg.resourceGroup = 'rg-local-mock-' + ([guid]::NewGuid().ToString('N').Substring(0,8))
if ($PublicDemo) { $script:cfg.publicDemoEnabled = $true; $script:cfg.publicDemoUserOid = [guid]::NewGuid().ToString() }
$inputDir = Join-Path $script:root '.deployment'
New-Item -ItemType Directory -Path $inputDir -Force | Out-Null
$configPath = Join-Path $inputDir ($script:cfg.resourceGroup + '.json')
$script:cfg | ConvertTo-Json | Set-Content $configPath
$script:group = "/subscriptions/$($script:cfg.subscriptionId)/resourceGroups/$($script:cfg.resourceGroup)"
$script:tenant = [guid]::NewGuid().ToString()
$script:resources = @{}
$script:assignments = @()
$script:groupExists = $false
$script:provisionWrites = 0
$script:addPasswordCalls = 0
$script:removePasswordCalls = 0
$script:interruptSetupRole = $Scenario -eq 'InertResume'
$script:application = @{
    id = [guid]::NewGuid().ToString(); appId = $script:cfg.authClientId; signInAudience = 'AzureADMyOrg'
    identifierUris = @(); api = @{ oauth2PermissionScopes = @(); preAuthorizedApplications = @() }
    web = @{redirectUris=@()}
}
function node {
    if ($args[0] -eq '-p') { '22'; $global:LASTEXITCODE = 0; return }
    & $script:node @args
}
function Start-Sleep {}
function az {
    $global:LASTEXITCODE = 0
    $cmd = ($args | Select-Object -First 3) -join ' '
    $value = $null
    switch -Wildcard ($cmd) {
        'account show *' { $value = @{ id = $script:cfg.subscriptionId; tenantId = $script:tenant; environmentName = 'AzureCloud' } }
        'account get-access-token *' {
            $claims = @{ oid = $script:cfg.allowedUserOid; tid = $script:tenant; exp = [DateTimeOffset]::UtcNow.AddHours(2).ToUnixTimeSeconds() } | ConvertTo-Json -Compress
            $value = @{accessToken = 'local.' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($claims)).TrimEnd('=').Replace('+','-').Replace('/','_') + '.local'}
        }
        'group exists *' { $value = $script:groupExists }
        'group create *' { $script:groupExists = $true; $value = @{} }
        'resource list *' {
            # Resource inventory omits the network provider's relationship properties.
            $value = @($script:resources.Values | ForEach-Object {
                $item = $_.Clone()
                if ($item.type -in @('Microsoft.Network/privateEndpoints','Microsoft.Network/networkInterfaces')) { $item.Remove('properties') }
                $item
            })
        }
        'cognitiveservices model list' {
            $value = @('chat','embedding') | ForEach-Object { @{ model = @{
                name=$script:cfg[$_+'ModelName'];version=$script:cfg[$_+'ModelVersion']
                skus=@(@{name='Standard';usageName=$_;capacity=@{minimum=1;maximum=100;step=1}})
            } } }
        }
        'cognitiveservices usage list' { $value = @('chat','embedding') | ForEach-Object { @{name=@{value=$_};limit=100;currentValue=0} } }
        'deployment group create' {
            $script:provisionWrites++
            $work = Join-Path $script:root ".deployment\$($script:cfg.subscriptionId)-$($script:cfg.resourceGroup)"
            $script:deploymentId = (Get-Content (Join-Path $work 'state.json') -Raw | ConvertFrom-Json).deploymentId
            $script:apps = @('web','broker','knowledge') | ForEach-Object {
                $name='local-'+$_
                $id="$script:group/providers/Microsoft.Web/sites/$name"
                $script:resources[$id] = @{id=$id;name=$name;type='Microsoft.Web/sites';tags=@{deploymentId=$script:deploymentId};properties=@{state='Running';publicNetworkAccess='Disabled'}}
                @{role=$_;name=$name;url="https://$name.azurewebsites.net";identityId="$script:group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$name-mi";clientId=[guid]::NewGuid().ToString();principalId=[guid]::NewGuid().ToString()}
            }
            $boot = @{name='local-setup';identityId="$script:group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/local-bootstrap-mi";clientId=[guid]::NewGuid().ToString();principalId=[guid]::NewGuid().ToString()}
            $script:admin = $boot.principalId
            $sqlId = "$script:group/providers/Microsoft.Sql/servers/local-sql"
            $script:resources[$sqlId]=@{id=$sqlId;name='local-sql';type='Microsoft.Sql/servers';tags=@{deploymentId=$script:deploymentId}}
            $script:output = @{
                subscriptionId=$script:cfg.subscriptionId;resourceGroup=$script:cfg.resourceGroup;deploymentId=$script:deploymentId
                authClientId=$script:cfg.authClientId;allowedUserOid=$script:cfg.allowedUserOid;bootstrap=$boot;location=$script:cfg.location
                sqlServer='local-sql';sqlHost='local-sql.database.windows.net';sqlDatabase='sample'
                searchIndex='fraud-policy-f17745ee4ea35aba';searchEndpoint='https://local-search.search.windows.net';openaiEndpoint='https://local-openai.openai.azure.com'
                vaultUri='https://local-vault.vault.azure.net/';storageUrl='https://localstorage.blob.core.windows.net'
                setupPlanId="$script:group/providers/Microsoft.Web/serverfarms/local-plan";setupSubnetId="$script:group/providers/Microsoft.Network/virtualNetworks/local/subnets/bootstrap"
                tenantId=$script:tenant;embeddingDeployment='fraud-embedding';publicDemoEnabled=$script:cfg.publicDemoEnabled;publicDemoUserOid=$script:cfg.publicDemoUserOid
            }
            $value=@{}
        }
        'deployment group show' { $value=@{properties=@{provisioningState='Succeeded';outputs=@{deployment=@{value=$script:output};apps=@{value=$script:apps}}}} }
        'role assignment list' { $value=@($script:assignments) }
        default { throw "UNMOCKED az: $($args -join ' ')" }
    }
    ConvertTo-Json -InputObject $value -Depth 60 -Compress
}
function Invoke-WebRequest {
    param($Uri,$Method,$Headers,$TimeoutSec,[switch]$SkipHttpErrorCheck,$ContentType,$Body,$MaximumRedirection)
    $bodyObject = if ($Body) { $Body | ConvertFrom-Json -AsHashtable } else { $null }
    $status=200; $value=@{}
    $u=[uri]$Uri; $id=$u.AbsolutePath
    if ($u.Host -eq 'local-web.azurewebsites.net') {
        if (!$script:cfg.publicDemoEnabled -or $id -ne '/api/status') { throw 'Unexpected external request' }
        $value=@{synthetic=$true;publicDemo=$true;capabilities=@{guided=$true;knowledge=$true;naturalLanguage=$true;evidence=$true}}
    } elseif ($u.Host -eq 'graph.microsoft.com') {
        if ($id -eq '/v1.0/applications' -and $Method -eq 'GET') {$value=@{value=@($script:application)}}
        elseif ($id -eq '/v1.0/servicePrincipals') {$value=@{value=@(@{id='local'})}}
        elseif ($id.EndsWith('/addPassword')) {$script:addPasswordCalls++;$value=@{secretText='local-mock-value-not-a-real-secret';keyId=[guid]::NewGuid().ToString()}}
        elseif ($Method -eq 'PATCH') {foreach ($k in $bodyObject.Keys) {$script:application[$k]=$bodyObject[$k]}}
        elseif ($id.EndsWith('/removePassword')) {$script:removePasswordCalls++}
        else {throw "UNMOCKED graph $Method $id"}
    } else {
        if (!$id.StartsWith($script:group+'/')) {throw 'Mock group escaped'}
        if ($id.EndsWith('/administrators/ActiveDirectory')) {
            if ($Method -eq 'PUT') {$script:admin=$bodyObject.properties.sid}
            $value=@{properties=@{sid=$script:admin}}
        } elseif ($id -like '*/providers/Microsoft.Authorization/roleAssignments/*') {
            if ($Method -eq 'PUT') {
                if ($script:interruptSetupRole) {
                    $script:interruptSetupRole = $false
                    throw 'MOCK interrupted setup role assignment'
                }
                $script:assignments += @{id=$id;scope=$id -replace '/providers/Microsoft.Authorization/roleAssignments/[^/]+$','';principalId=$bodyObject.properties.principalId;roleDefinitionId=$bodyObject.properties.roleDefinitionId}
            } elseif ($Method -eq 'DELETE') {$script:assignments=@($script:assignments|Where-Object id -ne $id)}
        } elseif ($id -like '*/basicPublishingCredentialsPolicies/*') {}
        elseif ($id.EndsWith('/stop') -or $id.EndsWith('/start')) {
            $base=$id -replace '/(stop|start)$',''
            $script:resources[$base].properties.state=if($id.EndsWith('/stop')){'Stopped'}else{'Running'}
        } elseif ($id.EndsWith('/config/appsettings/list')) {
            $base=$id -replace '/config/appsettings/list$',''
            $properties=@{};foreach($s in $script:resources[$base].properties.siteConfig.appSettings){$properties[$s.name]=$s.value}
            $value=@{properties=$properties}
        } elseif ($Method -eq 'GET') {
            if($script:resources.ContainsKey($id)){$value=$script:resources[$id]}else{$status=404}
        } elseif ($Method -eq 'PUT') {
            $bodyObject.id=$id;$bodyObject.name=($id -split '/')[-1];$bodyObject.type='Microsoft.Web/sites'
            $bodyObject.properties.state='Running';$script:resources[$id]=$bodyObject
        } elseif ($Method -eq 'PATCH') {
            foreach($k in $bodyObject.Keys){
                if($k -eq 'properties'){foreach($p in $bodyObject.properties.Keys){$script:resources[$id].properties[$p]=$bodyObject.properties[$p]}}
                else{$script:resources[$id][$k]=$bodyObject[$k]}
            }
        } elseif ($Method -eq 'DELETE') {$script:resources.Remove($id)}
        else {throw "UNMOCKED ARM $Method $id"}
    }
    @{StatusCode=$status;Content=ConvertTo-Json -InputObject $value -Depth 60 -Compress}
}
$deployPath = Join-Path $script:root 'deploy'
$source = Get-Content (Join-Path $deployPath 'Deploy.ps1') -Raw
$entry = [scriptblock]::Create(($source -replace '\$PSScriptRoot', "'$deployPath'"))
try {
    foreach($phase in @('Validate','Initialize')) { & $entry -Phase $phase -Config $configPath }
    if ($Outcome -eq 'AbortBeforeProvision') {
        & $entry -Phase Abort -Config $configPath
        'MOCK FLOW PASSED: initialized-only abandonment; NO CLOUD CALLS'
        return
    }
    & $entry -Phase Provision -Config $configPath
    if ($Scenario -in @('OwnedEndpointNic','UnrelatedNic','WrongNicBacklink','MissingNicBacklink','CrossGroupNic')) {
        $endpointId = "$script:group/providers/Microsoft.Network/privateEndpoints/local-pe"
        $nicId = "$script:group/providers/Microsoft.Network/networkInterfaces/local-pe-nic"
        $referenceId = if ($Scenario -eq 'UnrelatedNic') { "$script:group/providers/Microsoft.Network/networkInterfaces/another-nic" } else { $nicId }
        if ($Scenario -eq 'CrossGroupNic') { $referenceId = $nicId.Replace("/resourceGroups/$($script:cfg.resourceGroup)/", '/resourceGroups/other-target/') }
        $script:resources[$endpointId] = @{
            id=$endpointId;name='local-pe';type='Microsoft.Network/privateEndpoints';tags=@{deploymentId=$script:deploymentId}
            properties=@{networkInterfaces=@(@{id=$referenceId})}
        }
        $script:resources[$nicId] = @{
            id=$nicId;name='local-pe-nic';type='Microsoft.Network/networkInterfaces'
            properties=@{privateEndpoint=@{id=if($Scenario -eq 'WrongNicBacklink'){"$script:group/providers/Microsoft.Network/privateEndpoints/other-pe"}else{$endpointId}}}
        }
        if ($Scenario -eq 'MissingNicBacklink') { $script:resources[$nicId].properties.Remove('privateEndpoint') }
        $work = Join-Path $script:root ".deployment\$($script:cfg.subscriptionId)-$($script:cfg.resourceGroup)"
        $stateFile = Join-Path $work 'state.json'
        $checkpoint = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable
        $checkpoint.phase = 'provisioning'
        $checkpoint | ConvertTo-Json -Depth 60 | Set-Content $stateFile
        $before = $script:provisionWrites
        $failure = $null
        try { & $entry -Phase Provision -Config $configPath } catch { $failure = $_.Exception.Message }
        if ($Scenario -eq 'OwnedEndpointNic') {
            if ($failure -or $script:provisionWrites -ne $before + 1) { throw "Valid Azure-generated NIC blocked provision retry: $failure" }
        } else {
            $expected = switch ($Scenario) {
                'UnrelatedNic' { '*Unowned resource appeared*' }
                'CrossGroupNic' { '*NIC outside the pinned resource group*' }
                default { '*NIC does not reference the owned private endpoint*' }
            }
            if (!$failure -or $failure -notlike $expected -or $script:provisionWrites -ne $before) { throw "NIC ownership rejection did not fail closed: $failure" }
        }
        "MOCK FLOW PASSED: $Scenario inventory regression; NO CLOUD CALLS"
        return
    }
    $setupId="$script:group/providers/Microsoft.Web/sites/local-setup"
    if ($Scenario -eq 'InertResume') {
        $interrupted = $false
        try { & $entry -Phase Bootstrap -Config $configPath } catch {
            if ($_.Exception.Message -eq 'MOCK interrupted setup role assignment') { $interrupted = $true } else { throw }
        }
        $settings = @($script:resources[$setupId].properties.siteConfig.appSettings)
        if (!$interrupted -or $settings.Count -ne 1 -or $settings[0].name -ne 'PORT') { throw 'Interruption did not leave the actual inert host without BOOT settings' }
        $work = Join-Path $script:root ".deployment\$($script:cfg.subscriptionId)-$($script:cfg.resourceGroup)"
        $stateFile = Join-Path $work 'state.json'
        $checkpoint = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable
        $priorHash = $checkpoint.sourceHash
        $priorKey = $checkpoint.secretKeyId
        $checkpoint.updatedUnix = [DateTimeOffset]::UtcNow.AddMinutes(-16).ToUnixTimeSeconds()
        $checkpoint | ConvertTo-Json -Depth 60 | Set-Content $stateFile
        & $entry -Phase Bootstrap -Config $configPath -Resume
        $resumed = Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable
        if ($script:addPasswordCalls -ne 2 -or $script:removePasswordCalls -ne 1 -or $resumed.secretKeyId -eq $priorKey -or $resumed.sourceHash -ne $priorHash) {
            throw 'Inert-host resume did not regenerate its credential while preserving the source checkpoint'
        }
        if (@($script:resources[$setupId].properties.siteConfig.appSettings | Where-Object name -eq 'BOOT_AAD_CLIENT_SECRET').Count -ne 1) {
            throw 'Resumed runner did not receive its replacement credential'
        }
    } else { & $entry -Phase Bootstrap -Config $configPath }
    & $entry -Phase Status -Config $configPath
    $refused=$false
    try { & $entry -Phase Finalize -Config $configPath } catch {
        if($_.Exception.Message -like '*Finalize requires*'){$refused=$true}else{throw}
    }
    if(!$refused){throw 'Finalize accepted incomplete bootstrap'}
    $script:resources[$setupId].tags.setupStatus='failed'
    & $entry -Phase Bootstrap -Config $configPath -Resume
    $script:resources[$setupId].tags.setupStatus='succeeded'
    & $entry -Phase $Outcome -Config $configPath
    if($script:admin -ne $script:cfg.sqlAdminObjectId -or $script:assignments.Count -ne 0 -or $script:resources.ContainsKey($setupId)){throw 'Finalization invariants failed'}
    $refused=$false
    try{& $entry -Phase Bootstrap -Config $configPath}catch{if($_.Exception.Message -like '*Finalized bootstrap*'){$refused=$true}else{throw}}
    if(!$refused){throw 'Finalized bootstrap did not refuse replay'}
    'MOCK FLOW PASSED: Validate/Initialize/Provision/Bootstrap/Status/Resume/cleanup/replay refusal; NO CLOUD CALLS'
} finally {
    $work=Join-Path $script:root ".deployment\$($script:cfg.subscriptionId)-$($script:cfg.resourceGroup)"
    if(Test-Path $work){Remove-Item -LiteralPath $work -Recurse -Force}
    if(Test-Path $configPath){Remove-Item -LiteralPath $configPath -Force}
}
