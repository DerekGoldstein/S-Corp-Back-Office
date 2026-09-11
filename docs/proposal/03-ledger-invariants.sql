-- =============================================================================
-- 03-ledger-invariants.sql  (PROPOSAL — reviewed DDL, not yet a migration)
--
-- The ledger invariants from PROJECT_BRIEF.md §2/§4.1, expressed as Postgres
-- constraints and triggers so the DATABASE — not the app — is what refuses a
-- bad entry. Implements I1–I13 from docs/proposal/01-data-model.md §6, plus
-- the §4.2 bank-transaction rules that are database-enforceable.
--
-- On approval this file becomes the first Drizzle migrations (split into
-- schema + trigger migrations); the property tests in brief §6 fire random
-- entries at these constraints and assert the DB rejects every invalid one.
--
-- VALIDATED: loads cleanly on Postgres 16, and the companion probe suite
-- (03-ledger-invariants.probe.sh) passes 29/29 — every invalid case below is
-- rejected by the database, every valid case commits.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Money: integer cents everywhere. No floating point can enter the schema.
-- ---------------------------------------------------------------------------
CREATE DOMAIN cents AS bigint;

CREATE TYPE account_type AS ENUM
  ('asset','contra_asset','liability','equity','contra_equity','revenue','expense');

CREATE TYPE tax_treatment AS ENUM
  ('taxable_ordinary','separately_stated','deductible','deductible_50pct',
   'nondeductible','tax_exempt','not_tax');

CREATE TYPE m2_column AS ENUM ('aaa','oaa');

CREATE TYPE source_module AS ENUM
  ('manual','bank','payroll','k1','reimbursement','fixed_asset','tax_accrual',
   'close','reversal');

-- §4.5: an S-corporation investee is a hard error — this LLC's S election
-- would be terminated by holding S-corp stock. The enum simply has no such
-- value; the app layer translates the rejection into the explanatory error.
CREATE TYPE investee_type AS ENUM ('partnership','c_corporation');

CREATE TYPE bank_source AS ENUM ('csv','ofx','plaid');
CREATE TYPE txn_status  AS ENUM ('unreviewed','proposed','posted','transfer','flagged');
-- §4.2: every outgoing payment to the owner must carry exactly one of these.
CREATE TYPE owner_payment_tag AS ENUM ('payroll_net_pay','distribution','reimbursement');

-- ---------------------------------------------------------------------------
-- Investees (minimal columns needed by ledger FKs; full table in module DDL)
-- ---------------------------------------------------------------------------
CREATE TABLE investees (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  text NOT NULL,
  ein                   text,
  entity_type           investee_type NOT NULL,
  ownership_pct         numeric(7,4) NOT NULL CHECK (ownership_pct > 0 AND ownership_pct <= 100),
  acquired_on           date NOT NULL,
  initial_contribution  cents NOT NULL DEFAULT 0 CHECK (initial_contribution >= 0),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  type              account_type NOT NULL,
  tax_treatment     tax_treatment NOT NULL,
  m2_col            m2_column,           -- close destination; income/expense only
  form_1120s_line   text,                -- semantic code (p1.7, L.18, ...);
  schedule_k_line   text,                -- per-year captions file resolves these
  requires_document boolean NOT NULL DEFAULT false,   -- §4.10 posting guard
  investee_id       integer REFERENCES investees(id), -- per-investee 15xx/45xx
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (m2_col IS NULL OR type IN ('revenue','expense'))
);

