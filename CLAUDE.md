# CLAUDE.md — standing rules for this repo

Single-owner back office for a NYC single-member LLC, S election effective 1/1/2027. Cash-basis
books. The authoritative spec is `PROJECT_BRIEF.md`; the approved design is `docs/proposal/`.
The general ledger is the single source of truth: every module posts to it or reads from it,
and no module keeps parallel totals.

## Guardrails (brief §8 — never violate; a task that requires violating one is refused)

1. **No tax rate, wage base, threshold, or due date is ever hardcoded.** All live in per-year
   data files (`data/tax-tables/<year>/`) with source URLs and an owner-verified flag. Payroll
   and workpapers refuse to run for a year whose tables aren't loaded and `verified_by_owner`.
2. **No bank transaction posts without owner confirmation** or an owner-flagged `auto_post`
   rule — and auto-post runs the exact same guard pipeline.
3. **Investee wires are never revenue** (they credit the 15xx investment asset; income comes
   only from confirmed K-1s). **Payments to the owner never post untagged**
   (`payroll_net_pay` | `distribution` | `reimbursement`).
4. **No official form is rendered, generated, or filed by this app.** Workpapers only, with
   line references for keying into an e-file product.
5. **No K-1 field posts on low extraction confidence** without the owner touching it.
6. **No reimbursement to the owner posts** without an approved accountable-plan submission and
   an attached document.
7. **Health-insurance premiums are expensed exactly once** (account 5030), always in W-2 Box 1
   and Box 14, never in Box 3/5.
8. The CPA review package **cannot be "final" with a red tie-out**; "final with open items"
   requires an owner note on every red item.
9. **Zero commingling:** personal transactions in a business account are flagged as errors to
   fix at the bank, never classified as personal.
10. **Do not build** AR/AP posting subledgers, inventory, multi-entity, multi-currency, or
    multi-user. Invoice tracking, if ever wanted, is a memo list that posts nothing until cash
    arrives.
11. Anthropic API details (model ID, document-input format) are read from current docs at
    build time and kept in config, not code.
12. The app is not a tax adviser; every workpaper carries a reviewed-by owner/CPA sign-off
    field before it can be marked final.

## Owner decisions (standing; do not re-ask)

- **2026-09-11 — "Embed correct logic over manual calcs, always."** If a manual calculation
  can be avoided by embedding the correct logic (e.g., the meals 50% close reclass, AAA/OAA
  routing via `m2_col`), build it in. Do not check with the owner about decisions of this
  kind; surface them in commit messages and docs instead.
- **2026-09-11 — Approved:** extended `tax_treatment` enum (`taxable_ordinary`, `tax_exempt`
  added; orthogonal `m2_col` aaa/oaa), meals posted gross to 5130 with disallowed half
  reclassed to 5900 at close, semantic form-line codes resolved by per-year caption files,
  splitting brief accounts 5040→5041-5044 and 5050→5050/5055.
- Defaults in effect from `docs/proposal/06-open-questions.md` until overridden: TS + Next.js +
  Postgres + Drizzle + Vitest, local-first; receipt-only revenue (no AR memo list); workpapers
  in both PDF and XLSX. Open answers (bank institutions, CPA software, 401(k) plan compensation
  definition, health arrangement, accountable-plan figures) are **configuration**, never
  assumptions baked into code.

## Engineering rules

- **Money is integer cents as JS `bigint`** end to end (`src/lib/cents.ts`). Never `number`
  arithmetic on amounts, never `parseFloat`, never float columns. DB columns are the `cents`
  domain (BIGINT). Tax math uses the cents lib's explicit rounding helpers; IRS whole-dollar
  rounding happens in workpapers only, with the rounding step recorded in the trace.
- **The database enforces the invariants, not the app.** Migrations are hand-written SQL under
  `drizzle/` (numbered, immutable once pushed); `src/db/schema.ts` mirrors them for typed
  queries and must be updated in the same commit. The journal is append-only; corrections go
  through `post_reversal`. Never write raw INSERTs into `journal_entries`/`journal_lines` from
  feature code — **all posting goes through `src/ledger/posting.ts`**, the single code path
  that runs the guard pipeline (this is how guardrails 2/3/6 and the document requirement are
  enforced).
- **Every posted entry, reversal, classification decision, lock/unlock, K-1 confirmation, and
  tax computation writes an audit row.** Computed figures that can reach a return store a
  `computation_trace` (inputs, table versions, ordered intermediates, outputs).
- **Tests are the gate.** Invariant/property tests run against a real Postgres (see
  `tests/README.md`). `npm run check` (typecheck + tests) must pass before every commit.
  A change to any `data/tax-tables` file must fail golden tests until fixtures are
  re-verified — never "fix" a golden test by regenerating it without re-deriving by hand.
- **Secrets** live in `.env` (gitignored). SSN and Plaid access tokens are encrypted at rest
  via `src/lib/crypto.ts` (AES-256-GCM, key in `APP_ENCRYPTION_KEY`). Never log them.
- **Never read a secret via dotted `process.env.X` in app/middleware code** — the bundler
  inlines those at build time, freezing the value in `.next` (a password change or secret
  rotation silently requires a rebuild). Use indexed access (`process.env["X"]`). And `.env`
  values are written single-quoted with no `$` in any format we mint, because dotenv-style
  loaders variable-expand `$N` sequences (this mangled a `$`-separated scrypt hash once;
  see tests/lib/auth.test.ts).
- Book = tax wherever possible (cash basis, tax depreciation) so Schedule M-1 stays near zero.
- Plain, boring UI: server components + form posts; correctness and auditability over polish.

## Workflow

- `scripts/db.sh start|stop|reset` — local Postgres 16 (socket in `/tmp/scorp-pg`, data in
  `var/pg`); `npm run db:migrate` applies migrations; `npm run db:seed` loads the COA.
- `npm run dev` — Next.js; `npm test` — Vitest (starts/uses the local DB);
  `npm run check` — typecheck + tests.
- Commit style: imperative subject, body explains the accounting/tax reasoning when relevant.
  Push to the designated feature branch; never force-push shared branches.
