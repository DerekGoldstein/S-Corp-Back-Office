-- 0003_banking: bank accounts, immutable raw transactions, classification
-- rules, import batches (lineage to vault), reconciliations, rule suggestions.
-- Adapted from the validated proposal DDL.

CREATE TYPE bank_source AS ENUM ('csv','ofx','plaid');
CREATE TYPE txn_status  AS ENUM ('unreviewed','proposed','posted','transfer','flagged');
CREATE TYPE owner_payment_tag AS ENUM ('payroll_net_pay','distribution','reimbursement');

CREATE TABLE bank_accounts (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  ledger_account_id integer NOT NULL REFERENCES accounts(id),   -- 1000/1010
  institution       text,
  mask              text,
  import_profile    jsonb,   -- CSV column mapping / sign convention / date format
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_batches (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id),
  source          bank_source NOT NULL,
  document_id     bigint REFERENCES documents(id),   -- the uploaded file, vaulted
  filename        text,
  row_count       integer NOT NULL DEFAULT 0,
  new_count       integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  warning_count   integer NOT NULL DEFAULT 0,
  warnings        jsonb,
  imported_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE classification_rules (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  description_regex text NOT NULL,
  amount_min        cents,
  amount_max        cents,
  bank_account_id   integer REFERENCES bank_accounts(id),        -- null = any
  target_account_id integer NOT NULL REFERENCES accounts(id),
  memo_template     text,
  investee_id       integer REFERENCES investees(id),
  owner_payment_tag owner_payment_tag,
  auto_post         boolean NOT NULL DEFAULT false,   -- §8: owner-flagged only
  priority          integer NOT NULL DEFAULT 100,
  active            boolean NOT NULL DEFAULT true,
  times_applied     integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max)
);

CREATE TABLE reconciliations (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id   integer NOT NULL REFERENCES bank_accounts(id),
  statement_date    date NOT NULL,            -- month-end being reconciled
  statement_balance cents NOT NULL,
  ledger_balance    cents,                    -- snapshot at completion
  difference        cents,                    -- snapshot at completion
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  snapshot          jsonb,                    -- itemized open items at completion
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, statement_date),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE bank_transactions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id   integer NOT NULL REFERENCES bank_accounts(id),
  source            bank_source NOT NULL,
  external_id       text,            -- Plaid transaction_id
  import_hash       text,            -- sha256(account|date|amount|norm_desc_v1) for files
  import_batch_id   bigint REFERENCES import_batches(id),
  txn_date          date NOT NULL,           -- raw ┐
  amount            cents NOT NULL,          --     │ frozen by trigger
  description_raw   text NOT NULL,           --     │ (+ = inflow, − = outflow)
  description_norm  text NOT NULL,           --     │
  imported_at       timestamptz NOT NULL DEFAULT now(),  -- ┘
  -- workflow state (mutable)
  status            txn_status NOT NULL DEFAULT 'unreviewed',
  matched_rule_id   integer REFERENCES classification_rules(id),
  proposal          jsonb,           -- rule-suggested target/memo/dims awaiting confirm
  is_owner_payee    boolean NOT NULL DEFAULT false,
  owner_payment_tag owner_payment_tag,
  journal_entry_id  bigint REFERENCES journal_entries(id),
  transfer_peer_id  bigint REFERENCES bank_transactions(id),
  reconciliation_id integer REFERENCES reconciliations(id),
  flag_note         text,            -- 'flagged' = commingling error to fix at the bank
  CHECK (source <> 'plaid' OR external_id IS NOT NULL),
  CHECK (source =  'plaid' OR import_hash IS NOT NULL),
  CHECK ((journal_entry_id IS NOT NULL) = (status IN ('posted','transfer'))),
  CHECK ((status = 'transfer') = (transfer_peer_id IS NOT NULL)),
  CHECK (status <> 'flagged' OR flag_note IS NOT NULL),
  -- §4.2/§8: an outflow to the owner never posts untagged
  CHECK (NOT (status = 'posted' AND is_owner_payee AND amount < 0)
         OR owner_payment_tag IS NOT NULL)
);

CREATE UNIQUE INDEX bank_txn_dedupe_plaid
  ON bank_transactions (bank_account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX bank_txn_dedupe_import
  ON bank_transactions (bank_account_id, import_hash) WHERE import_hash IS NOT NULL;
CREATE UNIQUE INDEX bank_txn_entry_unique
  ON bank_transactions (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL AND status = 'posted';
CREATE INDEX bank_txn_status ON bank_transactions (status) WHERE status IN ('unreviewed','proposed');
CREATE INDEX bank_txn_account_date ON bank_transactions (bank_account_id, txn_date);

-- I12: raw import fields immutable; workflow columns mutable
CREATE FUNCTION bank_raw_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.bank_account_id, NEW.source, NEW.external_id, NEW.import_hash,
      NEW.import_batch_id, NEW.txn_date, NEW.amount, NEW.description_raw,
      NEW.description_norm, NEW.imported_at)
     IS DISTINCT FROM
     (OLD.bank_account_id, OLD.source, OLD.external_id, OLD.import_hash,
      OLD.import_batch_id, OLD.txn_date, OLD.amount, OLD.description_raw,
      OLD.description_norm, OLD.imported_at) THEN
    RAISE EXCEPTION 'bank_transactions raw fields are immutable (txn %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bank_txn_raw_frozen
  BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_raw_is_immutable();

CREATE TRIGGER bank_txn_no_delete
  BEFORE DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

-- Suggested rules after repeated similar manual classifications (§4.2)
CREATE TABLE rule_suggestions (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id   integer REFERENCES bank_accounts(id),
  description_regex text NOT NULL,
  amount_min        cents,
  amount_max        cents,
  target_account_id integer NOT NULL REFERENCES accounts(id),
  owner_payment_tag owner_payment_tag,
  sample_txn_ids    bigint[] NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','dismissed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, description_regex, target_account_id)
);
