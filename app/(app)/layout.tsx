const NAV: Array<{ sec: string; items: Array<[string, string]> }> = [
  {
    sec: "Daily",
    items: [
      ["/", "Dashboard"],
      ["/queue", "Classification queue"],
      ["/import", "Import"],
    ],
  },
  {
    sec: "Ledger",
    items: [
      ["/journal", "Journal"],
      ["/reports/trial-balance", "Trial balance"],
      ["/reports/pnl", "P&L"],
      ["/reports/balance-sheet", "Balance sheet"],
      ["/reports/register", "Register"],
      ["/reconcile", "Reconciliation"],
    ],
  },
  { sec: "Automation", items: [["/rules", "Rules"]] },
  {
    sec: "Tax & compliance",
    items: [
      ["/k1", "K-1s"],
      ["/payroll", "Payroll"],
      ["/calendar", "Calendar"],
      ["/year-end", "Year-end & CPA package"],
    ],
  },
  {
    sec: "Comp & records",
    items: [
      ["/time", "Time & comp"],
      ["/records", "Corporate records"],
    ],
  },
  { sec: "Admin", items: [["/settings", "Settings"]] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">S-Corp Back Office</div>
        {NAV.map((g) => (
          <div key={g.sec}>
            <div className="sec">{g.sec}</div>
            {g.items.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <main>{children}</main>
    </div>
  );
}
