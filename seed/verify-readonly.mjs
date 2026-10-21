import { sql, connectManagedSql, brokerPrincipal } from './sql-common.mjs';
import { runReadonlyProbe } from './readonly-probe.mjs';

async function acceptance() {
  const expected = brokerPrincipal();
  const pool = await connectManagedSql();
  try {
    const identity = (await pool.request().query("SELECT name, CONVERT(varchar(34), sid, 1) AS sid, type FROM sys.database_principals WHERE principal_id = USER_ID();")).recordset[0];
    if (identity?.name !== expected.name || identity.sid.toLowerCase() !== expected.sid || identity.type !== 'E') {
      throw new Error('Run this helper with the actual broker managed identity, never the elevated seeding identity');
    }
    await pool.request().query('SELECT TOP (1) loss_cad FROM reporting.v_fraud_losses; SELECT TOP (1) adjudicated_count FROM reporting.v_rule_outcomes;');
    const tests = [
      ['base-table-select', 'SELECT TOP (1) loss_cad FROM synthetic.fraud_losses;'],
      ['insert', "INSERT INTO reporting.v_fraud_losses (business_unit,period_start,channel,merchant,province,loss_cad,cohort_count,source_as_of) SELECT 'poc','2026-09-01','probe','probe','ON',0,10,'2026-10-01' WHERE 1=0;"],
      ['update', 'UPDATE reporting.v_fraud_losses SET loss_cad = loss_cad WHERE 1=0;'],
      ['delete', 'DELETE FROM reporting.v_fraud_losses WHERE 1=0;'],
      ['rule-update', 'UPDATE reporting.v_rule_outcomes SET false_positive_count = false_positive_count WHERE 1=0;'],
      ['ddl', 'CREATE TABLE synthetic.readonly_acceptance_probe (id int);'],
      ['execute', 'EXEC synthetic.readonly_probe;'],
    ];
    const results = [];
    for (const [name, text] of tests) {
      const tx = new sql.Transaction(pool);
      const denied = await runReadonlyProbe(tx, text);
      results.push({ check: name, denied });
      if (!denied) throw new Error('Runtime read-only enforcement failed');
    }
    const execute = (await pool.request().query("SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'EXECUTE') AS allowed;")).recordset[0].allowed;
    if (execute !== 0) throw new Error('Runtime execute denial failed');
    console.log(JSON.stringify({ event: 'readonly_acceptance_complete', actualBrokerIdentity: true, approvedViewSelect: true, executePermissionDenied: true, checks: results }));
  } finally { await pool.close(); }
}

acceptance().catch((error) => {
  console.error(JSON.stringify({ event: 'readonly_acceptance_failed', code: error.code ?? 'ACCEPTANCE_FAILED', sqlNumber: error.number }));
  process.exitCode = 1;
});
