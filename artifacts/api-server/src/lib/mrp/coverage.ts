export function fiscalMonthCalendarStart(label: string): Date | null {
  const match = /^([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(label.trim());
  if (!match) return null;
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    .indexOf(match[1][0].toUpperCase() + match[1].slice(1).toLowerCase());
  if (month < 0) return null;
  const y = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
  return new Date(Date.UTC(y, month, 1));
}

export function latestThreeCompleteFyMonths(
  labels: readonly string[], now: Date = new Date(),
): string[] {
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return labels
    .map((label) => ({ label, date: fiscalMonthCalendarStart(label) }))
    .filter((x): x is { label: string; date: Date } => x.date != null && x.date.getTime() < cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(-3)
    .map((x) => x.label);
}

export function coverageSeverity(pct: number, steadyCritical = false): "current" | "warning" | "critical" {
  if (steadyCritical || pct > 0.05) return "critical";
  if (pct > 0.01) return "warning";
  return "current";
}

export type SteadySeller = { code: string; value: number; lastSold: string | null; soldInLatestThreeCompleteMonths: boolean };
export function rankSteadySellers(rows: readonly SteadySeller[]): SteadySeller[] {
  return [...rows].sort((a, b) => b.value - a.value || a.code.localeCompare(b.code));
}