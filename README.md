# S-Corp Back Office

Single-owner back office for a NYC single-member LLC with an S election effective 1/1/2027:
a double-entry ledger as the single source of truth, bank ingestion with a guarded
classification queue, one annual payroll run, K-1 ingestion, entity tax workpapers
(1120-S / CT-3-S / NYC GCT), a compliance calendar, and a pre-tied-out CPA review package.
**Workpapers only — this app never renders or files official forms.**

- [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) — the authoritative brief.
- [`docs/proposal/`](docs/proposal/) — approved data model, chart of accounts with tax
  mappings, DB-enforced invariants, flows, Phase 1 plan, open questions.
- [`CLAUDE.md`](CLAUDE.md) — standing guardrails and owner decisions.

## Quickstart

```bash
npm install
npm run db:start        # local Postgres 16 (socket /tmp/scorp-pg, data var/pg)
npm run db:migrate      # hand-written SQL migrations in drizzle/
npm run db:seed         # chart of accounts from data/coa/
npm run set-password -- 'a long password'   # writes .env (session + encryption keys too)
npm run dev             # http://localhost:3000
npm run check           # typecheck + full test suite (needs the local DB)
```

Nightly backup: `bash scripts/backup.sh` from cron (pg_dump + vault, AES-256 via
`APP_ENCRYPTION_KEY`, optional `BACKUP_RCLONE_REMOTE` for the cloud copy).

## What is built (Phase 1 + early Phase 2 foundations)

- **Ledger core** — append-only journal with the invariants enforced *by Postgres*
  (balanced entries, locked periods, one-time reversals, per-investee dimensions,
  immutable history); single posting path with guard pipeline (restricted targets,
  document requirements); COA seeded with `tax_treatment` / `form_1120s_line` /
  `schedule_k_line`; reports (TB, P&L, BS, GL, register) as pure as-of queries.
- **Bank ingestion** — CSV (per-account profiles) + OFX imports, dedupe that survives
  identical same-day charges yet makes re-imports no-ops, vaulted source files; rules
  engine with owner-flagged auto-post running the same guards; forced patterns
  (investee wires never revenue, EFTPS/NYS/SUI/401(k) debits clear liabilities, owner
  payments never untagged); transfer matching; monthly reconciliation that completes
  only at zero difference; zero-commingling flagging.
- **Vault** — content-addressed immutable documents, integrity-checked reads,
  polymorphic links, DB-enforced retention.
- **Time & comp** — time log, cited market-rate sources, freezable methodology,
  computation with full trace + comp-memo pack (freeze before 1/1/2027).
- **Corporate records** — accountable-plan policy and pre-year consent generated to PDF
  via headless Chromium, standing-document gap tracking.
- **Year-end close** — meals 50% reclass (odd cent disallowed), AAA/OAA split via
  `m2_col`, distributions closed, periods locked; reversible reopen.
- **Tax-table registry** — per-year JSON versions, one-way owner verification that
  refuses placeholders; consumers fail loudly on unverified or silently-changed tables.
- **K-1 module** — per-field extraction confidence gating confirmation, Anthropic-API
  PDF extraction (model in config), character-preserving posting, box-19 reconciliation,
  §705-ordered outside basis with suspended losses (DB-checked equation).
- **Payroll** — pure table-driven engine for §4.4 steps 1–8 (six wage bases, W-4/IT-2104,
  caps, Additional Medicare), deposit scheduler ($100k next-day, NYS-1 windows), persisted
  runs posting the §4.1 entry, 941/940/W-2/NYS-45 line-keyed worksheets, and vaulted
  pay stubs that re-prove the run's net-pay identity before rendering.
- **Entity workpapers** — 1120-S page 1/Schedule K/L/M-1/M-2 as mapping queries that
  reconcile to the cent; NYC GCT highest-of-four-bases + CT-3-S FDM with accruals;
  Form 7203 stock basis tying to equity via the §1367 identity.
- **Fixed assets** — S-corp-era register (invoices required), MACRS computed as pure
  arithmetic (200/150DB with SL switch, half-year + mid-quarter with the 40% cohort
  test, exact cents that always sum to basis — no percentage table is stored anywhere),
  §179/bonus elections gated by the verified per-year `depreciation` table, one annual
  Dr 5050 / Cr 1610 posting with per-asset detail, and a Form 4562 workpaper whose
  tie-outs run against the ledger (a purchase never classified to 1600 shows up red).
- **Accountable-plan reimbursements** — §4.8 end to end: documented submissions
  (home-office square-footage computation built in), approval posts 504x-or-5030 / 2190,
  and the reimbursement-tagged owner payment clears 2190 and marks submissions paid.
- **Owner projection** — safe-harbor targets and the December over-withholding
  recommendation with residual-to-1040-ES split, assumptions declared on every result.
- **Compliance calendar** — data-driven rules, verified-holiday rollover, filing
  confirmations completing items.
- **CPA review package** — a tie-out runner for everything above (fixed-asset 4562
  checks included), versioned packages with a vaulted cover memo, guardrail-8
  finalization, TB export in the CPA's tax-software codes, and a per-year hand-off
  zip (dependency-free store-mode writer) with the latest workpapers and every
  integrity-checked vault document belonging to the year.
- **UI** — session-authenticated (scrypt + HMAC cookie) server-rendered screens:
  dashboard, queue, import, journal, reports, fixed assets, reconciliation, rules,
  K-1 review, payroll/table verification, reimbursements, calendar, year-end & package
  (with the hand-off zip download), time & comp, records, settings (period locks gated
  on reconciliation).

207 tests run against a real Postgres per commit (`.github/workflows/ci.yml`), including
ported invariant probes and seeded property tests (random balanced entries always accepted;
every off-by-a-cent mutation, locked-period insert, and history edit rejected by the DB).
Tax-rate-bearing engines are tested against synthetic verified tables — no real rate is
invented anywhere; real 2027 values load through the owner-verification gate when published.

## Still ahead (per brief §7)

Plaid sync (production application starts Phase 1) · disposal accounting (§1245 recapture —
disposals currently stop depreciation and route to the CPA) · Pub 15-T/NYS-50-T 2027 tables
+ the hand-derived December golden fixture · email-forward vault inbox ·
CT-3-S/GCT per-year real tables.
