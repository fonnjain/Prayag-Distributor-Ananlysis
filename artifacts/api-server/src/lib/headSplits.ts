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
 * Remaining unresolved alias pairs (never co-exist in the same FY, but not yet
 * applied via DB UPDATE — business confirmation still required).
 * Keyed by currentCanon so lookups are O(1).
 *
 * Applied and removed (DB UPDATE confirmed clean, Jul 2026):
 *   Sandeep Ji      → Sandeep Dadheech   (10,017 inv / ₹498.99 Cr)
 *   Rizvi Ji        → Syed Aqil Rizvi    ( 6,518 inv / ₹160.50 Cr)
 *   Bijju           → Biju C.O           (   906 inv / ₹50.80 Cr)
 *   Lalan           → Lalan Kumar        ( 1,523 inv / ₹34.37 Cr)
 *   Nasir Husain    → Nasir Hussain Khan (   516 inv / ₹9.93 Cr)
 */
export const CROSS_FY_SPLITS: Record<string, HeadSplit> = {
  // Pawan Kumar → Pawan Sharma merged Aug 2 2026 after business confirmation:
  // FY2026-27 geography matches exactly (Haryana + Rajasthan; Karnal, Jaipur,
  // Bharatpur, Karauli, Churu on both sides) and "PAWAN SHARMA" appears in no
  // register row — same territory, same year, two spellings. All six pairs
  // are now resolved; this map is intentionally empty but kept for the next
  // split that appears.
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
