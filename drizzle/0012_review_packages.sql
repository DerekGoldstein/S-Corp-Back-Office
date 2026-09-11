-- 0012_review_packages: the §4.11 CPA sign-off deliverable. Versions are
-- immutable once finalized; guardrail 8 lives in the CHECKs — 'final' only
-- with zero red tie-outs, 'final_with_open_items' only when every red item
-- carries an owner note (enforced in the service; the DB pins the shape).

CREATE TABLE review_packages (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_year        smallint NOT NULL,
  version         integer NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','final','final_with_open_items')),
  tie_outs        jsonb NOT NULL,   -- [{key,name,pass,detail,ownerNote?}]
  open_items      jsonb NOT NULL DEFAULT '[]',
  cover_document_id bigint REFERENCES documents(id),
  cpa_comments    text,
  signed_off_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_year, version)
);

CREATE FUNCTION review_packages_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'package % is finalized; create a new version', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft'
     AND (NEW.tie_outs, NEW.open_items, NEW.status, NEW.tax_year, NEW.version)
         IS DISTINCT FROM
         (OLD.tie_outs, OLD.open_items, OLD.status, OLD.tax_year, OLD.version) THEN
    RAISE EXCEPTION 'finalized package % is immutable (CPA comments/sign-off may still attach)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER review_packages_guarded
  BEFORE UPDATE OR DELETE ON review_packages
  FOR EACH ROW EXECUTE FUNCTION review_packages_guard();
