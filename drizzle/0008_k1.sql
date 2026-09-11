-- 0008_k1: Schedule K-1 (Form 1065) ingestion (§4.5) and the outside-basis
-- roll-forward. Extraction confidence gates confirmation (guardrail 5);
-- posting happens only from confirmed K-1s; the basis equation is CHECKed by
-- the database on the APPLIED amounts (suspended losses and distributions in
-- excess of basis are carried in their own columns).

CREATE TYPE k1_status AS ENUM ('in_review','confirmed','posted');
CREATE TYPE k1_confidence AS ENUM ('high','low');

CREATE TABLE k1s (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  investee_id      integer NOT NULL REFERENCES investees(id),
  tax_year         smallint NOT NULL,
  document_id      bigint NOT NULL REFERENCES documents(id),   -- the source PDF (§4.11)
  status           k1_status NOT NULL DEFAULT 'in_review',
  extraction_model text,           -- Anthropic model id from config when API-extracted
  extracted_at     timestamptz,
  confirmed_at     timestamptz,
  journal_entry_id bigint REFERENCES journal_entries(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (investee_id, tax_year),
  CHECK ((status = 'posted') = (journal_entry_id IS NOT NULL)),
  CHECK (status = 'in_review' OR confirmed_at IS NOT NULL)
);

CREATE TABLE k1_fields (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  k1_id         bigint NOT NULL REFERENCES k1s(id),
  box_code      text NOT NULL,     -- '1','5','6a','9a','11A','13J','18A','19A','L.ending',...
  label         text,
  value_cents   cents,             -- money boxes
  value_text    text,              -- non-money (percentages, checkboxes)
  confidence    k1_confidence NOT NULL DEFAULT 'high',
  owner_touched boolean NOT NULL DEFAULT false,
  UNIQUE (k1_id, box_code)
);

CREATE TABLE basis_rollforwards (
  id                        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  investee_id               integer NOT NULL REFERENCES investees(id),
  tax_year                  smallint NOT NULL,
  beginning_basis           cents NOT NULL,
  contributions             cents NOT NULL DEFAULT 0,
  income_items              cents NOT NULL DEFAULT 0,
  tax_exempt_income         cents NOT NULL DEFAULT 0,
  distributions_applied     cents NOT NULL DEFAULT 0,   -- capped at available basis
  excess_distributions      cents NOT NULL DEFAULT 0,   -- gain to the owner; flagged
  nondeductibles_applied    cents NOT NULL DEFAULT 0,
  loss_deduction_items      cents NOT NULL DEFAULT 0,   -- ALLOWED this year
  suspended_losses          cents NOT NULL DEFAULT 0,   -- cumulative carryforward
  ending_basis              cents NOT NULL,
  reported_capital_account  cents,   -- K-1 item L as reported — never conflated with basis
  trace                     jsonb NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (investee_id, tax_year),
  CHECK (beginning_basis >= 0 AND ending_basis >= 0),
  CHECK (excess_distributions >= 0 AND suspended_losses >= 0),
  -- the roll-forward equation on applied amounts, enforced by the database
  CHECK (ending_basis = beginning_basis + contributions + income_items + tax_exempt_income
                        - distributions_applied - nondeductibles_applied - loss_deduction_items)
);
