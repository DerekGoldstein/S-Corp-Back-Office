-- 0004_time_comp: time log, market-rate table, reasonable-compensation
-- computations with a freezable methodology (§4.3). The methodology must be
-- frozen before 1/1/2027; frozen methodologies are immutable.

CREATE TABLE task_types (
  id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE time_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date   date NOT NULL,
  hours        numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  task_type_id integer NOT NULL REFERENCES task_types(id),
  investee_id  integer REFERENCES investees(id),
  client       text,
  note         text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ics')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX time_entries_date ON time_entries (entry_date);

CREATE TABLE rate_sources (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_type_id    integer NOT NULL REFERENCES task_types(id),
  hourly_rate     cents NOT NULL CHECK (hourly_rate > 0),
  source_kind     text NOT NULL CHECK (source_kind IN ('job_posting','survey','other')),
  citation        text NOT NULL,   -- URL or description of the posting/survey
  conversion_note text,            -- e.g. "salary / 2080 (40h × 52w)"
  captured_on     date NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corroboration_metrics (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period      text NOT NULL,       -- '2027-Q1', '2027', ...
  metric      text NOT NULL,       -- 'deals_reviewed', 'volume_funded_cents', ...
  value       numeric(18,2) NOT NULL,
  source_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, metric)
);

CREATE TABLE comp_methodologies (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version     integer NOT NULL UNIQUE,
  description text NOT NULL,
  -- e.g. {"rate_aggregation":"median","include_catchup_hours":false}
  parameters  jsonb NOT NULL DEFAULT '{}',
  frozen      boolean NOT NULL DEFAULT false,
  frozen_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (frozen = (frozen_at IS NOT NULL))
);

-- A frozen methodology is immutable (except the freeze transition itself)
CREATE FUNCTION comp_methodology_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen THEN
      RAISE EXCEPTION 'methodology v% is frozen; create a new version', OLD.version;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.frozen THEN
    RAISE EXCEPTION 'methodology v% is frozen; create a new version', OLD.version;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER comp_methodologies_guarded
  BEFORE UPDATE OR DELETE ON comp_methodologies
  FOR EACH ROW EXECUTE FUNCTION comp_methodology_guard();

CREATE TABLE comp_computations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  methodology_id integer NOT NULL REFERENCES comp_methodologies(id),
  tax_year       smallint NOT NULL,
  total          cents NOT NULL,
  corroboration  jsonb,            -- metrics snapshot at computation time
  trace          jsonb NOT NULL,   -- inputs, per-type medians, rounding steps
  computed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comp_computation_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  computation_id  bigint NOT NULL REFERENCES comp_computations(id),
  task_type_id    integer NOT NULL REFERENCES task_types(id),
  hours           numeric(8,2) NOT NULL,
  rate            cents NOT NULL,
  amount          cents NOT NULL,
  rate_source_ids integer[] NOT NULL,
  UNIQUE (computation_id, task_type_id)
);
