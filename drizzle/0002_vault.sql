-- 0002_vault: document vault (§4.10). Originals are content-addressed files on
-- disk (var/vault/<sha256>); rows here are the catalog. Links are polymorphic.

CREATE TYPE document_source AS ENUM ('upload','email_inbox','generated');

CREATE TABLE documents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename     text NOT NULL,
  mime         text NOT NULL,
  sha256       text NOT NULL UNIQUE,     -- content address; integrity check on read
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  source       document_source NOT NULL DEFAULT 'upload',
  year         smallint,                 -- vault export grouping
  retain_until date,                     -- filing date + 7y minimum, set when linked to a filing
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- Documents are immutable: no UPDATE of identity fields, no DELETE before
-- retain_until. (Retention pruning is a deliberate, audited maintenance task.)
CREATE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retain_until IS NULL OR OLD.retain_until > CURRENT_DATE THEN
      RAISE EXCEPTION 'document % is under retention; cannot delete', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.filename, NEW.mime, NEW.sha256, NEW.size_bytes, NEW.source, NEW.uploaded_at)
     IS DISTINCT FROM
     (OLD.filename, OLD.mime, OLD.sha256, OLD.size_bytes, OLD.source, OLD.uploaded_at) THEN
    RAISE EXCEPTION 'document % identity fields are immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER documents_guarded
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard();

CREATE TABLE document_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  linked_type text NOT NULL,   -- 'bank_transaction' | 'journal_entry' | 'k1' | 'payroll_run'
                               -- | 'reimbursement_submission' | 'corporate_record'
                               -- | 'calendar_item' | 'import_batch' | 'workpaper' | ...
  linked_id   text NOT NULL,   -- text so composite/foreign shapes fit one column
  linked_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, linked_type, linked_id)
);

CREATE INDEX document_links_target ON document_links (linked_type, linked_id);
