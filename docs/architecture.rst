Architecture and boundaries
===========================

Runtime
-------

.. code-block:: text

   Browser
      |
      v
   Web App Service ----> Azure OpenAI: bounded query planner
      |     |
      |     +----------> Private Blob: answer evidence
      |
      +--> Private Broker App Service --> Azure SQL reporting views
      |
      +--> Private Knowledge App Service --> Azure AI Search
                                                   |
                                              approved policy
                                              snapshot + dates

The three application roles use distinct user-assigned managed identities.
The web identity cannot query SQL. The broker's contained SQL identity has
object-specific SELECT permissions and explicit write/execute/DDL denials.
The knowledge identity reads Search and invokes regional embeddings; it cannot
write the index.

Temporary initial setup is a separate, elevated lifecycle. It seeds only the
dedicated synthetic database, proves SQL restrictions with the actual broker
identity, creates/verifies the content-addressed index, and deploys the locked
runtime. Finalization transfers SQL administration to the customer's designated
user/group and removes temporary setup privileges/host. That setup path is
not a general-purpose production deployment identity.

Data and questions
------------------

The fixture contains 54 loss aggregates and 162 rule-outcome aggregates for
August and September 2026. Two bounded analysis kinds support complete-month
comparisons. All numbers come from the broker, with approved grouping and date
validation. Missing periods are not zero; small cohorts withhold the whole
result to prevent subtraction reconstruction.

Questions are standalone, not a multi-turn contextual conversation. The chat
model receives the question and a versioned planner prompt/schema, not the
full database. It returns a supported typed plan or a refusal. The deterministic
application combines the resulting numbers with retrieved policy context.

Policy and evidence
-------------------

The policy manifest is fictional, versioned, and immutable within a release.
Its 16 chunks include current, historical, future, draft, scoped, expired, and
conflicting examples. Search relevance cannot decide policy precedence.
Approved effective windows and explicit scoped supersession determine
applicability before ranked excerpts are selected.

Unresolved conflicts withhold policy interpretation while valid numerical
facts remain available. Current authorization also applies when retrieving
historical evidence. Evidence preserves the original answer, request,
policy evaluation, broker payload digest, and available model execution
identity. It is application-level create-only storage; independently configured
infrastructure WORM/retention is not claimed.

Access modes
------------

**Default:** private website and private dependencies, with customer Entra
sign-in. The customer must provide private client connectivity and DNS.

**Explicit public demo:** only the website becomes publicly reachable, without
sign-in, after successful acceptance/finalization. The APIs and data/model
dependencies stay private. The server supplies one fictional analyst identity;
public evidence is shared within that synthetic namespace.

Public limits are 12 expensive requests per minute, two simultaneous requests,
and 300 requests per UTC day on the single demo worker. The persisted daily
budget is not distributed and is not a financial cap. Do not scale out without
implementing a suitable shared quota mechanism.

Customer responsibilities
-------------------------

* Review subscription policy, regional model availability, capacity, quotas,
  and ongoing cost before provisioning.
* Review diagnostic destinations and inherited Azure policies. Selecting a
  Canadian region is not proof that every inherited telemetry route is Canadian.
* Provide private DNS/client connectivity for authenticated/private mode.
* Rotate the 30-day Entra web credential before expiry.
* Review production authorization, PII handling, retention, disaster recovery,
  monitoring, application lifecycle and evaluation requirements.
* Implement and validate real-source connectors and representative performance
  before claiming SQL MI/Oracle or approximately 1 TB support.

Fabric, Foundry, Purview integration, source-system ingestion, production
governance, unrestricted analysis, and end-to-end compliance are not provided
by this deployment. The sample's limitations are deliberate and visible.
