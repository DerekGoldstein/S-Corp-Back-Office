# Phase 1 plan — Oct–Dec 2026 (proposed)

Status: **proposal.** Scope per brief §7 Phase 1: ledger, COA with tax mappings, CSV/OFX
import, classification queue + rules, reconciliation, basic reports, minimal time log + rate
table, vault basics, §4.9 templates, and a Q4-2026 parallel run against ZipBooks reconciled to
the cent. Estimates are **build-days** (one focused Claude Code working session plus your
review); "owner-hrs" is your time — data entry, decisions, verification. Roughly 24 build-days
plus contingency fits October–December with slack ahead of the hard 1/1/2027 deadlines.

## Milestones

### M0 — Foundations (target: week 1 of Oct) — 2 build-days

| # | Task | Est. |
|---|---|---|
| 0.1 | `CLAUDE.md` from brief §8 + approved decisions (generated at approval, refined here) | 0.25 |
| 0.2 | Scaffold: TypeScript, Next.js, Drizzle, Postgres (Docker locally), Vitest, lint/format, CI running tests | 1 |
| 0.3 | `.env` handling, secret encryption helper (SSN, Plaid tokens at rest), backup script skeleton (nightly dump, encrypted, local + one object store) | 0.75 |

### M1 — Ledger core (target: mid-Oct) — 4 build-days

| # | Task | Est. |
|---|---|---|
| 1.1 | Migrations from `03-ledger-invariants.sql` (schema + triggers) | 1 |
| 1.2 | COA seed from data file per `02-chart-of-accounts.md`; semantic mapping codes + 2026/2027 `form_captions` stubs | 0.5 |
| 1.3 | Posting service (single code path all modules use), `post_reversal`, period lock/unlock with audit | 1 |
| 1.4 | Property tests: random-entry generator vs. invariants I1–I13 (DB must reject, brief §6); golden posting fixtures | 1 |
| 1.5 | Manual journal-entry screen (flagged for audit) + audit log viewer | 0.5 |

### M2 — Reports (target: late Oct) — 2 build-days

| # | Task | Est. |
|---|---|---|
| 2.1 | Trial balance, P&L, balance sheet, GL detail, account register — all as-of-any-date, SQL views + server components | 1.5 |
| 2.2 | Golden report fixtures (hand-computed mini-ledger) | 0.5 |

### M3 — Import & classification (target: mid-Nov) — 5 build-days

| # | Task | Est. |
|---|---|---|
| 3.1 | CSV import with per-account column profiles; OFX/QFX parser; hash dedupe; import summary | 1.5 |
| 3.2 | Classification queue UI (proposed + unreviewed, grouped by counterparty) | 1 |
| 3.3 | Rules engine (regex + amount + account, priority), rule-suggestion after two similar manual classifications, owner-only `auto_post` flag | 1 |
| 3.4 | Posting guards per `04-bank-ingestion-flow.md` §2–3 (owner tags, investee wires, 21xx clearing, 45xx lockout, document requirement) + tests for each guard | 1 |
| 3.5 | Transfer pairwise matching | 0.5 |

### M4 — Reconciliation (target: mid-Nov) — 1.5 build-days

| # | Task | Est. |
|---|---|---|
| 4.1 | Monthly reconciliation flow (typed statement balance), difference itemization, snapshot, period-lock precondition | 1.5 |

### M5 — Vault basics (target: late Nov) — 1.5 build-days

| # | Task | Est. |
|---|---|---|
| 5.1 | Upload, sha256, immutable store, polymorphic links, retention date; attach from queue and JE screens | 1.5 |

### M6 — Time log & comp methodology (target: early Dec) — 2 build-days

| # | Task | Est. |
|---|---|---|
| 6.1 | Time entries + task types + ICS import (optional corroboration), rate table with sources and salary-conversion assumptions | 1 |
| 6.2 | Comp computation (Σ hours × rate by task type), methodology versioning + **freeze**, exportable comp-memo data pack | 1 |

### M7 — §4.9 templates (target: early Dec) — 1.5 build-days

| # | Task | Est. |
|---|---|---|
| 7.1 | Accountable-plan written policy template (PDF, filled from config) | 0.75 |
| 7.2 | Pre-year consent template (comp methodology + freeze date, plan in force, 401(k) election, de-minimis election) | 0.75 |

### M8 — Parallel run & acceptance (Dec) — 3 build-days + owner time

| # | Task | Est. |
|---|---|---|
| 8.1 | Import real Oct–Dec bank data, classify, build rules as patterns emerge | 1 (+ owner ~3 hrs) |
| 8.2 | Reconcile each month to the cent against ZipBooks; investigate every difference | 1.5 (+ owner ~2 hrs) |
| 8.3 | Fixes & gap list from the parallel run; Phase 2 backlog groomed | 0.5 |

**Total ≈ 24 build-days + ~20% contingency.** Phase 1 acceptance: Q4 2026 reconciles to the
cent; comp methodology frozen; policy + consent signed and vaulted; invariant property tests
green in CI.

## Owner actions (calendar, not code)

| When | Action |
|---|---|
| **Now (Sept)** | Answer `06-open-questions.md`; approve/veto the model |
| **Now — overdue** | **NY LLC biennial statement was due August 2026** (anniversary month; formed Aug 2024). No NY late fee, but status shows past-due — file online at NY DOS, ~$9. The brief listed this for Phase 1; the window has already passed, so file now |
| Start of Phase 1 (Oct 1) | **Apply for Plaid production access** — approval + security questionnaire lead time; needed for Phase 2 in January |
| Oct | Ask the CPA: which tax software (for the TB export codes) and preferred review-package layout |
| Nov | Confirm 2027 health-insurance arrangement (entity-paid / owner-paid + reimbursed / none) — feeds payroll config and the pre-year consent |
| Dec | Enter Q4 time log; capture rate sources; freeze methodology |
| **Before 1/1/2027 (hard)** | Sign: accountable-plan policy, pre-year consent (comp methodology + freeze date, 401(k) deferral election, de-minimis election) |
| Q1 2027 | PTET election decision with CPA (deadline March 15, 2027); NYS DOL / WCB one-time questions (SUI treatment of 2% health premiums; DBL/PFL/WC applicability for an LLC member on W-2) — answers stored as config |

2026 remains a disregarded-entity year (S election effective 1/1/2027): the parallel run is
bookkeeping verification only — no payroll, no entity returns from this data. Phase 4 later
dry-runs the workpapers on 2026 data mapped *as if* an S-corp year, per the brief.

## Explicitly deferred (per brief §7)

Plaid sync, K-1 ingestion + basis roll-forward, year-start checklist, 2027 payroll tables
(Phase 2) · payroll engine + golden tests, deposit schedule, form worksheets, email-forward
inbox (Phase 3) · projection, compliance calendar, entity workpapers, annual consent, CPA
package with tie-outs (Phase 4).
