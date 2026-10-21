IF SCHEMA_ID('synthetic') IS NULL EXEC('CREATE SCHEMA synthetic AUTHORIZATION dbo');
IF SCHEMA_ID('reporting') IS NULL EXEC('CREATE SCHEMA reporting AUTHORIZATION dbo');

IF OBJECT_ID('synthetic.fraud_losses', 'U') IS NULL
CREATE TABLE synthetic.fraud_losses (
  business_unit varchar(20) NOT NULL,
  period_start date NOT NULL,
  channel nvarchar(80) NOT NULL,
  merchant nvarchar(80) NOT NULL,
  province char(2) NOT NULL,
  loss_cad decimal(18,2) NOT NULL,
  cohort_count int NOT NULL CHECK (cohort_count >= 0),
  source_as_of datetime2(0) NOT NULL,
  CONSTRAINT PK_synthetic_fraud_losses PRIMARY KEY (business_unit, period_start, channel, merchant, province),
  CONSTRAINT CK_loss_month_start CHECK (DAY(period_start) = 1)
);

IF OBJECT_ID('synthetic.rule_outcomes', 'U') IS NULL
CREATE TABLE synthetic.rule_outcomes (
  business_unit varchar(20) NOT NULL,
  period_start date NOT NULL,
  rule_id varchar(10) NOT NULL,
  channel nvarchar(80) NOT NULL,
  merchant nvarchar(80) NOT NULL,
  province char(2) NOT NULL,
  adjudicated_count int NOT NULL CHECK (adjudicated_count >= 0),
  false_positive_count int NOT NULL,
  cohort_count int NOT NULL CHECK (cohort_count >= 0),
  source_as_of datetime2(0) NOT NULL,
  CONSTRAINT PK_synthetic_rule_outcomes PRIMARY KEY (business_unit, period_start, rule_id, channel, merchant, province),
  CONSTRAINT CK_rule_month_start CHECK (DAY(period_start) = 1),
  CONSTRAINT CK_rule_false_positive_count CHECK (false_positive_count >= 0 AND false_positive_count <= adjudicated_count)
);
