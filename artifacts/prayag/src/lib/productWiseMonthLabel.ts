export type ProductWiseMonthMetadata = {
  month?: string | null;
  cutoff?: string | null;
  completeness?: "complete" | "partial" | "unavailable" | string | null;
};

type FormatOptions = {
  partial?: boolean;
};

/**
 * Formats Product-Wise month metadata using the source cutoff date in IST.
 * A partial month is rendered as `Month (1–N Mon, partial)`; complete and
 * unavailable months retain their source month label.
 */
export function formatProductWiseMonthLabel(
  metadata: ProductWiseMonthMetadata,
  options: FormatOptions = {},
): string {
  const month = metadata.month?.trim();
  if (!month) return "";
  const partial = options.partial ?? metadata.completeness === "partial";
  if (!partial) return month;
  if (!metadata.cutoff) return `${month} (partial)`;

  const cutoff = new Date(metadata.cutoff);
  if (!Number.isFinite(cutoff.getTime())) return `${month} (partial)`;
  // en-US supplies stable three-letter month abbreviations (notably "Sep")
  // while the timezone keeps the cutoff day aligned with the Indian source.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
  }).formatToParts(cutoff);
  const day = parts.find((part) => part.type === "day")?.value;
  const cutoffMonth = parts.find((part) => part.type === "month")?.value;
  return day && cutoffMonth
    ? `${month} (1–${day} ${cutoffMonth}, partial)`
    : `${month} (partial)`;
}