targetScope = 'resourceGroup'

@allowed(['canadacentral', 'canadaeast'])
param location string = 'canadaeast'
@allowed(['canadacentral', 'canadaeast'])
param aiLocation string = 'canadaeast'
@minLength(36)
@maxLength(36)
param authClientId string
@minLength(36)
@maxLength(36)
param allowedUserOid string
@description('Customer-owned Entra user or group that receives SQL administration; never a runtime identity.')
@minLength(36)
@maxLength(36)
param sqlAdminObjectId string
@minLength(1)
param sqlAdminLogin string
@allowed(['User', 'Group'])
param sqlAdminPrincipalType string = 'Group'
@description('Unique lifecycle ownership marker. Preserve this value when adopting a portal deployment.')
param deploymentId string = newGuid()
@description('Temporary setup privileges. Portal deployments MUST leave false; Deploy.ps1 manages the bounded setup lifecycle.')
param bootstrapEnabled bool = false
@description('Customer contact or team; no personal defaults.')
param ownerTag string
@description('Review date YYYY-MM-DD; a tag is not a budget or automatic deletion.')
param reviewAfter string
param chatModelName string = 'gpt-4.1-mini'
param chatModelVersion string = '2025-04-14'
@minValue(1)
@maxValue(100)
param chatCapacity int = 10
@description('Current runtime requires 1536-dimensional text-embedding-3-small. No Global/DataZone deployments.')
@allowed(['text-embedding-3-small'])
param embeddingModelName string = 'text-embedding-3-small'
param embeddingModelVersion string = '1'
@minValue(1)
@maxValue(100)
param embeddingCapacity int = 10
@description('Explicitly expose only the synthetic analyst website without user sign-in.')
param publicDemoEnabled bool = false
@description('Dedicated synthetic public-demo identity; must differ from authenticated users.')
param publicDemoUserOid string = ''

var suffix = uniqueString(resourceGroup().id)
var base = 'frpoc-${suffix}'
var tags = {
  application: 'fraud-intelligence-poc'
  environment: 'synthetic-poc'
  dataClassification: 'synthetic-no-customer-data'
  deploymentId: deploymentId
  owner: ownerTag
  reviewAfter: reviewAfter
  deploymentLifecycle: bootstrapEnabled ? 'bootstrap-authorized' : 'infrastructure-only'
  lifecycleNote: 'Review tag is not automatic deletion or a spending cap.'
}
var roles = ['web', 'broker', 'knowledge']
var appNames = [for role in roles: '${base}-${role}']
var subnetNames = ['web-integration', 'broker-integration', 'knowledge-integration']
var subnetPrefixes = ['10.87.1.0/26', '10.87.2.0/26', '10.87.3.0/26']
var openAiUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var blobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var searchReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')
var searchWriterRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var searchManagerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretsOfficerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for role in roles: {
  name: '${base}-${role}-mi'
  location: location
  tags: tags
}]
resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${base}-bootstrap-mi'
  location: location
  tags: tags
}

resource appNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${base}-app-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-private-HTTPS'
        properties: { priority: 100, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '443', sourceAddressPrefix: '*', destinationAddressPrefix: '10.87.10.0/24' }
      }
      {
        name: 'Allow-broker-SQL'
        properties: { priority: 110, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '1433', sourceAddressPrefix: '10.87.2.0/26', destinationAddressPrefix: '10.87.10.0/24' }
      }
      {
        name: 'Deny-other-SQL'
        properties: { priority: 120, direction: 'Outbound', access: 'Deny', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '1433', sourceAddressPrefix: '*', destinationAddressPrefix: '*' }
      }
      {
        name: 'Allow-Entra-identity'
        properties: { priority: 130, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '443', sourceAddressPrefix: '*', destinationAddressPrefix: 'AzureActiveDirectory' }
      }
      {
        name: 'Deny-public-egress'
        properties: { priority: 4000, direction: 'Outbound', access: 'Deny', protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: '*', destinationAddressPrefix: 'Internet' }
      }
    ]
  }
}
resource endpointNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${base}-endpoint-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'SQL-broker-and-bootstrap-only'
        properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '1433', sourceAddressPrefixes: ['10.87.2.0/26', '10.87.20.0/27'], destinationAddressPrefix: '*' }
      }
      {
        name: 'Deny-other-SQL'
        properties: { priority: 110, direction: 'Inbound', access: 'Deny', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '1433', sourceAddressPrefix: '*', destinationAddressPrefix: '*' }
      }
    ]
  }
}
resource bootstrapNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${base}-bootstrap-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'No-inbound-administration'
        properties: { priority: 100, direction: 'Inbound', access: 'Deny', protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: '*', destinationAddressPrefix: '*' }
      }
    ]
  }
}
var integrationSubnets = [for (name, i) in subnetNames: {
  name: name
  properties: {
    addressPrefix: subnetPrefixes[i]
    defaultOutboundAccess: false
    networkSecurityGroup: { id: appNsg.id }
    delegations: [{ name: 'app-service', properties: { serviceName: 'Microsoft.Web/serverFarms' } }]
  }
}]
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${base}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.87.0.0/16'] }
    subnets: concat(integrationSubnets, [
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.87.10.0/24'
          defaultOutboundAccess: false
          networkSecurityGroup: { id: endpointNsg.id }
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'bootstrap'
        properties: {
          addressPrefix: '10.87.20.0/27'
          defaultOutboundAccess: false
          networkSecurityGroup: { id: bootstrapNsg.id }
          delegations: [{
            name: 'private-setup-app'
            properties: { serviceName: 'Microsoft.Web/serverFarms' }
          }]
        }
      }
    ])
  }
}

