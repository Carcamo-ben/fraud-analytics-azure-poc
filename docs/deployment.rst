Deploy into your Azure subscription
==================================

This guide deploys the sample's synthetic SQL data, approved UI, private
analytics/knowledge services, regional Azure OpenAI deployments and evidence
storage into a **customer-owned subscription**.

The supported deployment workstation is **Windows with PowerShell 7,
Node.js 22, Azure CLI, Bicep, Git and Windows tar**. The application itself runs
on Linux App Service. No access to the author's Azure environment is required.

The checked-in ARM template and portable orchestration are locally validated.
They have not been proven by a new deployment in your tenant. Regional quotas,
tenant consent, Azure Policy and network restrictions can block deployment.
The acceptance gates exist to detect that, not to certify a deployment before
it runs.

Before you begin
----------------

1. Use a new, dedicated resource group. The command-line path refuses to take
   over unrelated resources. The only supported pre-existing infrastructure
   path is explicit adoption of a matching portal deployment described below.
2. Review cost. The template provisions two single-instance Linux Basic App
   Service plans, Azure SQL Database, Basic Azure AI Search, Azure OpenAI,
   Storage, Key Vault, private endpoints/DNS and monitoring resources.
   Resources remain billable when the UI is idle. Capacity values are Azure
   deployment units, not a promised number of requests or a monetary cap.
3. Your deployer needs permission to create the resources and their scoped
   role assignments. An Azure subscription Owner, or Contributor plus an
   appropriate role-assignment administrator, is a common arrangement;
   customer policies may require a narrower custom role.
4. Obtain a **dedicated single-tenant Entra app registration** in the
   subscription's tenant. The deployer must be able to configure that
   registration, create its enterprise application and manage its credentials.
   App registration rights are separate from Azure subscription RBAC.
   Do not reuse an existing business application's registration.
5. Select the Entra user allowed to access the sample and a customer user/group
   to become the SQL server's final Entra administrator. For private-mode
   acceptance, Azure CLI must be signed in as the allowed user.
6. Check regional availability and quota for the exact chat and embedding
   model/version. The sample requires Canadian **regional Standard**
   deployments. It will not silently use Global or DataZone models.
   Example model versions are configuration examples, not an availability
   guarantee; versions can retire.
7. For private mode, provide a client path into the VNet and working private
   DNS, for example existing VPN/peering and DNS forwarding. This repository
   does **not** deploy a VPN gateway or provide private browser connectivity.
8. Review inherited policies and diagnostic destinations. A Canadian resource
   location does not attest all telemetry residency or regulatory compliance.

Install prerequisites using your organization's approved method. Open
PowerShell 7 and confirm:

.. code-block:: powershell

   pwsh --version
   node --version
   az version
   az bicep version
   tar --version
   git --version

``node --version`` must report major version 22 for every ``Deploy.ps1`` phase.
If Bicep is missing, install it with ``az bicep install`` and then repeat its
version check.

Clone and sign in
----------------

.. code-block:: powershell

   git clone https://github.com/Carcamo-ben/fraud-analytics-azure-poc.git
   Set-Location .\fraud-analytics-azure-poc
   npm ci --ignore-scripts

   $tenantId = '<customer-tenant-id>'
   $subscriptionId = '<customer-subscription-id>'
   az login --tenant $tenantId
   az account set --subscription $subscriptionId
   az account show --query '{subscription:id,tenant:tenantId}' --output json

Use a pinned release tag or commit for a repeatable rollout, and retain that
commit alongside the local deployment checkpoint. Do not modify the source or
configuration halfway through a bootstrap.

Ensure these resource providers are registered in the selected subscription:

