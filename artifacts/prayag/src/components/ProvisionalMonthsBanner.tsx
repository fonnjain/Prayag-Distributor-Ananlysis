import { formatProductWiseMonthLabel } from "@/lib/productWiseMonthLabel";

type Props = {
  months: string[];
  secondaryCoverage?: {
    openWindowMonths: string[];
    partialMonths: Array<{ month: string; through: string }>;
    unavailableMonths: string[];
    sourceError?: boolean;
  } | null;
};

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

function secondaryPartialLabel(item: { month: string; through: string }): string {
  return formatProductWiseMonthLabel({ month: item.month, cutoff: item.through }, { partial: true });
}

/** Quiet, shared reminder that open primary-register figures can still change. */
export default function ProvisionalMonthsBanner({ months, secondaryCoverage }: Props) {
  if (!months.length && !secondaryCoverage?.sourceError && !secondaryCoverage?.partialMonths.length && !secondaryCoverage?.unavailableMonths.length) return null;
  const primaryText = months.length
    ? `${periodLabel(months)} ${months.length === 1 ? "is" : "are"} provisional and may change until ${months.length === 1 ? "it closes" : "they close"}.`
    : null;
  const partial = secondaryCoverage?.partialMonths ?? [];
  const unavailable = secondaryCoverage?.unavailableMonths ?? [];
  const secondaryText = [
    secondaryCoverage?.sourceError ? "Secondary coverage source unavailable (not treated as missing months)" : null,
    partial.length
      ? `Secondary ${partial.map(secondaryPartialLabel).join(", ")}`
      : null,
    unavailable.length ? `Secondary ${unavailable.join(", ")} unavailable` : null,
  ].filter(Boolean).join("; ");
  return (
    <div
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
      data-testid="banner-provisional-months"
    >
      {primaryText}{primaryText && secondaryText ? " " : ""}{secondaryText}
    </div>
  );
}