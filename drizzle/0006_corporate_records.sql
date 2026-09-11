-- 0006_corporate_records: §4.9 generated formalities. Each record is filled
-- from database data, exported as PDF, signed by the owner, and stored in
-- the vault. Standing documents (S-election letters, EIN letter, plan
-- adoption, insurance) are tracked as records with kind='standing' so gaps
-- can be flagged.

CREATE TYPE corporate_record_kind AS ENUM
  ('annual_consent','preyear_consent','accountable_plan_policy',
   'de_minimis_election','standing');

CREATE TABLE corporate_records (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          corporate_record_kind NOT NULL,
  standing_kind text,              -- 'cp261','ct6_approval','ein_letter','operating_agreement',
                                   -- 'plan_adoption','insurance_policy','ny_employer_registration'
  tax_year      smallint,
  title         text NOT NULL,
  data          jsonb,             -- snapshot of the database values the record was generated from
  document_id   bigint REFERENCES documents(id),   -- generated (later: signed) PDF
  status        text NOT NULL DEFAULT 'generated'
                CHECK (status IN ('generated','signed','missing')),
  signed_on     date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'standing' OR standing_kind IS NOT NULL),
  CHECK (status <> 'signed' OR signed_on IS NOT NULL)
);

CREATE INDEX corporate_records_year ON corporate_records (tax_year);
