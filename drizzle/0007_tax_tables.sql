-- 0007_tax_tables: per-year tax data files loaded as versioned rows
-- (guardrail 1: no rate, wage base, threshold, or due date in code).
-- Rows are insert-only; the ONLY permitted update is the owner-verification
-- flip. Payroll and workpapers refuse to run against anything unverified.

CREATE TABLE tax_table_versions (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_year          smallint NOT NULL CHECK (tax_year BETWEEN 2020 AND 2100),
  kind              text NOT NULL,      -- 'fica','pub15t','nys50t_nys','nys50t_nyc','futa',
                                        -- 'ny_sui','limits_401k','de_minimis','safe_harbor',
                                        -- 'gct','ct3s','ptet','holidays','k1_map',
                                        -- 'form_captions','tb_export_codes'
  source_url        text NOT NULL,
  effective_from    date,
  effective_to      date,
  payload           jsonb NOT NULL,
  sha256            text NOT NULL,      -- hash of the source file
  verified_by_owner boolean NOT NULL DEFAULT false,
  verified_at       timestamptz,
  loaded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_year, kind, sha256),
  CHECK (verified_by_owner = (verified_at IS NOT NULL))
);

CREATE INDEX tax_table_versions_lookup ON tax_table_versions (tax_year, kind, id);

-- Insert-only + the single allowed transition: unverified → verified.
CREATE FUNCTION tax_table_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.verified_by_owner THEN
      RAISE EXCEPTION 'tax table % (%/%) is owner-verified and immutable', OLD.id, OLD.tax_year, OLD.kind;
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.tax_year, NEW.kind, NEW.source_url, NEW.effective_from, NEW.effective_to,
      NEW.payload, NEW.sha256, NEW.loaded_at)
     IS DISTINCT FROM
     (OLD.tax_year, OLD.kind, OLD.source_url, OLD.effective_from, OLD.effective_to,
      OLD.payload, OLD.sha256, OLD.loaded_at) THEN
    RAISE EXCEPTION 'tax table rows are immutable; load a new file version instead (row %)', OLD.id;
  END IF;
  IF OLD.verified_by_owner AND NOT NEW.verified_by_owner THEN
    RAISE EXCEPTION 'verification cannot be revoked; load a new version to supersede row %', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tax_table_versions_guarded
  BEFORE UPDATE OR DELETE ON tax_table_versions
  FOR EACH ROW EXECUTE FUNCTION tax_table_guard();
