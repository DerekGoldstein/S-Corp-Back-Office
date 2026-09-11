-- 0010_payroll: persisted pay runs (§4.4). Every figure the run computed is
-- stored with the table versions used and the full trace; the journal entry
-- and the deposit schedule hang off the run. Posted runs are immutable —
-- corrections reverse the entry and post a new run.

CREATE TABLE payroll_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_year           smallint NOT NULL,
  pay_date           date NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  gross_wages        cents NOT NULL,
  gross_source       text NOT NULL,   -- 'comp_computation:<id>' or 'override: <reason>'
  health_premium     cents NOT NULL DEFAULT 0,
  fit_wages          cents NOT NULL,
  nys_wages          cents NOT NULL,
  nyc_wages          cents NOT NULL,
  fica_wages         cents NOT NULL,
  futa_wages         cents NOT NULL,
  sui_wages          cents NOT NULL,
  ee_deferral_401k   cents NOT NULL,
  ee_social_security cents NOT NULL,
  ee_medicare        cents NOT NULL,
  ee_addl_medicare   cents NOT NULL,
  fit_withheld       cents NOT NULL,
  nys_withheld       cents NOT NULL,
  nyc_withheld       cents NOT NULL,
  er_social_security cents NOT NULL,
  er_medicare        cents NOT NULL,
  er_futa            cents NOT NULL,
  er_sui             cents NOT NULL,
  er_401k            cents NOT NULL,
  net_pay            cents NOT NULL,
  table_version_ids  jsonb NOT NULL,  -- {kind: version row id} — reproducibility
  trace              jsonb NOT NULL,
  warnings           jsonb,
  journal_entry_id   bigint REFERENCES journal_entries(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL)
);

CREATE TABLE payroll_deposits (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_run_id      bigint NOT NULL REFERENCES payroll_runs(id),
  authority           text NOT NULL CHECK (authority IN ('EFTPS','NYS-1','FUTA','NY-SUI')),
  amount              cents NOT NULL,
  due_date            date NOT NULL,
  rule                text NOT NULL,   -- which deposit rule fired, for the calendar/audit
  liability_accounts  text[] NOT NULL,
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','cleared')),
  bank_transaction_id bigint REFERENCES bank_transactions(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'cleared') = (bank_transaction_id IS NOT NULL))
);

CREATE INDEX payroll_deposits_due ON payroll_deposits (due_date) WHERE status = 'scheduled';