var dnsNames = [
  'privatelink.azurewebsites.net'
  'privatelink.openai.azure.com'
  'privatelink.search.windows.net'
  'privatelink.blob.core.windows.net'
  'privatelink.vaultcore.azure.net'
  'privatelink.database.windows.net'
  'privatelink.monitor.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.agentsvc.azure-automation.net'
]
resource dnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for name in dnsNames: {
  name: name
  location: 'global'
  tags: tags
}]
resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (name, i) in dnsNames: {
  parent: dnsZones[i]
  name: '${base}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'frpoc${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'None', defaultAction: 'Deny' }
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in ['evidence', 'knowledge', 'artifacts']: {
  parent: blobService
  name: name
  properties: { publicAccess: 'None' }
}]
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'frpoc-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'None', defaultAction: 'Deny' }
  }
}
resource search 'Microsoft.Search/searchServices@2023-11-01' = {
  name: '${base}-search'
  location: location
  tags: tags
  sku: { name: 'basic' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    publicNetworkAccess: 'disabled'
    disableLocalAuth: true
  }
}
resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${base}-openai'
  location: aiLocation
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: '${base}-openai'
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    networkAcls: { defaultAction: 'Deny' }
  }
}
resource chat 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'fraud-chat'
  sku: { name: 'Standard', capacity: chatCapacity }
  properties: {
    model: { format: 'OpenAI', name: chatModelName, version: chatModelVersion }
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.Default'
  }
}
resource embedding 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'fraud-embedding'
  sku: { name: 'Standard', capacity: embeddingCapacity }
  properties: {
    model: { format: 'OpenAI', name: embeddingModelName, version: embeddingModelVersion }
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.Default'
  }
  dependsOn: [chat]
}
resource sqlServer 'Microsoft.Sql/servers@2023-08-01' = {
  name: '${base}-sql'
  location: location
  tags: tags
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: bootstrapEnabled ? 'Application' : sqlAdminPrincipalType
      login: bootstrapEnabled ? bootstrapIdentity.name : sqlAdminLogin
      sid: bootstrapEnabled ? bootstrapIdentity.properties.principalId : sqlAdminObjectId
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: true
    }
  }
}
resource sqlProxy 'Microsoft.Sql/servers/connectionPolicies@2023-08-01' = {
  parent: sqlServer
  name: 'default'
  properties: { connectionType: 'Proxy' }
}
resource database 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sqlServer
  name: 'fraudpoc'
  location: location
  tags: tags
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: {
    maxSizeBytes: 2147483648
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    requestedBackupStorageRedundancy: 'Local'
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${base}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.5') }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${base}-insights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
    DisableLocalAuth: true
  }
}
resource monitorScope 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = {
  name: '${base}-monitor-private'
  location: 'global'
  tags: tags
  properties: { accessModeSettings: { ingestionAccessMode: 'PrivateOnly', queryAccessMode: 'PrivateOnly' } }
}
resource monitorLogs 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: monitorScope
  name: 'logs'
  properties: { linkedResourceId: logs.id }
}
resource monitorInsights 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: monitorScope
  name: 'insights'
  properties: { linkedResourceId: insights.id }
}

