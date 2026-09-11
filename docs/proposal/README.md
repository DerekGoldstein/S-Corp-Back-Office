# Phase 0 proposal — APPROVED 2026-09-11, build in progress

This folder was the first deliverable required by `PROJECT_BRIEF.md` §0 and §10. The owner
approved the model (including the `tax_treatment` enum extension and the automated meals
reclass) on 2026-09-11 and set a standing rule now recorded in `CLAUDE.md`: embed correct
logic over manual calculations, always, without re-asking. Phase 1 build proceeds on the
recommended defaults; the unanswered items in `06-open-questions.md` remain open as
**configuration** to fill in, not blockers.

| File | Contents |
|---|---|
| [`01-data-model.md`](01-data-model.md) | ERD by module, table catalog, journal-entry invariants, posting templates, state machines, design decisions needing sign-off |
| [`02-chart-of-accounts.md`](02-chart-of-accounts.md) | Chart of accounts with `tax_treatment`, `form_1120s_line`, `schedule_k_line` filled in, plus per-account rules |
| [`03-ledger-invariants.sql`](03-ledger-invariants.sql) | The ledger invariants as runnable Postgres DDL (constraints + triggers), including bank-transaction immutability and the owner-payment tag rule — **validated on Postgres 16** |
| [`03-ledger-invariants.probe.sh`](03-ledger-invariants.probe.sh) | Probe suite proving the database rejects every invalid case (unbalanced, back-dated, mutated, untagged owner payment, …) — 29/29 passing; seed of the future property tests |
| [`04-bank-ingestion-flow.md`](04-bank-ingestion-flow.md) | CSV/OFX → classification → posting sequence diagram, transaction state machine, posting guards, reconciliation |
| [`05-phase1-plan.md`](05-phase1-plan.md) | Phase 1 task list with estimates, milestones, and the hard pre-1/1/2027 deadlines |
| [`06-open-questions.md`](06-open-questions.md) | The §9 questions, each with context and a recommended default — answer these first |

## How to approve

1. Answer `06-open-questions.md` (inline edits, or just reply in the session).
2. Review `01`–`05`. The specific judgment calls I made beyond the brief's letter are listed in
   **§8 "Design decisions requiring approval"** of `01-data-model.md` — those are the things to
   veto if you disagree.
3. Say "approved" (with any overrides). I will then generate `CLAUDE.md` from the brief's §8
   guardrails plus your decisions, and start Phase 1 (M0/M1 in `05-phase1-plan.md`).

Nothing in this folder hardcodes a rate, threshold, or due date as a normative value; every
number shown is illustrative and will live in per-year data files per brief §8.