-- ---------------------------------------------------------------------------
-- Periods: monthly, lockable. Locked periods reject new entries (I6).
-- ---------------------------------------------------------------------------
CREATE TABLE periods (
  tax_year  smallint NOT NULL CHECK (tax_year BETWEEN 2020 AND 2100),
  month     smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  locked    boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  PRIMARY KEY (tax_year, month),
  CHECK (locked = (locked_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date        date NOT NULL,
  memo              text NOT NULL CHECK (length(memo) > 0),
  source_module     source_module NOT NULL,
  source_id         bigint,
  reverses_entry_id bigint REFERENCES journal_entries(id),
  posted_at         timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL DEFAULT current_user,
  -- I10: reversal ⇔ reference set; non-manual entries name their source row
  CHECK ((source_module = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CHECK (source_module IN ('manual','close','reversal') OR source_id IS NOT NULL)
);

-- I5: an entry can be reversed at most once
CREATE UNIQUE INDEX journal_entries_reversed_once
  ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE journal_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id            bigint NOT NULL REFERENCES journal_entries(id),
  line_no             smallint NOT NULL,
  account_id          integer NOT NULL REFERENCES accounts(id),
  debit               cents NOT NULL DEFAULT 0,
  credit              cents NOT NULL DEFAULT 0,
  memo                text,
  -- §4.1 dimensions (nullable; FKs to module tables added in their migrations)
  investee_id         integer REFERENCES investees(id),
  payroll_run_id      bigint,
  k1_id               bigint,
  bank_transaction_id bigint,
  tax_year            smallint,
  UNIQUE (entry_id, line_no),
  -- I3: non-negative, exactly one positive side per line
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX journal_lines_account   ON journal_lines (account_id);
CREATE INDEX journal_lines_investee  ON journal_lines (investee_id) WHERE investee_id IS NOT NULL;
CREATE INDEX journal_lines_payroll   ON journal_lines (payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX journal_lines_k1        ON journal_lines (k1_id) WHERE k1_id IS NOT NULL;
CREATE INDEX journal_lines_bank_txn  ON journal_lines (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- I1/I2: balanced, ≥2 lines — checked at COMMIT so multi-row inserts work
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id bigint;
  v_debits   bigint;
  v_credits  bigint;
  v_lines    integer;
BEGIN
  -- fires on both tables; NEW has different shapes
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry_id := NEW.id;
  ELSE
    v_entry_id := NEW.entry_id;
  END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*)
    INTO v_debits, v_credits, v_lines
    FROM journal_lines WHERE entry_id = v_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'entry % must have at least two lines (has %)', v_entry_id, v_lines;
  END IF;
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'entry % is unbalanced: debits % <> credits % (cents)',
      v_entry_id, v_debits, v_credits;
  END IF;
  RETURN NULL;
END $$;

-- fires per inserted line…
CREATE CONSTRAINT TRIGGER entry_balanced_on_lines
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- …and per inserted entry, so a header with zero lines cannot slip through
CREATE CONSTRAINT TRIGGER entry_balanced_on_header
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- I4: append-only. UPDATE/DELETE raise; the app role also gets REVOKEd.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'journal is append-only (% on %): post a reversing entry instead',
    TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

-- Belt and suspenders once the app role exists:
--   REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_lines FROM app_rw;

-- ---------------------------------------------------------------------------
-- I6: no entries dated inside a locked period. Missing periods are created
-- open so historical imports don't require pre-registration.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year  smallint := EXTRACT(YEAR  FROM NEW.entry_date)::smallint;
  v_month smallint := EXTRACT(MONTH FROM NEW.entry_date)::smallint;
  v_locked boolean;
BEGIN
  INSERT INTO periods (tax_year, month) VALUES (v_year, v_month)
    ON CONFLICT (tax_year, month) DO NOTHING;
  SELECT locked INTO v_locked FROM periods
    WHERE tax_year = v_year AND month = v_month;
  IF v_locked THEN
    RAISE EXCEPTION
      'period %-% is locked; date the correcting entry in an open period',
      v_year, v_month;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- Unlocking is deliberately awkward: only via this function, which audit-logs.
CREATE FUNCTION unlock_period(p_year smallint, p_month smallint, p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_reason IS NULL OR length(p_reason) = 0 THEN
    RAISE EXCEPTION 'unlocking a period requires a reason';
  END IF;
  UPDATE periods SET locked = false, locked_at = NULL
    WHERE tax_year = p_year AND month = p_month;
  INSERT INTO audit_log (actor, action, object_type, object_id, detail)
  VALUES (current_user, 'unlock_period', 'period',
          p_year::text || '-' || p_month::text, jsonb_build_object('reason', p_reason));
END $$;

-- ---------------------------------------------------------------------------
-- I9: lines on per-investee accounts must carry the matching dimension
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_line_dimensions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_acct_investee integer;
BEGIN
  SELECT investee_id INTO v_acct_investee FROM accounts WHERE id = NEW.account_id;
  IF v_acct_investee IS NOT NULL
     AND NEW.investee_id IS DISTINCT FROM v_acct_investee THEN
    RAISE EXCEPTION
      'account % belongs to investee %; line must carry that investee_id dimension',
      NEW.account_id, v_acct_investee;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_dimensions
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_dimensions();

-- ---------------------------------------------------------------------------
-- I11: accounts with posted lines keep their identity. Deactivate, never
-- delete; mapping changes are new-year data-file events, not row edits.
-- ---------------------------------------------------------------------------
CREATE FUNCTION protect_posted_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.code, NEW.type, NEW.tax_treatment, NEW.m2_col, NEW.investee_id)
     IS DISTINCT FROM
     (OLD.code, OLD.type, OLD.tax_treatment, OLD.m2_col, OLD.investee_id)
     AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION
      'account % has posted lines; open a new account or a new-year mapping instead',
      OLD.code;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_protect_posted
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION protect_posted_accounts();

-- ---------------------------------------------------------------------------
-- I5: reversals only through this function — mirrored lines, same dimensions,
-- dated in an open period (the period trigger enforces that on insert).
-- ---------------------------------------------------------------------------
CREATE FUNCTION post_reversal(p_entry_id bigint, p_date date, p_memo text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_new_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry_id) THEN
    RAISE EXCEPTION 'entry % does not exist', p_entry_id;
  END IF;

  INSERT INTO journal_entries (entry_date, memo, source_module, reverses_entry_id)
  VALUES (p_date, p_memo, 'reversal', p_entry_id)   -- unique index rejects a 2nd reversal
  RETURNING id INTO v_new_id;

  INSERT INTO journal_lines
    (entry_id, line_no, account_id, debit, credit, memo,
     investee_id, payroll_run_id, k1_id, bank_transaction_id, tax_year)
  SELECT v_new_id, line_no, account_id,
         credit, debit,                              -- sides swapped
         'reversal of entry ' || p_entry_id,
         investee_id, payroll_run_id, k1_id, bank_transaction_id, tax_year
    FROM journal_lines WHERE entry_id = p_entry_id;

  RETURN v_new_id;
END $$;

-- ---------------------------------------------------------------------------
-- I13: baseline audit row per posted entry (app writes richer context)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL DEFAULT current_user,
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text NOT NULL,
  detail      jsonb
);

CREATE FUNCTION audit_journal_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (action, object_type, object_id, detail)
  VALUES ('post', 'journal_entry', NEW.id::text,
          jsonb_build_object('date', NEW.entry_date, 'source', NEW.source_module,
                             'source_id', NEW.source_id, 'memo', NEW.memo));
  RETURN NULL;
END $$;

CREATE TRIGGER journal_entries_audited
  AFTER INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION audit_journal_entry();

-- audit_log is append-only too
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

-- ===========================================================================
-- Bank ingestion (§4.2): the database-enforceable rules
-- ===========================================================================
CREATE TABLE bank_accounts (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  ledger_account_id integer NOT NULL REFERENCES accounts(id),  -- 1000/1010
  institution       text,
  mask              text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE classification_rules (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  description_regex text NOT NULL,
  amount_min        cents,
  amount_max        cents,
  bank_account_id   integer REFERENCES bank_accounts(id),      -- null = any
  target_account_id integer NOT NULL REFERENCES accounts(id),
  memo_template     text,
  investee_id       integer REFERENCES investees(id),
  owner_payment_tag owner_payment_tag,
  auto_post         boolean NOT NULL DEFAULT false,  -- §8: owner-flagged only
  priority          integer NOT NULL DEFAULT 100,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max)
);

CREATE TABLE bank_transactions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id   integer NOT NULL REFERENCES bank_accounts(id),
  source            bank_source NOT NULL,
  external_id       text,          -- Plaid transaction_id
  import_hash       text,          -- sha256(account|date|amount|norm_desc) for files
  txn_date          date NOT NULL,          -- raw ┐
  amount            cents NOT NULL,         --     │ frozen by trigger below
  description_raw   text NOT NULL,          --     │ (+ = inflow, − = outflow)
  description_norm  text NOT NULL,          --     │
  imported_at       timestamptz NOT NULL DEFAULT now(),  -- ┘
  -- workflow state (mutable)
  status            txn_status NOT NULL DEFAULT 'unreviewed',
  matched_rule_id   integer REFERENCES classification_rules(id),
  is_owner_payee    boolean NOT NULL DEFAULT false,
  owner_payment_tag owner_payment_tag,
  journal_entry_id  bigint REFERENCES journal_entries(id),
  transfer_peer_id  bigint REFERENCES bank_transactions(id),
  reconciliation_id integer,       -- FK added with reconciliations table
  flag_note         text,          -- 'flagged' = commingling error to fix at the bank
  CHECK (source <> 'plaid' OR external_id IS NOT NULL),
  CHECK (source =  'plaid' OR import_hash IS NOT NULL),
  -- I7: entry linked ⇔ posted or transfer (a transfer pair shares one entry)
  CHECK ((journal_entry_id IS NOT NULL) = (status IN ('posted', 'transfer'))),
  CHECK ((status = 'transfer') = (transfer_peer_id IS NOT NULL)),
  CHECK (status <> 'flagged' OR flag_note IS NOT NULL),
  -- I8 (§4.2/§8): an outflow to the owner never posts untagged
  CHECK (NOT (status = 'posted' AND is_owner_payee AND amount < 0)
         OR owner_payment_tag IS NOT NULL)
);

-- Dedupe (§4.2): by Plaid id, or by import hash, per account
CREATE UNIQUE INDEX bank_txn_dedupe_plaid
  ON bank_transactions (bank_account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX bank_txn_dedupe_import
  ON bank_transactions (bank_account_id, import_hash) WHERE import_hash IS NOT NULL;
-- I7: one journal entry per posted transaction (transfer pairs share theirs)
CREATE UNIQUE INDEX bank_txn_entry_unique
  ON bank_transactions (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL AND status = 'posted';

-- I12: raw import fields are immutable; only workflow columns may change
CREATE FUNCTION bank_raw_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.bank_account_id, NEW.source, NEW.external_id, NEW.import_hash,
      NEW.txn_date, NEW.amount, NEW.description_raw, NEW.description_norm,
      NEW.imported_at)
     IS DISTINCT FROM
     (OLD.bank_account_id, OLD.source, OLD.external_id, OLD.import_hash,
      OLD.txn_date, OLD.amount, OLD.description_raw, OLD.description_norm,
      OLD.imported_at) THEN
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

COMMIT;

-- =============================================================================
-- Enforced in the posting SERVICE (single code path), asserted by tests —
-- rules that need vault/module context the DDL above doesn't have:
--   * requires_document accounts refuse to post without an attachment (§4.10)
--   * bank classification cannot target 4500/45xx (K-1 income only), and
--     investee-counterparty inflows are forced to credit 15xx (§4.2)
--   * EFTPS / NYS Online Services / SUI / 401(k)-provider debits must clear
--     the specific 21xx liability, never an expense (§4.2)
--   * auto_post rules run the same guard pipeline as manual confirmation (§8)
--   * payroll refuses to run when any required tax_table_version for the year
--     is missing or not verified_by_owner (§4.4)
--   * K-1 confirmation is blocked while any low-confidence field is untouched
--     (§4.5), and reimbursements require an approved submission + document (§4.8)
-- =============================================================================
