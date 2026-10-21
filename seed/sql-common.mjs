import sql from 'mssql';
import { ManagedIdentityCredential } from '@azure/identity';
import { GUID } from '../src/validation.mjs';

export function guidToSqlSid(value) {
  if (!GUID.test(value ?? '')) throw new Error('A valid identity GUID is required');
  const b = Buffer.from(value.replaceAll('-', ''), 'hex');
  return `0x${Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]).toString('hex')}`;
}

export function brokerPrincipal(env = process.env) {
  const name = env.BROKER_SQL_USER;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(name ?? '')) throw new Error('BROKER_SQL_USER must be a simple SQL identifier');
  return {
    name, sid: guidToSqlSid(env.BROKER_CLIENT_ID),
    legacySid: env.BROKER_LEGACY_OBJECT_ID ? guidToSqlSid(env.BROKER_LEGACY_OBJECT_ID) : undefined,
  };
}

export async function connectManagedSql(env = process.env) {
  if (!GUID.test(env.AZURE_CLIENT_ID ?? '') || !/^[a-z0-9.-]+\.database\.windows\.net$/i.test(env.SQL_SERVER ?? '')) throw new Error('Managed identity and Azure SQL server configuration are required');
  const credential = new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
  const token = await credential.getToken('https://database.windows.net/.default');
  if (!token?.token) throw new Error('SQL managed identity token unavailable');
  const pool = new sql.ConnectionPool({
    server: env.SQL_SERVER, database: env.SQL_DATABASE ?? 'fraudpoc',
    authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 20000, requestTimeout: 60000, pool: { max: 2, min: 0 },
  });
  pool.on('error', () => console.error(JSON.stringify({ event: 'sql_connection_error' })));
  await pool.connect();
  return pool;
}

export { sql };
