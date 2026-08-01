// Shared achievement colour-band scale (Glossary v2, G4 Correction 4 / G1 Part 10).
// Single source of truth used by StateHeadDashboard, SalesPeople and SalesDeepDive:
//   Emerald >100 / Green 90–100 / Yellow 70–90 / Amber 50–70 / Orange 25–50 / Red <25 / Muted = no target.
// Band keys match the server's achBand() output in api-server routes/mgmt.ts.

export type AchBandKey =
  | "above100"
  | "90to100"
  | "70to90"
  | "50to70"
  | "below50"
  | "below25"
  | "noTarget";

/** Band from an achievement percentage on the 0–100 scale (e.g. 60 = 60%). */
export function achievementBand(pct: number | null | undefined): AchBandKey {
  if (pct == null || !isFinite(pct)) return "noTarget";
  if (pct > 100) return "above100";
  if (pct >= 90) return "90to100";
  if (pct >= 70) return "70to90";
  if (pct >= 50) return "50to70";
  if (pct >= 25) return "below50";
  return "below25";
}

export const BAND_LABEL: Record<string, string> = {
  below25: "<25%",
  below50: "25-50%",
  "50to70": "50-70%",
  "70to90": "70-90%",
  "90to100": "90-100%",
  above100: ">100%",
  noTarget: "No Target",
};

/** Pill / chip background+text classes. */
export const BAND_BG: Record<string, string> = {
  below25: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  below50: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "50to70": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "70to90": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  "90to100": "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  above100: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  noTarget: "bg-muted text-muted-foreground",
};

/** Plain text colour classes for table cells (no pill background). */
export const BAND_TEXT: Record<string, string> = {
  below25: "text-red-700 dark:text-red-400",
  below50: "text-orange-700 dark:text-orange-400",
  "50to70": "text-amber-700 dark:text-amber-400",
  "70to90": "text-yellow-700 dark:text-yellow-500",
  "90to100": "text-green-700 dark:text-green-400",
  above100: "text-emerald-700 dark:text-emerald-400 font-semibold",
  noTarget: "text-muted-foreground",
};

/** Convenience: pill classes straight from a 0–100 pct (null/undefined → Muted). */
export function achBandBg(pct: number | null | undefined): string {
  return BAND_BG[achievementBand(pct)];
}

/** Convenience: text classes straight from a 0–100 pct (null/undefined → Muted). */
export function achBandText(pct: number | null | undefined): string {
  return BAND_TEXT[achievementBand(pct)];
}
