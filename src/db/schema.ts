/**
 * Drizzle mirror of the hand-written SQL migrations in drizzle/*.sql.
 * The SQL is the source of truth (CLAUDE.md); update both in the same commit.
 * Triggers/functions/constraints live only in the SQL — this file exists for
 * typed queries. Money columns use the `cents` domain (BIGINT) as bigint.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const cents = customType<{ data: bigint; driverData: string }>({
  dataType() {
    return "cents";
  },
  fromDriver(value) {
    return BigInt(value);
  },
  toDriver(value: bigint) {
    return value.toString();
  },
});

// ---------------------------------------------------------------------------
// Enums (names must match the SQL types)
// ---------------------------------------------------------------------------
export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "contra_asset",
  "liability",
  "equity",
  "contra_equity",
  "revenue",
  "expense",
]);
export const taxTreatmentEnum = pgEnum("tax_treatment", [
  "taxable_ordinary",
  "separately_stated",
  "deductible",
  "deductible_50pct",
  "nondeductible",
  "tax_exempt",
  "not_tax",
]);
export const m2ColumnEnum = pgEnum("m2_column", ["aaa", "oaa"]);
export const sourceModuleEnum = pgEnum("source_module", [
  "manual",
  "bank",
  "payroll",
  "k1",
  "reimbursement",
  "fixed_asset",
  "tax_accrual",
  "close",
  "reversal",
]);
export const investeeTypeEnum = pgEnum("investee_type", ["partnership", "c_corporation"]);
export const bankSourceEnum = pgEnum("bank_source", ["csv", "ofx", "plaid"]);
export const txnStatusEnum = pgEnum("txn_status", [
  "unreviewed",
  "proposed",
  "posted",
  "transfer",
  "flagged",
]);
export const ownerPaymentTagEnum = pgEnum("owner_payment_tag", [
  "payroll_net_pay",
  "distribution",
  "reimbursement",
]);
export const documentSourceEnum = pgEnum("document_source", [
  "upload",
  "email_inbox",
  "generated",
]);
export const reimbursementCategoryEnum = pgEnum("reimbursement_category", [
  "home_office",
  "phone",
  "internet",
  "supplies",
  "health_insurance",
  "other",
]);

// ---------------------------------------------------------------------------
// Ledger core (0001)
// ---------------------------------------------------------------------------
export const investees = pgTable("investees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  ein: text("ein"),
  entityType: investeeTypeEnum("entity_type").notNull(),
  ownershipPct: numeric("ownership_pct", { precision: 7, scale: 4 }).notNull(),
  acquiredOn: date("acquired_on", { mode: "string" }).notNull(),
  initialContribution: cents("initial_contribution").notNull().default(0n),
  counterpartyRegex: text("counterparty_regex"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  type: accountTypeEnum("type").notNull(),
  taxTreatment: taxTreatmentEnum("tax_treatment").notNull(),
  m2Col: m2ColumnEnum("m2_col"),
  form1120sLine: text("form_1120s_line"),
  scheduleKLine: text("schedule_k_line"),
  requiresDocument: boolean("requires_document").notNull().default(false),
  documentThreshold: cents("document_threshold"),
  investeeId: integer("investee_id").references(() => investees.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const periods = pgTable("periods", {
  taxYear: smallint("tax_year").notNull(),
  month: smallint("month").notNull(),
  locked: boolean("locked").notNull().default(false),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  detail: jsonb("detail"),
});

export const journalEntries = pgTable("journal_entries", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  memo: text("memo").notNull(),
  sourceModule: sourceModuleEnum("source_module").notNull(),
  sourceId: bigint("source_id", { mode: "bigint" }),
  reversesEntryId: bigint("reverses_entry_id", { mode: "bigint" }),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
});

export const journalLines = pgTable(
  "journal_lines",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "bigint" })
      .notNull()
      .references(() => journalEntries.id),
    lineNo: smallint("line_no").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    debit: cents("debit").notNull().default(0n),
    credit: cents("credit").notNull().default(0n),
    memo: text("memo"),
    investeeId: integer("investee_id").references(() => investees.id),
    payrollRunId: bigint("payroll_run_id", { mode: "bigint" }),
    k1Id: bigint("k1_id", { mode: "bigint" }),
    bankTransactionId: bigint("bank_transaction_id", { mode: "bigint" }),
    taxYear: smallint("tax_year"),
  },
  (t) => [index("journal_lines_account_ix").on(t.accountId)],
);

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  encrypted: boolean("encrypted").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Vault (0002)
// ---------------------------------------------------------------------------
export const documents = pgTable("documents", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sha256: text("sha256").notNull().unique(),
  sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
  source: documentSourceEnum("source").notNull().default("upload"),
  year: smallint("year"),
  retainUntil: date("retain_until", { mode: "string" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentLinks = pgTable(
  "document_links",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    documentId: bigint("document_id", { mode: "bigint" })
      .notNull()
      .references(() => documents.id),
    linkedType: text("linked_type").notNull(),
    linkedId: text("linked_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_links_target_ix").on(t.linkedType, t.linkedId)],
);

// ---------------------------------------------------------------------------
// Banking (0003)
// ---------------------------------------------------------------------------
export const bankAccounts = pgTable("bank_accounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  ledgerAccountId: integer("ledger_account_id")
    .notNull()
    .references(() => accounts.id),
  institution: text("institution"),
  mask: text("mask"),
  importProfile: jsonb("import_profile").$type<CsvImportProfile | null>(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** CSV import profile stored per bank account. */
