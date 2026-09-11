import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "S-Corp Back Office",
  description: "Ledger-first back office: bank ingestion, payroll, K-1s, workpapers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
