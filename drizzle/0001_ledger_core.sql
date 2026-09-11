-- 0001_ledger_core: enums, investees, accounts, periods, journal, audit.
-- Adapted from docs/proposal/03-ledger-invariants.sql (validated on PG16,
-- probe suite 29/29). The migration runner wraps each file in a transaction.

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
-- would terminate the investee's election. The enum has no such value; the
-- app layer translates the rejection into the explanatory error.
CREATE TYPE investee_type AS ENUM ('partnership','c_corporation');

CREATE TABLE investees (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  text NOT NULL,
  ein                   text,
  entity_type           investee_type NOT NULL,
  ownership_pct         numeric(7,4) NOT NULL CHECK (ownership_pct > 0 AND ownership_pct <= 100),
  acquired_on           date NOT NULL,
  initial_contribution  cents NOT NULL DEFAULT 0 CHECK (initial_contribution >= 0),
  counterparty_regex    text,   -- matches incoming-wire descriptions for §4.2 forcing
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code               text NOT NULL UNIQUE,
  name               text NOT NULL,
  type               account_type NOT NULL,
  tax_treatment      tax_treatment NOT NULL,
  m2_col             m2_column,          -- close destination; income/expense only
  form_1120s_line    text,               -- semantic code (p1.7, L.18, ...)
  schedule_k_line    text,               -- semantic code (K.4, K.16d, ...)
  requires_document  boolean NOT NULL DEFAULT false,   -- §4.10 posting guard
  document_threshold cents,              -- doc required only at/above this |amount|; NULL = always
  investee_id        integer REFERENCES investees(id), -- per-investee 15xx/45xx
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (m2_col IS NULL OR type IN ('revenue','expense')),
  CHECK (document_threshold IS NULL OR requires_document)
);

CREATE TABLE periods (
  tax_year  smallint NOT NULL CHECK (tax_year BETWEEN 2020 AND 2100),
  month     smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  locked    boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  PRIMARY KEY (tax_year, month),
  CHECK (locked = (locked_at IS NOT NULL))
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL DEFAULT current_user,
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text NOT NULL,
  detail      jsonb
);

CREATE TABLE journal_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date        date NOT NULL,
  memo              text NOT NULL CHECK (length(memo) > 0),
  source_module     source_module NOT NULL,
  source_id         bigint,
  reverses_entry_id bigint REFERENCES journal_entries(id),
  posted_at         timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL DEFAULT current_user,
  CHECK ((source_module = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CHECK (source_module IN ('manual','close','reversal') OR source_id IS NOT NULL)
);

CREATE UNIQUE INDEX journal_entries_reversed_once
  ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX journal_entries_date ON journal_entries (entry_date);

CREATE TABLE journal_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id            bigint NOT NULL REFERENCES journal_entries(id),
  line_no             smallint NOT NULL,
  account_id          integer NOT NULL REFERENCES accounts(id),
  debit               cents NOT NULL DEFAULT 0,
  credit              cents NOT NULL DEFAULT 0,
  memo                text,
  investee_id         integer REFERENCES investees(id),
  payroll_run_id      bigint,
  k1_id               bigint,
  bank_transaction_id bigint,
  tax_year            smallint,
  UNIQUE (entry_id, line_no),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX journal_lines_account  ON journal_lines (account_id);
CREATE INDEX journal_lines_entry    ON journal_lines (entry_id);
CREATE INDEX journal_lines_investee ON journal_lines (investee_id) WHERE investee_id IS NOT NULL;
CREATE INDEX journal_lines_payroll  ON journal_lines (payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX journal_lines_k1       ON journal_lines (k1_id) WHERE k1_id IS NOT NULL;
CREATE INDEX journal_lines_bank_txn ON journal_lines (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

-- I1/I2: balanced with >= 2 lines, checked at COMMIT
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id bigint;
  v_debits   bigint;
  v_credits  bigint;
  v_lines    integer;
BEGIN
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

CREATE CONSTRAINT TRIGGER entry_balanced_on_lines
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE CONSTRAINT TRIGGER entry_balanced_on_header
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- I4: append-only
CREATE FUNCTION journal_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'journal is append-only (% on %): corrections are reversing entries',
    TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

-- I6: locked periods reject inserts; unknown periods auto-create open
CREATE FUNCTION assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year   smallint := EXTRACT(YEAR  FROM NEW.entry_date)::smallint;
  v_month  smallint := EXTRACT(MONTH FROM NEW.entry_date)::smallint;
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

-- I9: per-investee accounts require the matching dimension
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

-- I11: accounts with posted lines keep their identity
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

-- I5: reversals only through this function
CREATE FUNCTION post_reversal(p_entry_id bigint, p_date date, p_memo text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_new_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry_id) THEN
    RAISE EXCEPTION 'entry % does not exist', p_entry_id;
  END IF;

  INSERT INTO journal_entries (entry_date, memo, source_module, reverses_entry_id)
  VALUES (p_date, p_memo, 'reversal', p_entry_id)
  RETURNING id INTO v_new_id;

  INSERT INTO journal_lines
    (entry_id, line_no, account_id, debit, credit, memo,
     investee_id, payroll_run_id, k1_id, bank_transaction_id, tax_year)
  SELECT v_new_id, line_no, account_id,
         credit, debit,
         'reversal of entry ' || p_entry_id,
         investee_id, payroll_run_id, k1_id, bank_transaction_id, tax_year
    FROM journal_lines WHERE entry_id = p_entry_id;

  RETURN v_new_id;
END $$;

-- I13: baseline audit row per posted entry
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

-- Owner-facing configuration (values encrypted at rest where flagged)
CREATE TABLE app_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  encrypted  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
