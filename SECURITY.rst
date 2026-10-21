Security and safe use
====================

Use fictional synthetic data only. Do not enter customer records, personal
information, secrets, payment information or credentials into the demo.

Never commit ``.deployment/``, environment files, access tokens, publish
profiles, keys, evidence exports, or customer configuration/state. The included
ignore rules are a precaution, not a substitute for reviewing commits.

Do not report secrets or private customer details in public issues. Use
GitHub's private vulnerability reporting when enabled for this repository.
For a defect in an Azure service itself, use Microsoft's published security
reporting channel rather than posting exploitable customer details here.

The template is private by default. Public mode is an explicitly authorized
synthetic demonstration, not production access control. Do not weaken backend
authentication, read-only SQL permissions, private endpoints, data boundaries,
or failure gates to make a deployment pass.

Do not leave failed setup unattended. Follow the Abort/recovery instructions
in ``docs/deployment.rst`` to revoke temporary privileges. Abort does not
remove billable infrastructure; resource deletion is a separate owner action.