.. code-block:: powershell

   $providers = @(
     'Microsoft.Web', 'Microsoft.Network', 'Microsoft.ManagedIdentity',
     'Microsoft.Storage', 'Microsoft.Sql', 'Microsoft.Search',
     'Microsoft.CognitiveServices', 'Microsoft.KeyVault',
     'Microsoft.OperationalInsights', 'Microsoft.Insights'
   )
   foreach ($provider in $providers) {
     az provider show --namespace $provider --subscription $subscriptionId `
       --query registrationState --output tsv
   }

For each provider that is not Registered, a permitted administrator can run
``az provider register --namespace <provider> --subscription <subscription-id> --wait``.
Normal ``Microsoft.Resources`` and ``Microsoft.Authorization`` availability is
also required. The Validate phase does not register providers for you.

Create customer configuration
-----------------------------

An administrator can create a dedicated registration in the portal, or:

.. code-block:: powershell

   $appClientId = az ad app create `
     --display-name 'Customer Fraud Analytics Sample' `
     --sign-in-audience AzureADMyOrg --query appId --output tsv
   $allowedUserOid = az ad signed-in-user show --query id --output tsv

Do not create a client secret manually for this workflow. Bootstrap generates
the required short-lived credential and places it in the private Key Vault.
Secret/token values are not written to the local checkpoint or printed.

.. code-block:: powershell

   New-Item -ItemType Directory -Path .\.deployment -Force | Out-Null
   Copy-Item .\deploy\customer.example.json .\.deployment\customer.json
   $configPath = '.\.deployment\customer.json'
   $config = Get-Content $configPath -Raw | ConvertFrom-Json
   $config.subscriptionId = $subscriptionId
   $config.authClientId = $appClientId
   $config.allowedUserOid = $allowedUserOid
   $config.resourceGroup = 'rg-customer-fraud-sample'
   $config.sqlAdminObjectId = '<customer-sql-admin-group-object-id>'
   $config.sqlAdminLogin = '<customer-sql-admin-group-display-name>'
   $config.sqlAdminPrincipalType = 'Group'
   $config.ownerTag = '<customer-owner-or-team>'
   $config.reviewAfter = '<YYYY-MM-DD>'
   $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8

Replace every angle-bracket value. The SQL administrator may instead be a User;
set its object ID, display name and ``sqlAdminPrincipalType`` consistently.
Do not put a group ID into ``allowedUserOid``; that field is the allowed
individual user's object ID.

Configuration reference:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Field
     - Meaning
   * - subscriptionId / resourceGroup
     - Your target subscription and dedicated new resource group.
   * - location / aiLocation
     - ``canadaeast`` or ``canadacentral``; exact model availability must pass.
   * - authClientId
     - Application/client ID of the dedicated single-tenant registration.
   * - allowedUserOid
     - Entra object ID of the permitted user and private bootstrap verifier.
   * - sqlAdminObjectId / sqlAdminLogin / sqlAdminPrincipalType
     - Final customer SQL administrator; a User or Group, not the bootstrap identity.
   * - ownerTag / reviewAfter
     - Customer ownership and review date. The date does not schedule deletion.
   * - chatModelName / chatModelVersion / chatCapacity
     - Available regional chat model/version and requested Standard capacity.
   * - embeddingModelName / embeddingModelVersion / embeddingCapacity
     - ``text-embedding-3-small``, available version, and Standard capacity;
       the current index contract uses 1,536 dimensions.
   * - publicDemoEnabled / publicDemoUserOid
     - Explicit anonymous synthetic demo opt-in, described below.

**Keep ``.deployment/`` private and backed up.** Git ignores the entire folder.
State is pinned to the configuration and ownership ID. Editing IDs or deleting
state to bypass a failed phase is not recovery.

Default private mode
--------------------

Keep ``publicDemoEnabled`` false and ``publicDemoUserOid`` an empty string.
The website requires customer private connectivity and Entra sign-in.
Private API and data/model access remain separate from browser access.

Optional public synthetic demo
------------------------------

Only if the customer approves anonymous access to **fictional synthetic data**,
make this change **before Initialize**:

.. code-block:: powershell

   $config = Get-Content $configPath -Raw | ConvertFrom-Json
   $config.publicDemoEnabled = $true
   $config.publicDemoUserOid = [guid]::NewGuid().ToString()
   $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8

The generated UUID is a server-owned fictional demo identity, not an Entra
user to create. It must differ from the permitted user, app client and SQL
administrator IDs.

The workflow keeps ingress private during setup. Only the web app becomes
public after successful finalization. Backend APIs, SQL, Search, Blob, Vault
and model endpoints remain private. Public answers/evidence share the synthetic
demo namespace. Never load real customer data into this mode.

Recommended command-line deployment
-----------------------------------

Run each phase and inspect its outcome before proceeding:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Validate -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Initialize -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Provision -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Bootstrap -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Status -Config $configPath

* **Validate** checks customer configuration, Azure context and model/version/
  quota metadata. It performs Azure reads but creates no cloud resources.
* **Initialize** pins ownership/configuration and configures the dedicated
  registration's API scope and Azure CLI preauthorization.
* **Provision** deploys the infrastructure and explicitly enables temporary
  setup access. A provisioning error is not an automatic rollback.
* **Bootstrap** submits an asynchronous private Linux setup job. It installs
  locked production dependencies, seeds only the sample SQL data, tests the
  actual broker identity's read-only restrictions, verifies the policy index,
  deploys matching application packages and runs live API/policy acceptance.
* **Status** observes that job. Submission, a Running App Service, or an ARM
  Succeeded status does not establish bootstrap completion.

Repeat Status until it reports **``"setupStatus": "succeeded"``**. The local
``phase`` can still say ``bootstrapping`` at this point. Then:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Finalize -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Status -Config $configPath

Finalize verifies the accepted source hash, transfers SQL administration,
removes temporary roles/host and, if configured, opens only the public web
endpoint and waits for its complete readiness. The bootstrap identity remains
inert without temporary role assignments.

Do not leave setup privileges active after a successful run. The deployment
is not complete until Finalize succeeds. A finalized or aborted checkpoint
cannot reactivate bootstrap.

Private-mode acceptance identity
-------------------------------

Bootstrap automatically requests a delegated token for the sample API using
the signed-in Azure CLI user. The token must match ``allowedUserOid`` and the
subscription tenant and have at least 30 minutes remaining.

If token acquisition needs consent or interactive sign-in after Initialize:

.. code-block:: powershell

   az login --tenant $tenantId --scope "api://$appClientId/access_as_user"
   az account set --subscription $subscriptionId
   pwsh -File .\deploy\Deploy.ps1 -Phase Bootstrap -Config $configPath

Do not paste access tokens into configuration, terminals shared with others,
issues or source control. Follow your tenant's consent policy; the script
does not bypass it.

Portal Deploy to Azure path
---------------------------

Use the repository's Deploy to Azure button only if you prefer the portal
for initial infrastructure provisioning.

1. Prepare the dedicated Entra app and customer configuration first.
2. Choose your subscription and a new dedicated resource group in the portal.
3. Enter matching configuration values. Use
   ``infra\azuredeploy.parameters.example.json`` as the field reference.
4. Keep **``bootstrapEnabled=false``**. Do not expose temporary seeding/admin
   rights through an unattended infrastructure-only deployment.
5. Review pricing, permissions and parameters, then submit. The template
   generates resource names and a new deployment ownership UUID.
6. Wait for Succeeded and record the actual deployment name from the resource
   group's deployment history. Applications are still infrastructure-only,
   private, and not seeded.
7. From the same clone, adopt that exact deployment:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Validate -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Initialize -Config $configPath `
     -PortalDeploymentName '<actual-portal-deployment-name>'
   pwsh -File .\deploy\Deploy.ps1 -Phase Provision -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Bootstrap -Config $configPath
   pwsh -File .\deploy\Deploy.ps1 -Phase Status -Config $configPath

After ``setupStatus`` is ``succeeded``, run Finalize as above. Adoption checks
the portal parameters, ownership and ``apps``/``deployment`` outputs. It does
not take over arbitrary existing resources.

Do not independently redeploy the portal template over a finalized environment:
it represents initial infrastructure, not the application's upgrade workflow.

What to inspect after finalization
----------------------------------

Local output is under
``.deployment\<subscriptionId>-<resourceGroup>\``. Inspect its state and
deployment outputs for the generated web URL, resource names and accepted
source hash. Do not share this directory publicly.

The private storage account contains the detailed API report at
``artifacts/acceptance/latest.json``. During setup, the temporary host's
``/home/customer-bootstrap/`` contains the bounded runner journal/logs.
Those host files disappear when the temporary host is removed; the cloud
acceptance artifact is the persistent record.

Open the generated web URL using the appropriate access mode:

* Private mode: customer network/private DNS and the allowed Entra user.
* Public mode: no sign-in; the page must clearly identify fictional synthetic data.

Exercise a guided loss comparison, rule analysis, policy lookup and evidence
inspection. Confirm the expected policy version changes and conflict
withholding. Verify natural-language planning separately from guided analytics.
API acceptance is not a completed browser walkthrough or enterprise-scale test.

Recovery and failure handling
----------------------------

* **Missing regional quota/model:** fix quota or select an offered Canadian
  Standard configuration before Initialize. No Global/DataZone fallback occurs.
* **Private connectivity/authentication failure:** inspect status and Azure
  deployment operations. Do not enable public data endpoints or broaden
  runtime permissions to make a check pass.
* **Asynchronous startup:** setup waits for the old process to stop and for
  full readiness. Public dependency results can be cached for five minutes;
  liveness alone is not sufficient. Allow the bounded readiness window.
* **Failed bootstrap or stale submitted attempt:** inspect Status first.
  ``-Resume`` is allowed for a failed attempt, or a submitted attempt stale
  for at least 15 minutes. It retains the pinned package/runner:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Bootstrap -Config $configPath -Resume
   pwsh -File .\deploy\Deploy.ps1 -Phase Status -Config $configPath

An existing content-addressed Search index is checked against the complete
schema/metadata/content snapshot; it is not silently overwritten. A conflicting
or partial index requires operator investigation.

Do not resume while the original run is still actively making progress. The
runner has a 90-minute overall deadline and 15-minute readiness windows.
Source archives above 1 MiB or settings transport above the conservative
240 KB cap are refused rather than truncated.

If abandoning a partial deployment:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Abort -Config $configPath

Abort stops runtime, disables ingress, transfers SQL administration, revokes
temporary setup access and removes the generated credential. It deliberately
does **not** delete billable infrastructure. Inspect failures rather than
assuming all cleanup completed.

Operations and teardown
-----------------------

The generated Entra web credential expires after **30 days**. Before expiry,
the customer must rotate the app credential and the corresponding private
Key Vault secret, retain the intended Key Vault reference, and verify sign-in.
Automatic credential rotation is not provided. Do not re-enable finalized
bootstrap to rotate a credential.

This is an initial-deployment workflow, not a general rolling-upgrade
controller. Retain source hashes and deployment checkpoints; plan coordinated
web/broker/knowledge/index upgrades and rollback before production use.

To stop paying for an unneeded dedicated sample, first finalize successful
setup or abort failed setup. Review/export any evidence you need, then
**explicitly delete only the dedicated sample resource group**:

.. code-block:: powershell

   az group delete --subscription $subscriptionId --name 'rg-customer-fraud-sample'

The CLI prompts for confirmation. Resource-group deletion does not delete the
customer's Entra app registration, user or administrator group. Review/remove
the dedicated registration separately when no longer needed. Key Vault
soft-delete/purge-protection can retain names/resources according to Azure
policy; do not disable those safeguards to speed up cleanup.

Rebuilding the portal template
------------------------------

After changing Bicep, rebuild and commit the ARM template together:

.. code-block:: powershell

   pwsh -File .\deploy\Deploy.ps1 -Phase Build
   $env:VERIFY_BICEP_BUILD = '1'
   node --test tests\deployment-portability.test.mjs tests\cloud-acceptance.test.mjs

Build requires the local tools but does not require configuration or Azure
sign-in. Never put real deployment parameters into the checked-in example.
