// Title-cases a raw string: "SANDEEP JI" -> "Sandeep Ji".
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const FISCAL_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

// The twelve month labels of a fiscal year like '2026-27' in fiscal order:
// Apr-26 .. Dec-26, Jan-27, Feb-27, Mar-27.
export function fyMonthLabels(fy: string): string[] {
  const startYy = Number(fy.slice(2, 4));
  const endYy = Number(fy.slice(5, 7));
  if (!Number.isFinite(startYy) || !Number.isFinite(endYy)) return [];
  return FISCAL_MONTHS.map((m, i) => {
    const yy = i < 9 ? startYy : endYy;
    return `${m}-${String(yy).padStart(2, "0")}`;
  });
}

