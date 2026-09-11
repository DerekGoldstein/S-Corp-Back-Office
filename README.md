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
- **UI** — session-authenticated (scrypt + HMAC cookie) server-rendered screens:
  dashboard, queue, import, journal, reports, reconciliation, rules, time & comp,
  records, settings (period locks gated on reconciliation).

103 tests run against a real Postgres per commit (`.github/workflows/ci.yml`), including
ported invariant probes and seeded property tests (random balanced entries always accepted;
every off-by-a-cent mutation, locked-period insert, and history edit rejected by the DB).

## Still ahead (per brief §7)

Plaid sync · K-1 PDF extraction via the Anthropic API + review screen · payroll engine with
2027 verified tables, golden tests, deposit scheduling, and form worksheets · owner-level
projection · entity workpapers (1120-S/CT-3-S/GCT) · compliance calendar · CPA review
package with tie-outs · email-forward vault inbox.
