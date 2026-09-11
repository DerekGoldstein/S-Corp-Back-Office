-- 0009_calendar: compliance calendar (§5). Rules are data (seeded from
-- data/calendar/rules.json — never hardcoded dates in code); items are the
-- dated instances per calendar year, completed by filing-confirmation
-- documents from the vault.

CREATE TABLE calendar_rules (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  due               jsonb NOT NULL,      -- {type:'fixed'|'multi_fixed'|'anniversary_month'|'event', ...}
  channel           text,                -- 'EFTPS','NY Online Services','SSA BSO','e-file product','NY DOS',...
  amount_source     text,                -- 'payroll_deposit','ledger:2200','projection','manual',...
  condition_key     text,                -- app_config key gating applicability ('ptet_elected','solo401k_over_threshold')
  applies_from_year smallint,
  applies_to_year   smallint,
  notes             text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id       integer NOT NULL REFERENCES calendar_rules(id),
  calendar_year smallint NOT NULL,
  seq           smallint NOT NULL DEFAULT 1,
  label         text NOT NULL,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'upcoming'
                CHECK (status IN ('upcoming','done','na')),
  completed_at  timestamptz,
  document_id   bigint REFERENCES documents(id),   -- the filing confirmation (§4.10)
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, calendar_year, seq),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX calendar_items_due ON calendar_items (due_date) WHERE status = 'upcoming';
