Fraud Analytics on Azure
========================

A deployable **synthetic-data proof of concept**, with a browser analyst
experience, governed read-only analytics, effective-dated policy retrieval,
and answer evidence.

Deploy it into **your own Azure subscription and Microsoft Entra tenant**.
No credentials, resource IDs, deployment state, or access to the original
demonstration environment are required.

.. image:: https://aka.ms/deploytoazurebutton
   :target: https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FCarcamo-ben%2Ffraud-analytics-azure-poc%2Fmain%2Fazuredeploy.json
   :alt: Deploy infrastructure to Azure

**The button provisions infrastructure only.** It does not install the
application, configure Entra, seed the synthetic data/policy index, or complete
acceptance. Follow the `deployment guide <docs/deployment.rst>`_ to finish the
setup. A successful ARM deployment alone is not a working application.

Start here
----------

* `Customer deployment guide <docs/deployment.rst>`_: prerequisites, customer
  configuration, command-line and portal paths, recovery, and teardown.
* `Architecture and boundaries <docs/architecture.rst>`_: what the sample
  implements and what remains enterprise integration work.
* `Customer configuration example <deploy/customer.example.json>`_.
* `Bicep source <infra/main.bicep>`_ and `compiled ARM template <azuredeploy.json>`_.

What you get
------------

* Restored red-navigation analyst UI, guided comparisons, standalone natural
  language questions, a rule/policy library, and an evidence inspector.
* Numerical results calculated from approved, parameterized SQL views, not
  invented by a language model. Counts, monetary precision, cohort suppression,
  and query/output limits are checked in code.
* Approved effective-dated policy versions, explicit scoped supersession,
  historical applicability, and unresolved-conflict withholding.
* Trace IDs, source timestamps, policy snapshot identities, planner execution
  provenance, and complete broker receipts in create-only answer evidence.
* Separate managed identities and private backend/data/model endpoints.
  Authentication/private website access is the default. An anonymous,
  synthetic-only website is an explicit deployment choice.
* Automated application, policy, contract, browser, and mocked deployment
  lifecycle tests.

What this is not
----------------

This sample uses **Azure SQL Database, Azure AI Search, and planner-only Azure
OpenAI**. It does not deploy Microsoft Fabric or Microsoft Foundry. The model
chooses a bounded query plan; application code calculates and assembles the
answer. It is not unrestricted SQL generation or model-driven causal analysis.

The dataset consists of fictional August/September 2026 aggregates and fictional
policy documents. It is **not Rogers data**, not an official Rogers or Microsoft
product, not an original SQL MI/Oracle integration, and not a demonstration of
1 TB performance. The UI's platform-reference documentation describes possible
future integrations, not deployed capabilities.

Local preview
-------------

Use Node.js 22 and an existing Windows PowerShell terminal:

.. code-block:: powershell

   git clone https://github.com/Carcamo-ben/fraud-analytics-azure-poc.git
   Set-Location .\fraud-analytics-azure-poc
   npm ci --ignore-scripts
   npm run preview -- --evidence-directory "$env:LOCALAPPDATA\FraudAnalyticsSample\evidence" --port 43187

Open ``http://127.0.0.1:43187``. The folder must be dedicated to this preview;
an arbitrary nonempty folder is refused. Ctrl+C stops the server without
deleting evidence.

The local preview uses the real application/policy/calculation code with
**local synthetic transports**. It does not connect to SQL, Search, Fabric,
Foundry, or a chat model. Guided analysis and policy browsing work; natural
language planning is deliberately unavailable rather than simulated.

Tests
-----

.. code-block:: powershell

   npm test
   npm run test:browser

Browser tests use the installed Microsoft Edge browser and the locked Playwright
development dependency. No Azure credentials are needed. The deployment
lifecycle tests require PowerShell 7; without it those cases are skipped.

To additionally confirm the checked-in ARM template matches Bicep:

.. code-block:: powershell

   $env:VERIFY_BICEP_BUILD = '1'
   node --test tests\deployment-portability.test.mjs tests\cloud-acceptance.test.mjs

This requires Azure CLI with Bicep and PowerShell 7 on PATH. If ``pwsh`` is not
on PATH, set ``DEPLOYMENT_TEST_PWSH`` to its installed executable.

Deployment confidence
---------------------

The application has been exercised against a live synthetic Azure deployment.
The portable customer-subscription workflow is locally covered by Bicep
compilation, contract tests, and mocked Azure lifecycle tests. It has **not**
been established by those tests that an arbitrary customer's tenant, policies,
regional model quota, or networking will permit deployment. The workflow has
explicit acceptance and finalization gates; do not treat submission as success.

Cost and operations
-------------------

Azure resources are billable until explicitly removed. App Service plans,
Search, SQL, private endpoints, monitoring/storage, and model inference can all
incur charges. Configure a customer budget and inspect the pricing calculator
before provisioning. Request quotas are **not a spending cap**.

Do not upload personal/customer data. The public mode shares a synthetic
identity and evidence namespace; it is not a production authentication model.
The generated web sign-in credential expires after 30 days and requires
customer-operated rotation.

License
-------

`MIT <LICENSE>`_. Product names and trademarks remain their owners' property.
This repository provides no rights to third-party branding and no production
support or compliance certification.
