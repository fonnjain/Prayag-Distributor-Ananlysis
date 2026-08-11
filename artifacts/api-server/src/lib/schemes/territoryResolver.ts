// Shared territory resolution utilities.
//
// Maps sale_line.state_canon values (e.g. "WEST BENGAL", "UP (A)") to the
// territory abbreviations stored in territory_group.states[] (e.g. "WB", "WUP").
//
// Used by:
//   nudge.ts          — route customers to the correct territory scheme
//   customers/schemes — filter tracking achievements to the scheme's territory
//   nudge.ts annual   — restrict annual tracker to scheme territory + item groups

// ── Primary mapping: state_canon → territory abbreviations ───────────────────
// For ambiguous states (bare "UTTAR PRADESH", "MAHARASHTRA") the list is ordered
// by priority — the first abbreviation whose territory has a matching scheme wins.

export const STATE_CANON_TO_ABBREVS: Record<string, string[]> = {
  // ── Delhi / NCR ──────────────────────────────────────────────────────────
  "DELHI A":    ["Delhi"],
  "DELHI B":    ["Delhi"],
  "DELHI NCR":  ["Delhi", "NCR"],
  "DELHI":      ["Delhi"],

  // ── Western UP / Uttarakhand → Lalan territory ───────────────────────────
  "UP (A)":       ["WUP"],
  "UTTARAKHAND":  ["UK"],

  // ── Eastern UP → Wahid territory ─────────────────────────────────────────
  "UP (AS)":  ["EUP"],

  // ── Ambiguous "Uttar Pradesh" — try WUP (Lalan) first, then EUP (Wahid) ──
  "UTTAR PRADESH": ["WUP", "EUP"],

  // ── Rajasthan / Haryana / Punjab / Himachal → Lalan ─────────────────────
  "RAJASTHAN":        ["RAJ"],
  "RAJASTHAN (N)":    ["RAJ"],
  "HARYANA":          ["HR"],
  "CHANDIGARH":       ["PB"],
  "PUNJAB":           ["PB"],
  "HIMACHAL PRADESH": ["HP"],

  // ── Gujarat → Lalan ──────────────────────────────────────────────────────
  "GUJARAT": ["GUJ"],

  // ── Maharashtra — ambiguous: try Lalan first, then Wahid (Nagpur area) ───
  "MAHARASHTRA": ["MAH-Lalan", "MAH-Wahid"],

  // ── Madhya Pradesh / Chhattisgarh → Wahid ───────────────────────────────
  "MADHYA PRADESH":  ["MP"],
  "CHHATTISGARH":    ["CHTS"],

  // ── Kerala / Karnataka ────────────────────────────────────────────────────
  "KERALA":         ["KERALA"],
  "KARNATAKA (B)":  ["KARNATAKA"],
  "KARNATAKA":      ["KARNATAKA"],

  // ── AP / Telangana ────────────────────────────────────────────────────────
  "AP":             ["AP"],
  "ANDHRA PRADESH": ["AP"],
  "TELANGANA":      ["TELANGANA"],

  // ── WB / Bihar / Jharkhand / Orissa / NE ─────────────────────────────────
  "WEST BENGAL":        ["WB"],
  "BIHAR":              ["BIHAR"],
  "JHARKHAND":          ["JHARKHAND"],
  "ODISHA":             ["ORISSA"],
  "ASSAM":              ["NE"],
  "MEGHALAYA":          ["NE"],
  "TRIPURA":            ["NE"],
  "MANIPUR":            ["NE"],
  "MIZORAM":            ["NE"],
  "NAGALAND":           ["NE"],
  "SIKKIM":             ["NE"],
  "ARUNACHAL PRADESH":  ["NE"],

  // ── J&K ───────────────────────────────────────────────────────────────────
  "JAMMU":   ["JK"],
  "KASHMIR": ["JK"],
  "J&K":     ["JK"],

  // ── Not covered by any Q2 scheme ─────────────────────────────────────────
  "TAMIL NADU":                    [],
  "GEM":                           [],
  "Non-territory / Project / Govt": [],
};

// ── Exclusion sentinel ────────────────────────────────────────────────────────
// Territory groups that express inclusion via exclusion (e.g. "All States Except
// KERALA/KARNATAKA/TN/AP") carry a sentinel abbreviation in their states[] array
// instead of enumerating every included state. stateCanonsForAbbrevs recognises
// the sentinel and returns the positive set that the exclusion implies.
//
// Excluded abbreviations for ALL_EXCEPT_KL_KA_TN_AP:
const ALL_EXCEPT_KL_KA_TN_AP_EXCLUDED = new Set(["KERALA", "KARNATAKA", "AP", "TELANGANA"]);
// Note: Tamil Nadu has abbreviation "" (empty) in STATE_CANON_TO_ABBREVS, so
// "TAMIL NADU" is already excluded because it maps to no abbreviations.

/**
 * Given a list of territory abbreviations (from territory_group.states[]),
 * return all sale_line.state_canon values that resolve to any of those abbrevs.
 *
 * Special sentinels:
 *   "ALL"                    → every state_canon with a non-empty abbreviation list
 *   "ALL_EXCEPT_KL_KA_TN_AP" → all states excluding Kerala, Karnataka, TN, AP/Telangana
 *
 * An unknown sentinel (no handled case) returns [] to fail closed rather than
 * silently treating it as "all states".
 *
 * Example: stateCanonsForAbbrevs(["WB", "BIHAR", "JHARKHAND", "ORISSA", "NE"])
 *   → ["WEST BENGAL", "BIHAR", "JHARKHAND", "ODISHA", "ASSAM", "MEGHALAYA", ...]
 */
export function stateCanonsForAbbrevs(abbrevs: string[]): string[] {
  if (!abbrevs.length) return [];

  // ── Sentinel: "All States" ───────────────────────────────────────────────
  if (abbrevs.includes("ALL")) {
    return Object.keys(STATE_CANON_TO_ABBREVS).filter(
      (k) => STATE_CANON_TO_ABBREVS[k].length > 0,
    );
  }

  // ── Sentinel: "All States Except KERALA/KARNATAKA/TN/AP" ────────────────
  if (abbrevs.includes("ALL_EXCEPT_KL_KA_TN_AP")) {
    return Object.entries(STATE_CANON_TO_ABBREVS)
      .filter(([, stateAbbrevs]) =>
        stateAbbrevs.length > 0 &&
        !stateAbbrevs.some((a) => ALL_EXCEPT_KL_KA_TN_AP_EXCLUDED.has(a)),
      )
      .map(([stateCanon]) => stateCanon);
  }

  // ── Normal case: positive abbreviation list ──────────────────────────────
  const abbrevSet = new Set(abbrevs);
  const result: string[] = [];
  for (const [stateCanon, stateAbbrevs] of Object.entries(STATE_CANON_TO_ABBREVS)) {
    if (stateAbbrevs.some((a) => abbrevSet.has(a))) {
      result.push(stateCanon);
    }
  }
  return result;
}

/**
 * Given a sale_line.state_canon value, return the set of territory abbreviations.
 * Returns an empty set for states not covered by any scheme territory.
 */
export function abbrevSetForStateCanon(stateCanon: string): Set<string> {
  return new Set(STATE_CANON_TO_ABBREVS[stateCanon.trim()] ?? []);
}