export type CsvImportProfile = {
  delimiter?: string; // default ","
  skipRows?: number; // header rows before data
  dateColumn: string; // header name
  dateFormat: "MDY" | "DMY" | "YMD"; // separator-agnostic
  descriptionColumns: string[]; // joined with " " in order
  // either a single signed amount column, or split debit/credit columns
  amountColumn?: string;
  debitColumn?: string; // outflows as positive numbers
  creditColumn?: string; // inflows as positive numbers
  negateAmount?: boolean; // if the bank exports outflows as positive in amountColumn
};

export const importBatches = pgTable("import_batches", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  bankAccountId: integer("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  source: bankSourceEnum("source").notNull(),
  documentId: bigint("document_id", { mode: "bigint" }).references(() => documents.id),
  filename: text("filename"),
  rowCount: integer("row_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  warnings: jsonb("warnings").$type<string[] | null>(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const classificationRules = pgTable("classification_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  descriptionRegex: text("description_regex").notNull(),
  amountMin: cents("amount_min"),
  amountMax: cents("amount_max"),
  bankAccountId: integer("bank_account_id").references(() => bankAccounts.id),
  targetAccountId: integer("target_account_id")
    .notNull()
    .references(() => accounts.id),
  memoTemplate: text("memo_template"),
  investeeId: integer("investee_id").references(() => investees.id),
  ownerPaymentTag: ownerPaymentTagEnum("owner_payment_tag"),
  autoPost: boolean("auto_post").notNull().default(false),
  priority: integer("priority").notNull().default(100),
  active: boolean("active").notNull().default(true),
  timesApplied: integer("times_applied").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reconciliations = pgTable(
  "reconciliations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    bankAccountId: integer("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    statementDate: date("statement_date", { mode: "string" }).notNull(),
    statementBalance: cents("statement_balance").notNull(),
    ledgerBalance: cents("ledger_balance"),
    difference: cents("difference"),
    status: text("status").notNull().default("open"),
    snapshot: jsonb("snapshot"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reconciliations_acct_date_ux").on(t.bankAccountId, t.statementDate)],
);

/** Rule-proposed classification stored on the transaction awaiting confirm. */
export type TxnProposal = {
  targetAccountId: number;
  memo: string;
  investeeId?: number;
  ownerPaymentTag?: "payroll_net_pay" | "distribution" | "reimbursement";
  ruleId: number;
};

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    bankAccountId: integer("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    source: bankSourceEnum("source").notNull(),
    externalId: text("external_id"),
    importHash: text("import_hash"),
    importBatchId: bigint("import_batch_id", { mode: "bigint" }).references(
      () => importBatches.id,
    ),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    amount: cents("amount").notNull(),
    descriptionRaw: text("description_raw").notNull(),
    descriptionNorm: text("description_norm").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    status: txnStatusEnum("status").notNull().default("unreviewed"),
    matchedRuleId: integer("matched_rule_id").references(() => classificationRules.id),
    proposal: jsonb("proposal").$type<TxnProposal | null>(),
    isOwnerPayee: boolean("is_owner_payee").notNull().default(false),
    ownerPaymentTag: ownerPaymentTagEnum("owner_payment_tag"),
    journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).references(
      () => journalEntries.id,
    ),
    transferPeerId: bigint("transfer_peer_id", { mode: "bigint" }),
    reconciliationId: integer("reconciliation_id").references(() => reconciliations.id),
    flagNote: text("flag_note"),
  },
  (t) => [index("bank_txn_account_date_ix").on(t.bankAccountId, t.txnDate)],
);

export const ruleSuggestions = pgTable("rule_suggestions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  bankAccountId: integer("bank_account_id").references(() => bankAccounts.id),
  descriptionRegex: text("description_regex").notNull(),
  amountMin: cents("amount_min"),
  amountMax: cents("amount_max"),
  targetAccountId: integer("target_account_id")
    .notNull()
    .references(() => accounts.id),
  ownerPaymentTag: ownerPaymentTagEnum("owner_payment_tag"),
  sampleTxnIds: bigint("sample_txn_ids", { mode: "bigint" }).array().notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Time log + reasonable comp (0004)
// ---------------------------------------------------------------------------
export const taskTypes = pgTable("task_types", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
});

export const timeEntries = pgTable("time_entries", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  hours: numeric("hours", { precision: 5, scale: 2 }).notNull(),
  taskTypeId: integer("task_type_id")
    .notNull()
    .references(() => taskTypes.id),
  investeeId: integer("investee_id").references(() => investees.id),
  client: text("client"),
  note: text("note"),
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rateSources = pgTable("rate_sources", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskTypeId: integer("task_type_id")
    .notNull()
    .references(() => taskTypes.id),
  hourlyRate: cents("hourly_rate").notNull(),
  sourceKind: text("source_kind").notNull(),
  citation: text("citation").notNull(),
  conversionNote: text("conversion_note"),
  capturedOn: date("captured_on", { mode: "string" }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const corroborationMetrics = pgTable("corroboration_metrics", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  period: text("period").notNull(),
  metric: text("metric").notNull(),
  value: numeric("value", { precision: 18, scale: 2 }).notNull(),
  sourceNote: text("source_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const compMethodologies = pgTable("comp_methodologies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  version: integer("version").notNull().unique(),
  description: text("description").notNull(),
  parameters: jsonb("parameters").$type<CompMethodologyParams>().notNull(),
  frozen: boolean("frozen").notNull().default(false),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CompMethodologyParams = {
  rateAggregation: "median" | "mean" | "min";
};

export const compComputations = pgTable("comp_computations", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  methodologyId: integer("methodology_id")
    .notNull()
    .references(() => compMethodologies.id),
  taxYear: smallint("tax_year").notNull(),
  total: cents("total").notNull(),
  corroboration: jsonb("corroboration"),
  trace: jsonb("trace").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const compComputationLines = pgTable("comp_computation_lines", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  computationId: bigint("computation_id", { mode: "bigint" })
    .notNull()
    .references(() => compComputations.id),
  taskTypeId: integer("task_type_id")
    .notNull()
    .references(() => taskTypes.id),
  hours: numeric("hours", { precision: 8, scale: 2 }).notNull(),
  rate: cents("rate").notNull(),
  amount: cents("amount").notNull(),
  rateSourceIds: integer("rate_source_ids").array().notNull(),
});

// ---------------------------------------------------------------------------
// Accountable plan (0005)
// ---------------------------------------------------------------------------
export const accountablePlans = pgTable("accountable_plans", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  adoptedOn: date("adopted_on", { mode: "string" }).notNull(),
  documentId: bigint("document_id", { mode: "bigint" }).references(() => documents.id),
  substantiationWindowDays: integer("substantiation_window_days").notNull().default(60),
  categories: reimbursementCategoryEnum("categories").array().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reimbursementSubmissions = pgTable("reimbursement_submissions", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  planId: integer("plan_id")
    .notNull()
    .references(() => accountablePlans.id),
  taxYear: smallint("tax_year").notNull(),
  category: reimbursementCategoryEnum("category").notNull(),
  amount: cents("amount").notNull(),
  computation: jsonb("computation"),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => documents.id),
  submittedOn: date("submitted_on", { mode: "string" }),
  approvedOn: date("approved_on", { mode: "string" }),
  status: text("status").notNull().default("draft"),
  journalEntryId: bigint("journal_entry_id", { mode: "bigint" }).references(
    () => journalEntries.id,
  ),
  paidBankTransactionId: bigint("paid_bank_transaction_id", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Corporate records (0006)
// ---------------------------------------------------------------------------
export const corporateRecordKindEnum = pgEnum("corporate_record_kind", [
  "annual_consent",
  "preyear_consent",
  "accountable_plan_policy",
  "de_minimis_election",
  "standing",
]);

export const corporateRecords = pgTable("corporate_records", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: corporateRecordKindEnum("kind").notNull(),
  standingKind: text("standing_kind"),
  taxYear: smallint("tax_year"),
  title: text("title").notNull(),
  data: jsonb("data"),
  documentId: bigint("document_id", { mode: "bigint" }).references(() => documents.id),
  status: text("status").notNull().default("generated"),
  signedOn: date("signed_on", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
export type Account = typeof accounts.$inferSelect;
export type Investee = typeof investees.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type ClassificationRule = typeof classificationRules.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type TaskType = typeof taskTypes.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type RateSource = typeof rateSources.$inferSelect;
export type CompMethodology = typeof compMethodologies.$inferSelect;
