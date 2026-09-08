type Props = { months: string[] };

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

/** Quiet, shared reminder that open primary-register figures can still change. */
export default function ProvisionalMonthsBanner({ months }: Props) {
  if (!months.length) return null;
  return (
    <div
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
      data-testid="banner-provisional-months"
    >
      {periodLabel(months)} {months.length === 1 ? "is" : "are"} provisional and may change until {months.length === 1 ? "it closes" : "they close"}.
    </div>
  );
}