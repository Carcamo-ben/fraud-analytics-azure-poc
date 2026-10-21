import { readFile } from 'node:fs/promises';
import { sql, connectManagedSql, brokerPrincipal } from './sql-common.mjs';
import { buildFixtures, SOURCE_AS_OF } from './fixtures.mjs';

async function seed() {
  const principal = brokerPrincipal();
  if (process.env.SOURCE_AS_OF !== SOURCE_AS_OF) throw new Error('SOURCE_AS_OF must match the versioned fixture');
  const pool = await connectManagedSql();
  const tx = new sql.Transaction(pool);
  let active = false;
  tx.on('rollback', () => { active = false; });
  try {
    await tx.begin();
    active = true;
    await tx.request().batch(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await tx.request().batch(`CREATE OR ALTER VIEW reporting.v_fraud_losses WITH SCHEMABINDING AS
      SELECT business_unit, period_start, channel, merchant, province, loss_cad, cohort_count, source_as_of
      FROM synthetic.fraud_losses WHERE business_unit = 'poc';`);
    await tx.request().batch(`CREATE OR ALTER VIEW reporting.v_rule_outcomes WITH SCHEMABINDING AS
      SELECT business_unit, period_start, rule_id, channel, merchant, province, adjudicated_count, false_positive_count, cohort_count, source_as_of
      FROM synthetic.rule_outcomes WHERE business_unit = 'poc';`);
    await tx.request().batch('CREATE OR ALTER PROCEDURE synthetic.readonly_probe AS SELECT CAST(1 AS int) AS probe;');
    await tx.request().query("DELETE FROM synthetic.fraud_losses WHERE business_unit = 'poc'; DELETE FROM synthetic.rule_outcomes WHERE business_unit = 'poc';");
    const fixture = buildFixtures();
    for (const kind of ['losses', 'rules']) {
      const rule = kind === 'rules';
      const table = new sql.Table(rule ? 'synthetic.rule_outcomes' : 'synthetic.fraud_losses');
      table.create = false;
      table.columns.add('business_unit', sql.VarChar(20), { nullable: false });
      table.columns.add('period_start', sql.Date, { nullable: false });
      if (rule) table.columns.add('rule_id', sql.VarChar(10), { nullable: false });
      table.columns.add('channel', sql.NVarChar(80), { nullable: false });
      table.columns.add('merchant', sql.NVarChar(80), { nullable: false });
      table.columns.add('province', sql.Char(2), { nullable: false });
      if (rule) {
        table.columns.add('adjudicated_count', sql.Int, { nullable: false });
        table.columns.add('false_positive_count', sql.Int, { nullable: false });
      } else table.columns.add('loss_cad', sql.Decimal(18, 2), { nullable: false });
      table.columns.add('cohort_count', sql.Int, { nullable: false });
      table.columns.add('source_as_of', sql.DateTime2(0), { nullable: false });
      for (const row of fixture[kind]) table.rows.add(
        'poc', new Date(`${row.periodStart}T00:00:00Z`), ...(rule ? [row.ruleId] : []),
        row.channel, row.merchant, row.province,
        ...(rule ? [row.adjudicatedCount, row.falsePositiveCount] : [row.lossCad]),
        row.cohortCount, new Date(SOURCE_AS_OF),
      );
      await tx.request().bulk(table);
    }
    // Azure SQL Database supports SID + TYPE=E without resolving the name in Entra.
    // Service principal SIDs use the client ID, not the Entra object ID.
    await tx.request().batch(`
      IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE member_principal_id = USER_ID('${principal.name}'))
        THROW 51000, 'Broker must not have database role memberships', 1;
      IF EXISTS (
        SELECT 1 FROM sys.database_permissions
        WHERE grantee_principal_id = USER_ID('${principal.name}') AND state IN ('G', 'W')
          AND NOT (
            (class = 0 AND permission_name = 'CONNECT' AND state = 'G') OR
            (class = 1 AND minor_id = 0 AND permission_name = 'SELECT' AND state = 'G'
              AND major_id IN (OBJECT_ID('reporting.v_fraud_losses'), OBJECT_ID('reporting.v_rule_outcomes')))
          )
      ) THROW 51000, 'Broker has unexpected direct grants', 1;
      IF EXISTS (SELECT 1 FROM sys.schemas WHERE principal_id = USER_ID('${principal.name}'))
        OR EXISTS (SELECT 1 FROM sys.objects WHERE principal_id = USER_ID('${principal.name}'))
        THROW 51000, 'Broker must not own schemas or objects', 1;
      ${principal.legacySid && principal.legacySid !== principal.sid ? `
      IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${principal.name}' AND sid = ${principal.legacySid} AND type = 'E')
        DROP USER [${principal.name}];` : ''}
      IF USER_ID('${principal.name}') IS NULL
        CREATE USER [${principal.name}] WITH SID = ${principal.sid}, TYPE = E;
      IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${principal.name}' AND sid = ${principal.sid} AND type = 'E')
        THROW 51000, 'Broker identity mismatch', 1;
      GRANT CONNECT TO [${principal.name}];
      GRANT SELECT ON OBJECT::reporting.v_fraud_losses TO [${principal.name}];
      GRANT SELECT ON OBJECT::reporting.v_rule_outcomes TO [${principal.name}];
      DENY SELECT ON SCHEMA::synthetic TO [${principal.name}];
      DENY INSERT, UPDATE, DELETE, EXECUTE TO [${principal.name}];
      DENY CREATE TABLE, CREATE VIEW, CREATE PROCEDURE, CREATE FUNCTION, CREATE SCHEMA, ALTER ANY USER, ALTER ANY ROLE TO [${principal.name}];
      DENY ALTER, TAKE OWNERSHIP ON SCHEMA::synthetic TO [${principal.name}];
      DENY ALTER, TAKE OWNERSHIP ON SCHEMA::reporting TO [${principal.name}];
    `);
    await tx.commit();
    active = false;
    console.log(JSON.stringify({ event: 'sql_seed_complete', synthetic: true, lossRows: fixture.losses.length, ruleRows: fixture.rules.length, sourceAsOf: SOURCE_AS_OF, readonlyAcceptance: 'not-run-by-seed' }));
  } finally {
    if (active) await tx.rollback();
    await pool.close();
  }
}

seed().catch((error) => {
  console.error(JSON.stringify({
    event: 'sql_seed_failed', code: error.code ?? 'SEED_FAILED', sqlNumber: error.number,
    preceding: (error.precedingErrors ?? []).map(({ number, lineNumber }) => ({ number, lineNumber })),
  }));
  process.exitCode = 1;
});
