import { ManagedIdentityCredential } from '@azure/identity';
import { loadConfig } from './config.mjs';
import { authenticateEasyAuth, createApiAuthenticator } from './auth.mjs';
import { createAzureHttp } from './azure-http.mjs';
import { createSqlClient } from './broker/sql.mjs';
import { createModel } from './model.mjs';
import { createKnowledge } from './knowledge/search.mjs';
import { createEvidence } from './evidence.mjs';
import { createServiceCaller, createWebServices } from './web/services.mjs';
import { createApplication } from './app.mjs';
import { createDemoBudget, publicDemoUser } from './public-demo.mjs';

try {
  const config = loadConfig();
  const credential = new ManagedIdentityCredential({ clientId: config.clientId });
  const azureJson = createAzureHttp(credential);
  const model = createModel(config, azureJson);
  const deps = {
    authenticate: config.role === 'web'
      ? (request) => config.publicDemo ? publicDemoUser(config) : authenticateEasyAuth(request.headers, config)
      : createApiAuthenticator(config),
  };
  if (config.publicDemo) deps.demoBudget = createDemoBudget({ filePath: '/home/fraud-demo/request-budget.json' });
  if (config.role === 'broker') deps.sql = createSqlClient(config, credential);
  if (config.role === 'knowledge') deps.knowledge = createKnowledge(config, azureJson, model);
  if (config.role === 'web') {
    deps.web = createWebServices(config, {
      call: createServiceCaller(config, credential), model, evidence: createEvidence(config, credential),
    });
  }
  const server = createApplication(config, deps);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', role: config.role, port: config.port }));
  });
  const close = () => server.close(async () => { await deps.sql?.close(); process.exit(0); });
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} catch {
  // Configuration failures must never enable a permissive authentication or fake-data mode.
  console.error(JSON.stringify({ event: 'startup_failed', code: 'INVALID_CONFIGURATION' }));
  process.exitCode = 1;
}
