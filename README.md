# S-Corp Back Office

Single-owner back office for a NYC single-member LLC with an S election effective 1/1/2027:
double-entry ledger as the hub, bank ingestion, one annual payroll run, K-1 ingestion,
entity tax workpapers (1120-S / CT-3-S / NYC GCT), compliance calendar, and a pre-tied-out
CPA review package. **Workpapers only — this app never renders or files official forms.**

- **[`PROJECT_BRIEF.md`](PROJECT_BRIEF.md)** — the authoritative brief (context, modules,
  guardrails, build order).
- **[`docs/proposal/`](docs/proposal/)** — Phase 0 deliverable: data model, chart of accounts
  with tax mappings, ledger invariants as SQL, bank-ingestion flow, Phase 1 plan, and the open
  questions. **Awaiting owner approval; no application code exists yet by design.**