resource plans 'Microsoft.Web/serverfarms@2023-12-01' = [for name in ['web', 'services']: {
  name: '${base}-${name}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic', capacity: 1 }
  properties: { reserved: true }
}]
var commonSettings = {
  NODE_ENV: 'production'
  TENANT_ID: subscription().tenantId
  API_AUDIENCE: 'api://${authClientId}'
  ALLOWED_USER_OIDS: publicDemoEnabled ? '${allowedUserOid},${publicDemoUserOid}' : allowedUserOid
  BROKER_URL: 'https://${appNames[1]}.azurewebsites.net'
  KNOWLEDGE_URL: 'https://${appNames[2]}.azurewebsites.net'
  SQL_SERVER: '${sqlServer.name}.database.windows.net'
  SQL_DATABASE: database.name
  OPENAI_ENDPOINT: 'https://${openai.name}.openai.azure.com'
  CHAT_DEPLOYMENT: chat.name
  EMBEDDING_DEPLOYMENT: embedding.name
  MODEL_VERSION: chatModelVersion
  SEARCH_ENDPOINT: 'https://${search.name}.search.windows.net'
  SEARCH_INDEX: 'fraud-policy-f17745ee4ea35aba'
  STORAGE_ACCOUNT_URL: 'https://${storage.name}.blob.core.windows.net'
  EVIDENCE_CONTAINER: 'evidence'
  SOURCE_AS_OF: '2026-10-01T00:00:00Z'
  KNOWLEDGE_MODE: 'hybrid'
  WEBSITE_RUN_FROM_PACKAGE: '1'
  SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
}
var commonAppSettings = [for setting in items(commonSettings): { name: setting.key, value: setting.value }]
resource apps 'Microsoft.Web/sites@2023-12-01' = [for (role, i) in roles: {
  name: appNames[i]
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities[i].id}': {} }
  }
  properties: {
    serverFarmId: plans[i == 0 ? 0 : 1].id
    httpsOnly: true
    // Finalize opens only an explicitly selected public synthetic web after acceptance.
    publicNetworkAccess: 'Disabled'
    virtualNetworkSubnetId: '${vnet.id}/subnets/${subnetNames[i]}'
    vnetRouteAllEnabled: true
    keyVaultReferenceIdentity: identities[i].id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node src/server.mjs'
      alwaysOn: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      scmIpSecurityRestrictionsUseMain: false
      scmIpSecurityRestrictionsDefaultAction: 'Deny'
      appSettings: concat(commonAppSettings, [
        { name: 'ROLE', value: role }
        { name: 'AZURE_CLIENT_ID', value: identities[i].properties.clientId }
        { name: 'ALLOWED_CALLER_OIDS', value: identities[0].properties.principalId }
        { name: 'PUBLIC_DEMO_ENABLED', value: publicDemoEnabled && i == 0 ? 'true' : 'false' }
        { name: 'PUBLIC_DEMO_USER_OID', value: publicDemoUserOid }
        { name: 'PUBLIC_DEMO_DATASET', value: 'azure-sql-synthetic-fraud-v1' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
      ])
    }
  }
}]
resource authSettings 'Microsoft.Web/sites/config@2023-12-01' = [for (role, i) in roles: {
  parent: apps[i]
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: !(publicDemoEnabled && i == 0), runtimeVersion: '~1' }
    globalValidation: {
      requireAuthentication: !(publicDemoEnabled && i == 0)
      unauthenticatedClientAction: publicDemoEnabled && i == 0 ? 'AllowAnonymous' : (i == 0 ? 'RedirectToLoginPage' : 'Return401')
      redirectToProvider: 'azureActiveDirectory'
      excludedPaths: ['/health/live']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: union({
          openIdIssuer: 'https://login.microsoftonline.com/${subscription().tenantId}/v2.0'
          clientId: authClientId
        }, i == 0 ? { clientSecretSettingName: 'AAD_CLIENT_SECRET' } : {})
        validation: {
          allowedAudiences: ['api://${authClientId}', authClientId]
          defaultAuthorizationPolicy: {
            allowedApplications: i == 0 ? [authClientId, '04b07795-8ddb-461a-bbee-02f9e1bf7b46'] : [identities[0].properties.clientId]
            allowedPrincipals: {
              identities: i == 0 ? [allowedUserOid] : [identities[0].properties.principalId]
            }
          }
        }
      }
    }
    login: { tokenStore: { enabled: false }, preserveUrlFragmentsForLogins: false }
    httpSettings: { requireHttps: true }
  }
}]
resource publishingScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = [for (role, i) in roles: {
  parent: apps[i]
  name: 'scm'
  properties: { allow: false }
}]
resource publishingFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = [for (role, i) in roles: {
  parent: apps[i]
  name: 'ftp'
  properties: { allow: false }
}]
resource appDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = [for (role, i) in roles: {
  name: 'private-poc-logs'
  scope: apps[i]
  properties: {
    workspaceId: logs.id
    logs: [{ category: 'AppServiceConsoleLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}]

var appEndpointTargets = [for (role, i) in roles: {
  name: role
  resourceId: apps[i].id
  group: 'sites'
  zones: [0]
}]
var endpointTargets = concat(appEndpointTargets, [
  { name: 'openai', resourceId: openai.id, group: 'account', zones: [1] }
  { name: 'search', resourceId: search.id, group: 'searchService', zones: [2] }
  { name: 'blob', resourceId: storage.id, group: 'blob', zones: [3] }
  { name: 'vault', resourceId: vault.id, group: 'vault', zones: [4] }
  { name: 'sql', resourceId: sqlServer.id, group: 'sqlServer', zones: [5] }
  { name: 'monitor', resourceId: monitorScope.id, group: 'azuremonitor', zones: [6, 7, 8, 9, 3] }
])
resource endpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for target in endpointTargets: {
  name: '${base}-${target.name}-pe'
  location: location
  tags: tags
  properties: {
    subnet: { id: '${vnet.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [{
      name: '${target.name}-connection'
      properties: { privateLinkServiceId: target.resourceId, groupIds: [target.group] }
    }]
  }
  dependsOn: [monitorLogs, monitorInsights]
}]
resource endpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (target, i) in endpointTargets: {
  parent: endpoints[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for zoneIndex in target.zones: {
      name: replace(dnsNames[zoneIndex], '.', '-')
      properties: { privateDnsZoneId: dnsZones[zoneIndex].id }
    }]
  }
}]

resource modelReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for index in [0, 2]: {
  name: guid(openai.id, identities[index].id, openAiUserRole)
  scope: openai
  properties: { principalId: identities[index].properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: openAiUserRole }
}]
resource evidenceWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containers[0].id, identities[0].id, blobContributorRole)
  scope: containers[0]
  properties: { principalId: identities[0].properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: blobContributorRole }
}
resource knowledgeReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, identities[2].id, searchReaderRole)
  scope: search
  properties: { principalId: identities[2].properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: searchReaderRole }
}
resource webSecretsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identities[0].id, secretsUserRole)
  scope: vault
  properties: { principalId: identities[0].properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: secretsUserRole }
}
resource bootstrapSearchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [searchWriterRole, searchManagerRole]: if (bootstrapEnabled) {
  name: guid(search.id, bootstrapIdentity.id, role)
  scope: search
  properties: { principalId: bootstrapIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: role }
}]
resource bootstrapOpenAiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapEnabled) {
  name: guid(openai.id, bootstrapIdentity.id, openAiUserRole)
  scope: openai
  properties: { principalId: bootstrapIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: openAiUserRole }
}
resource bootstrapStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapEnabled) {
  name: guid(containers[2].id, bootstrapIdentity.id, blobContributorRole)
  scope: containers[2]
  properties: { principalId: bootstrapIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: blobContributorRole }
}
resource bootstrapVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapEnabled) {
  name: guid(vault.id, bootstrapIdentity.id, secretsOfficerRole)
  scope: vault
  properties: { principalId: bootstrapIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: secretsOfficerRole }
}
resource bootstrapDeployRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (role, i) in roles: if (bootstrapEnabled) {
  name: guid(apps[i].id, bootstrapIdentity.id, 'website-contributor')
  scope: apps[i]
  properties: {
    principalId: bootstrapIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
  }
}]

