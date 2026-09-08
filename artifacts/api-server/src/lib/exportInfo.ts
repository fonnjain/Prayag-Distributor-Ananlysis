import { getEffectivelyOpenPrimaryRegisterMonths } from "./primaryRegisterMonths.js";

function periodLabel(months: string[]): string {
  const byYear = new Map<string, string[]>();
  for (const label of months) {
    const month = label.slice(0, 3);
    const year = `20${label.slice(-2)}`;
    byYear.set(year, [...(byYear.get(year) ?? []), month]);
  }
  return [...byYear.entries()].map(([year, names]) =>
    `${names.length === 1 ? names[0] : `${names[0]}–${names[names.length - 1]}`} ${year}`,
  ).join(", ");
}

/** A self-describing, dynamically-derived statement for export Info sheets. */
export async function provisionalMonthsExportInfo(fy: string): Promise<string> {
  const months = await getEffectivelyOpenPrimaryRegisterMonths(fy);
  return months.length
    ? `${periodLabel(months)} ${months.length === 1 ? "is" : "are"} provisional and may change until ${months.length === 1 ? "it closes" : "they close"}.`
    : "No primary-register months are currently provisional.";
}