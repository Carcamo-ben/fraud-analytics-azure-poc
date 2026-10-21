import sql from 'mssql';
import { unavailable } from '../errors.mjs';

const dimensions = { channel: 'channel', merchant: 'merchant', province: 'province' };

function template(kind, groupBy) {
  const dimension = dimensions[groupBy];
  if (!dimension || !['loss_comparison', 'rule_quality'].includes(kind)) throw new Error('Unapproved SQL template');
  const rule = kind === 'rule_quality';
  const surface = rule ? 'reporting.v_rule_outcomes' : 'reporting.v_fraud_losses';
  const values = rule
    ? 'SUM(adjudicated_count) AS adjudicated, SUM(false_positive_count) AS falsePositives'
    : 'SUM(loss_cad) AS loss';
  // The only interpolated identifiers come from this closed, code-owned allowlist.
  return `
    SELECT TOP (101) ${dimension} AS [group]${rule ? ', rule_id AS ruleId' : ''},
      CASE WHEN period_start >= @currentStart AND period_start < @currentEnd THEN 'current' ELSE 'previous' END AS period,
      ${values}, SUM(cohort_count) AS cohortCount, COUNT(DISTINCT period_start) AS months,
      MIN(source_as_of) AS sourceAsOfMin, MAX(source_as_of) AS sourceAsOfMax
    FROM ${surface}
    WHERE business_unit = @businessUnit
      AND ((period_start >= @currentStart AND period_start < @currentEnd)
        OR (period_start >= @previousStart AND period_start < @previousEnd))
    GROUP BY ${dimension}${rule ? ', rule_id' : ''},
      CASE WHEN period_start >= @currentStart AND period_start < @currentEnd THEN 'current' ELSE 'previous' END
    ORDER BY ${dimension}${rule ? ', rule_id' : ''}, period;`;
}

export const TEMPLATES = Object.freeze(Object.fromEntries(
  ['loss_comparison', 'rule_quality'].flatMap((kind) => Object.keys(dimensions).map((group) => [`${kind}:${group}`, template(kind, group)])),
));

export function createSqlClient(config, credential) {
  let current;
  let connecting;
  async function pool(signal) {
    if (current?.expires > Date.now() && current.pool.connected) return current.pool;
    if (connecting) return connecting;
    connecting = (async () => {
      const token = await credential.getToken('https://database.windows.net/.default', { abortSignal: signal });
      if (!token?.token) throw unavailable('SQL authentication');
      const next = new sql.ConnectionPool({
        server: config.sqlServer, database: config.sqlDatabase,
        authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
        options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
        pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
        connectionTimeout: 10000, requestTimeout: 12000,
      });
      next.on('error', () => { console.error(JSON.stringify({ event: 'dependency_error', service: 'sql' })); });
      await next.connect();
      const old = current;
      current = { pool: next, expires: token.expiresOnTimestamp - 300000 };
      if (old) await old.pool.close();
      return next;
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }
  async function query(text, bind, signal) {
    const connection = await pool(signal);
    signal?.throwIfAborted();
    const request = connection.request();
    bind?.(request);
    const abort = () => request.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try { return await request.query(text); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  return {
    async analytics(params, user, signal) {
      const result = await query(TEMPLATES[`${params.kind}:${params.groupBy}`], (request) => {
        request.input('businessUnit', sql.VarChar(20), user.businessUnit);
        for (const [name, value] of Object.entries({
          currentStart: params.current.start, currentEnd: params.current.end,
          previousStart: params.previous.start, previousEnd: params.previous.end,
        })) request.input(name, sql.Date, value);
      }, signal);
      return result.recordset;
    },
    async probe(signal) {
      // Both actual approved surfaces must be accessible; SELECT 1 alone proves too little.
      await query('SELECT TOP (1) period_start FROM reporting.v_fraud_losses; SELECT TOP (1) period_start FROM reporting.v_rule_outcomes;', undefined, signal);
      return { status: 'ready', detail: 'Azure SQL reporting views accessible. Runtime write-denial acceptance is a separate deployment check.' };
    },
    async close() { if (current) await current.pool.close(); },
  };
}
