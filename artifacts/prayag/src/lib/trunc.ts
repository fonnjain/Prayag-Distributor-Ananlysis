/**
 * App-wide figure formatting rule (user requirement, Aug 2026):
 * figures are NEVER rounded — they are truncated to exactly two decimal places.
 * e.g. 341.149 → "341.14", not "341.15".
 */

/** Truncate to 2 decimals and return the number (for locale formatting). */
export function t2n(v: number): number {
  if (!Number.isFinite(v)) return v;
  // absorb binary float noise at the 6th decimal, then truncate to hundredths
  const t = Math.trunc(Math.round(v * 1e6) / 1e4) / 100;
  return Object.is(t, -0) ? 0 : t;
}

/** Truncate to 2 decimals and format with exactly two decimal places. */
export function trunc2(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return t2n(v).toFixed(2);
}

/** Truncate to 2 decimals with Indian digit grouping, always two decimals. */
export function trunc2IN(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return t2n(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
