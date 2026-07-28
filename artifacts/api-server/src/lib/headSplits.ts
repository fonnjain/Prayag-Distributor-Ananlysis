// ── Cross-FY head_canon key split registry ────────────────────────────────────
//
// A "split" occurs when the same physical territory manager was recorded under
// different head_canon values in consecutive fiscal years. All six pairs below
// were confirmed by a per-FY DB diff: the old and new names NEVER co-exist in
// the same fiscal year, so they are safe alias candidates.
//
// Root cause: the aliases in head_alias.json were added or corrected after the
// older FY registers had already been ingested, so head_canon in sale_line
// preserves the pre-alias raw-normalised value for FY2023-24 through FY2025-26.
//
// Until an explicit UPDATE (or re-ingestion) aligns the historical head_canon
// values, any YoY query that joins on head_canon = <currentCanon> will return
// zero rows for the prior year — producing a false 100% loss signal.
// Use getSplit() to detect this case and suppress the LY panel rather than
// showing zero.

export type HeadSplit = {
  currentCanon: string;  // head_canon in DB from splitFromFy onward
  priorCanon: string;    // head_canon in DB before splitFromFy
  splitFromFy: string;   // first FY that uses currentCanon
};

/**
 * All confirmed alias pairs (never co-exist in the same FY).
 * Keyed by currentCanon so lookups are O(1).
 */
export const CROSS_FY_SPLITS: Record<string, HeadSplit> = {
  "Sandeep Dadheech":  { currentCanon: "Sandeep Dadheech",  priorCanon: "Sandeep Ji",         splitFromFy: "2026-27" },
  "Syed Aqil Rizvi":   { currentCanon: "Syed Aqil Rizvi",   priorCanon: "Rizvi Ji",            splitFromFy: "2026-27" },
  "Pawan Sharma":      { currentCanon: "Pawan Sharma",       priorCanon: "Pawan Kumar",         splitFromFy: "2026-27" },
  "Biju C.O":          { currentCanon: "Biju C.O",           priorCanon: "Bijju",               splitFromFy: "2026-27" },
  "Lalan Kumar":       { currentCanon: "Lalan Kumar",        priorCanon: "Lalan",               splitFromFy: "2026-27" },
  "Nasir Hussain Khan":{ currentCanon: "Nasir Hussain Khan", priorCanon: "Nasir Husain",        splitFromFy: "2026-27" },
};

/**
 * Returns the split descriptor when `headCanon` has a known cross-FY key split
 * that spans the given CY/LY fiscal year pair, i.e. the CY uses the new name
 * and the LY predates the split.
 *
 * Returns null when no suppression is needed (no split, or both years use the
 * same canon, or the split is in the other direction).
 */
export function getSplit(
  headCanon: string,
  fyCy: string,
  fyLy: string,
): HeadSplit | null {
  const split = CROSS_FY_SPLITS[headCanon];
  if (!split) return null;
  // Suppress only when fyCy is at or after the split and fyLy is before it.
  if (fyCy >= split.splitFromFy && fyLy < split.splitFromFy) return split;
  return null;
}