output apps array = [for (role, i) in roles: {
  role: role
  name: apps[i].name
  url: 'https://${apps[i].properties.defaultHostName}'
  identityId: identities[i].id
  clientId: identities[i].properties.clientId
  principalId: identities[i].properties.principalId
}]
output deployment object = {
  resourceGroup: resourceGroup().name
  subscriptionId: subscription().subscriptionId
  deploymentId: deploymentId
  bootstrapEnabled: bootstrapEnabled
  publicDemoEnabled: publicDemoEnabled
  publicDemoUserOid: publicDemoUserOid
  sqlAdminObjectId: sqlAdminObjectId
  sqlAdminLogin: sqlAdminLogin
  sqlAdminPrincipalType: sqlAdminPrincipalType
  location: location
  modelLocation: aiLocation
  tenantId: subscription().tenantId
  authClientId: authClientId
  allowedUserOid: allowedUserOid
  bootstrap: {
    name: '${base}-setup'
    type: 'temporary-private-app-service'
    identityId: bootstrapIdentity.id
    clientId: bootstrapIdentity.properties.clientId
    principalId: bootstrapIdentity.properties.principalId
  }
  sqlServer: sqlServer.name
  sqlHost: '${sqlServer.name}.database.windows.net'
  sqlDatabase: database.name
  openaiName: openai.name
  openaiEndpoint: 'https://${openai.name}.openai.azure.com'
  chatDeployment: chat.name
  modelVersion: chatModelVersion
  searchIndex: 'fraud-policy-f17745ee4ea35aba'
  embeddingDeployment: embedding.name
  searchName: search.name
  searchEndpoint: 'https://${search.name}.search.windows.net'
  storageName: storage.name
  storageUrl: 'https://${storage.name}.blob.core.windows.net'
  vaultName: vault.name
  vaultUri: vault.properties.vaultUri
  logsName: logs.name
  vnetName: vnet.name
  setupPlanId: plans[0].id
  setupSubnetId: '${vnet.id}/subnets/bootstrap'
}
