-- 0005_accountable_plan: written plan + reimbursement submissions (§4.8).
-- Built now (ahead of the Phase 2 UI) because guardrail 6 needs real teeth
-- from day one: no reimbursement posts without an approved submission and an
-- attached document.

CREATE TYPE reimbursement_category AS ENUM
  ('home_office','phone','internet','supplies','health_insurance','other');

CREATE TABLE accountable_plans (
  id                         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adopted_on                 date NOT NULL,
  document_id                bigint REFERENCES documents(id),  -- the signed policy
  substantiation_window_days integer NOT NULL DEFAULT 60,
  categories                 reimbursement_category[] NOT NULL,
  active                     boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reimbursement_submissions (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id                  integer NOT NULL REFERENCES accountable_plans(id),
  tax_year                 smallint NOT NULL,
  category                 reimbursement_category NOT NULL,
  amount                   cents NOT NULL CHECK (amount > 0),
  computation              jsonb,   -- home-office math, business-use %, etc.
  document_id              bigint NOT NULL REFERENCES documents(id),  -- guardrail 6
  submitted_on             date,
  approved_on              date,
  status                   text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','submitted','approved','posted','paid')),
  journal_entry_id         bigint REFERENCES journal_entries(id),
  paid_bank_transaction_id bigint REFERENCES bank_transactions(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','posted','paid') OR approved_on IS NOT NULL),
  CHECK (status NOT IN ('posted','paid') OR journal_entry_id IS NOT NULL),
  CHECK (status <> 'paid' OR paid_bank_transaction_id IS NOT NULL)
);

CREATE INDEX reimbursement_submissions_year ON reimbursement_submissions (tax_year);
