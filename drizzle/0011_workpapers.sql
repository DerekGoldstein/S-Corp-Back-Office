-- 0011_workpapers: stored workpaper versions (§4.6 / guardrail 12). Payload
-- carries the line values + traces; a workpaper cannot be final without the
-- reviewed-by sign-off, and final versions are immutable — changes create
-- the next version.

CREATE TABLE workpapers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,        -- 'f1120s','941_q4','940','w2','nys45','ct3s','gct_nyc4s','f7203','f4562',...
  tax_year    smallint NOT NULL,
  quarter     smallint,
  version     integer NOT NULL DEFAULT 1,
  payload     jsonb NOT NULL,
  tie_outs    jsonb,                -- named checks with pass/fail for the §4.11 package
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  reviewed_by text,                 -- owner/CPA sign-off (guardrail 12)
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tax_year, quarter, version),
  CHECK (status <> 'final' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE FUNCTION workpapers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'final' THEN
      RAISE EXCEPTION 'workpaper % is final; create a new version instead', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'workpaper % is final and immutable; create a new version', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workpapers_guarded
  BEFORE UPDATE OR DELETE ON workpapers
  FOR EACH ROW EXECUTE FUNCTION workpapers_guard();
