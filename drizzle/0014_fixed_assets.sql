-- 0014_fixed_assets: the depreciation subledger (brief §7 "fixed-asset register
-- + Form 4562"). Assets are S-corp-era only (placed in service >= 2027-01-01;
-- anything older enters through manual opening balances with the CPA's
-- schedule). MACRS percentages are never stored — they are arithmetic,
-- computed by src/assets/macrs.ts; only the YEAR-SPECIFIC §179 limits and the
-- §168(k) bonus percentage come from the verified tax-table registry
-- (kind 'depreciation'), per guardrail 1.

CREATE TABLE fixed_assets (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  description       text NOT NULL,
  placed_in_service date NOT NULL CHECK (placed_in_service >= DATE '2027-01-01'),
  cost              cents NOT NULL CHECK (cost > 0),
  business_use_pct  text NOT NULL DEFAULT '100%',   -- exact-rational rate string
  method            text NOT NULL CHECK (method IN ('macrs_200db','macrs_150db','sl')),
  recovery_years    smallint NOT NULL CHECK (recovery_years IN (3,5,7,10,15,20)),
  section_179       cents NOT NULL DEFAULT 0 CHECK (section_179 >= 0),
  take_bonus        boolean NOT NULL DEFAULT false,
  -- fixed at the placement-year posting from that year's verified bonus_pct:
  bonus_applied     cents NOT NULL DEFAULT 0 CHECK (bonus_applied >= 0),
  -- fixed at first posting (cohort mid-quarter test result), never recomputed after:
  convention        text CHECK (convention IN ('half_year','mid_quarter')),
  document_id       bigint NOT NULL REFERENCES documents(id),  -- purchase invoice (guardrail 6)
  disposed_on       date,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (section_179 <= cost),
  CHECK (disposed_on IS NULL OR disposed_on >= placed_in_service)
);

-- Per-asset, per-year detail behind each annual Dr 5050 / Cr 1610 entry.
-- Rows whose journal entry was reversed stay as history; consumers exclude
-- them by checking for a reversing entry (same pattern as the ledger).
CREATE TABLE depreciation_postings (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id         bigint NOT NULL REFERENCES fixed_assets(id),
  tax_year         smallint NOT NULL,
  amount           cents NOT NULL CHECK (amount >= 0),
  detail           jsonb NOT NULL,
  journal_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX depreciation_postings_year_idx ON depreciation_postings (tax_year, asset_id);
