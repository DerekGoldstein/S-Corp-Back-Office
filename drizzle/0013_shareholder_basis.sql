-- 0013_shareholder_basis: Form 7203 stock-basis roll-forward (§4.6) — the
-- OWNER's basis in the S-corp, distinct from the entity's outside basis in
-- its investees (basis_rollforwards). Same DB-checked equation pattern.

CREATE TABLE shareholder_basis_years (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_year               smallint NOT NULL UNIQUE,
  beginning_basis        cents NOT NULL,
  contributions          cents NOT NULL DEFAULT 0,   -- paid-in capital during the year
  income_items           cents NOT NULL DEFAULT 0,   -- Schedule K income (K.18)
  tax_exempt_income      cents NOT NULL DEFAULT 0,   -- K.16a/16b
  distributions_applied  cents NOT NULL DEFAULT 0,   -- limited to available basis
  excess_distributions   cents NOT NULL DEFAULT 0,   -- capital gain to the owner
  nondeductibles_applied cents NOT NULL DEFAULT 0,   -- K.16c, limited
  losses_allowed         cents NOT NULL DEFAULT 0,
  suspended_losses       cents NOT NULL DEFAULT 0,   -- cumulative carryforward
  ending_basis           cents NOT NULL,
  trace                  jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (beginning_basis >= 0 AND ending_basis >= 0),
  CHECK (excess_distributions >= 0 AND suspended_losses >= 0),
  CHECK (ending_basis = beginning_basis + contributions + income_items + tax_exempt_income
                        - distributions_applied - nondeductibles_applied - losses_allowed)
);
