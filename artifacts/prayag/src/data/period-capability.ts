// Period capability — declares whether a page honours the global period selector.
// All page/section IDs are declared here, beside their route definitions in
// Dashboard.tsx and SalesPage.tsx.  An undeclared ID defaults to NONE, so a
// page added later cannot silently reintroduce the YTD-under-monthly-heading
// failure.
//
// Move a page from FY_ONLY → FULL when it is fixed (one page at a time).

export type PeriodCapability =
  | "FULL"      // honours month, quarter, YTD and custom ranges
  | "FY_ONLY"   // honours the FY selector, not a sub-year period
  | "NONE";     // not period-scoped at all, by design

/** Shown in the filter bar when the page is FY_ONLY and the user picks a month/quarter. */
export const FY_ONLY_REASON =
  "This page shows year-to-date figures. Month selection is not available " +
  "because its source has no monthly breakdown.";

/** Shown in place of the filter controls when the page is NONE. */
export const NONE_REASON =
  "Period selection does not apply to this page.";

// ── Declarations ──────────────────────────────────────────────────────────────
// Key = page id (from Dashboard AREAS) or section id (from SalesPage SECTIONS).

const PAGE_CAPABILITIES: Record<string, PeriodCapability> = {

  // ── FULL — honours month, quarter, YTD and custom ranges ─────────────────
  // These pages read monthFrom/monthTo and return the correct slice.
  "state-head":              "FULL",
  "primary-performance":     "FULL",
  "secondary-performance":   "FULL",
  // ── FY_ONLY — honours the FY selector; sub-year period has no effect ──────
  // Source is YTD-only or the page has not yet been wired for monthly slicing.
  // Move to FULL after fixing, one page at a time (PA2 priority order).
  "overview":                "FY_ONLY",
  "regional":                "FY_ONLY",
  "resources":               "FY_ONLY",   // Coverage
  "products":                "FY_ONLY",
  "momentum":                "FY_ONLY",
  "growth":                  "FY_ONLY",
  "pending":                 "FY_ONLY",   // Pending Orders
  "sources":                 "FY_ONLY",   // Data Sources
  "reports":                 "FY_ONLY",
  "analyst":                 "FY_ONLY",   // AI Analyst
  "ai-reports":              "FY_ONLY",   // AI Reports  ← PA2 priority 1
  "company-reports":         "FY_ONLY",
  "salespeople":             "FULL",      // Sales People — SOBR gives per-month Plan/OB/Sales for 162 secondary members; 19 primary-role members show "—" for monthly cells (no SOBR row)
  "deep-dive":               "FY_ONLY",   // Sales Deep Dive  ← PA2 priority 3
  "distributor-deep-dive":   "FY_ONLY",   // Distributor Deep Dive  ← PA2 priority 5

  // ── NONE — not period-scoped at all, by design ────────────────────────────
  "warnings":                "NONE",  // always current FY, independent of global filter
  "targets":                 "NONE",  // local FY selector inside the component
  "data-health":             "NONE",  // local FY selector inside the component

};

/** Convert a wouter location string to the page/section id. */
function pageIdFromPath(pathname: string): string {
  // Sales sub-pages: /sales/state-head → "state-head"
  const salesMatch = pathname.match(/^\/sales\/(.+)$/);
  if (salesMatch) return salesMatch[1];
  // Dashboard root → "overview" (Overview is mounted at "/")
  if (pathname === "/" || pathname === "") return "overview";
  // Other dashboard areas: /regional → "regional"
  return pathname.slice(1);
}

/**
 * Returns the declared PeriodCapability for the current route path.
 * An undeclared path defaults to NONE.
 */
export function getCapabilityForPath(pathname: string): PeriodCapability {
  const id = pageIdFromPath(pathname);
  return PAGE_CAPABILITIES[id] ?? "NONE";
}
