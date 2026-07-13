// Shared formatting utilities for Customer Performance components.
// Realized price = Value / Qty — always shown per unit.

export function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " pcs";
}

export function fmtQtyShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function fmtVal(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toFixed(2)}`;
}

export function fmtPct(n: number | null, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

export function pctColor(n: number | null, invert = false): string {
  if (n == null) return "text-muted-foreground";
  const positive = invert ? n < 0 : n > 0;
  const negative = invert ? n > 0 : n < 0;
  if (positive) return "text-emerald-700 dark:text-emerald-400";
  if (negative) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

export function fmtPp(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)} pp`;
}
