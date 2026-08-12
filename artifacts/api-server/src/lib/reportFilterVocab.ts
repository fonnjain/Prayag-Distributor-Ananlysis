// Shared vocabulary bridge for the report filter bar.
//
// The cascading State Head / State / Distributor filter options come from the
// sale_line territory tree (/api/company-reports/filters): full head names
// ("Sandeep Dadheech") and normalised uppercase states ("UTTAR PRADESH").
// The Sheets-derived aggregates those filters are applied to use their own
// vocabularies:
//   - retailer roster (Coverage): "DADHEECH JI", "East U.P", "Chattisgarh",
//     a "North East" region
//   - order book (Regional): "SANDEEP JI", "W-BENGAL", "UP ( R )", "MP",
//     "MAHARASTRA L/R/S", non-territory buckets (GOVT/PROJECT/GEM/JJM/…)
// Raw comparison matches nothing, so BOTH the filter values and the data
// values are normalised through these maps before matching. New roster or
// order-book spellings need entries here.

// ── States ────────────────────────────────────────────────────────────────────

const STATE_ALIASES: Record<string, string> = {
  // sale_line territory splits → geographic state
  "DELHI A": "DELHI",
  "DELHI NCR": "DELHI",
  "UP ( A )": "UTTAR PRADESH",
  "UP ( R )": "UTTAR PRADESH",
  "UP (AS)": "UTTAR PRADESH",
  "UP (S)": "UTTAR PRADESH",
  "HP": "HIMACHAL PRADESH",
  "KARNATAKA (B)": "KARNATAKA",
  "RAJASTHAN (N)": "RAJASTHAN",
  "AP": "ANDHRA PRADESH",
  "JAMMU": "JAMMU AND KASHMIR",
  "KASHMIR": "JAMMU AND KASHMIR",
  // roster spellings
  "EAST U.P": "UTTAR PRADESH",
  "WEST U.P": "UTTAR PRADESH",
  "U.P": "UTTAR PRADESH",
  "CHATTISGARH": "CHHATTISGARH",
  // order-book spellings
  "W-BENGAL": "WEST BENGAL",
  "MP": "MADHYA PRADESH",
  "MAHARASTRA L": "MAHARASHTRA",
  "MAHARASTRA R": "MAHARASHTRA",
  "MAHARASTRA S": "MAHARASHTRA",
  "MAHARASTRA": "MAHARASHTRA",
  "TAMILNADU": "TAMIL NADU",
};

/** The roster's "North East" region covers these states. */
export const NORTH_EAST_STATES = [
  "ASSAM", "TRIPURA", "MEGHALAYA", "ARUNACHAL PRADESH", "NAGALAND", "MANIPUR", "MIZORAM", "SIKKIM",
];

export function normState(s: string): string {
  const up = s.trim().toUpperCase();
  return STATE_ALIASES[up] ?? up;
}

// ── State heads ───────────────────────────────────────────────────────────────

/** Canonical form = sale_line head name, uppercased. */
const HEAD_ALIASES: Record<string, string> = {
  // roster nicknames
  "DADHEECH JI": "SANDEEP DADHEECH",
  "RIZVI JI": "SYED AQIL RIZVI",
  "BIJJU": "BIJU C.O",
  "BIJU": "BIJU C.O",
  "LALAN": "LALAN KUMAR",
  "NASIR HUSAIN": "NASIR HUSSAIN KHAN",
  // Same territory (Haryana + Rajasthan) under both names.
  "PAWAN KUMAR": "PAWAN SHARMA",
  // order-book nicknames
  "SANDEEP JI": "SANDEEP DADHEECH",
  // non-territory buckets → the tree's single non-territory head
  "GOVT": "NON-TERRITORY / PROJECT / GOVT",
  "PROJECT": "NON-TERRITORY / PROJECT / GOVT",
  "GEM": "NON-TERRITORY / PROJECT / GOVT",
  "JJM": "NON-TERRITORY / PROJECT / GOVT",
  "HITESH": "NON-TERRITORY / PROJECT / GOVT",
  "OTHER": "NON-TERRITORY / PROJECT / GOVT",
};

export function normHead(s: string): string {
  const up = s.trim().toUpperCase().replace(/\s+/g, " ");
  return HEAD_ALIASES[up] ?? up;
}

// ── Display normalisation ─────────────────────────────────────────────────────
// Applied to the *output* of filter functions so the UI shows canonical names.
// Filtering still uses normHead / normState (no change to matching logic).

/** canonical-norm (uppercase) → readable display name */
const HEAD_DISPLAY_MAP: Record<string, string> = {
  "ANANT SINGH":          "Anant Singh",
  "ANUJ SHARMA":          "Anuj Sharma",
  "BIJU C.O":             "Biju C.O",
  "LALAN KUMAR":          "Lalan Kumar",
  "NARENDRA SHARMA":      "Narendra Sharma",
  "NASIR HUSSAIN KHAN":   "Nasir Hussain Khan",
  "PAWAN SHARMA":         "Pawan Sharma",
  "PRASHANT ONAM NAIK":   "Prashant Onam Naik",
  "SANDEEP DADHEECH":     "Sandeep Dadheech",
  "SULINDER PAL":         "Sulinder Pal",
  "SUNIL MOHANTY":        "Sunil Mohanty",
  "SUNIL PATEL":          "Sunil Patel",
  "SURESH KUMAR NAIR":    "Suresh Kumar Nair",
  "SYED AQIL RIZVI":      "Syed Aqil Rizvi",
  "BABU":                 "Babu",
};

/**
 * Converts a raw order-book / roster head name to its canonical display form.
 * Non-territory bucket labels (GOVT, PROJECT, GEM, JJM, OTHER) are returned
 * as-is because they are meaningful column labels, not person names.
 */
export function displayHead(raw: string): string {
  const norm = normHead(raw);
  return HEAD_DISPLAY_MAP[norm] ?? raw;
}

/** Abbreviated or mis-cased state strings → readable canonical form.
 *  Sub-territory qualifiers (L / R / S, Rural / Agra) are preserved. */
const STATE_DISPLAY_OVERRIDES: Record<string, string> = {
  "W-BENGAL":     "West Bengal",
  "MP":           "Madhya Pradesh",
  "AP":           "Andhra Pradesh",
  "HP":           "Himachal Pradesh",
  "TAMILNADU":    "Tamil Nadu",
  "Tamilnadu":    "Tamil Nadu",
  "CHATTISGARH":  "Chhattisgarh",
  "UP ( R )":     "Uttar Pradesh (R)",
  "UP ( A )":     "Uttar Pradesh (A)",
  "UP (AS)":      "Uttar Pradesh (AS)",
  "UP (S)":       "Uttar Pradesh (S)",
  "EAST U.P":     "Uttar Pradesh (East)",
  "WEST U.P":     "Uttar Pradesh (West)",
  "U.P":          "Uttar Pradesh",
  "MAHARASTRA L": "Maharashtra (L)",
  "MAHARASTRA R": "Maharashtra (R)",
  "MAHARASTRA S": "Maharashtra (S)",
  "MAHARASTRA":   "Maharashtra",
  "DELHI A":      "Delhi (A)",
  "DELHI NCR":    "Delhi (NCR)",
  "KARNATAKA (B)":"Karnataka (B)",
  "RAJASTHAN (N)":"Rajasthan (N)",
  "JAMMU":        "Jammu",
  "KASHMIR":      "Kashmir",
};

function toTitleCase(s: string): string {
  return s.replace(/\b[A-Z][A-Z]+\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

/**
 * Converts a raw order-book state string to a readable display form.
 * Known abbreviations are expanded; unknown all-caps words are title-cased.
 */
export function displayState(raw: string): string {
  const trimmed = raw.trim();
  if (STATE_DISPLAY_OVERRIDES[trimmed]) return STATE_DISPLAY_OVERRIDES[trimmed];
  const upper = trimmed.toUpperCase().replace(/\s+/g, " ");
  if (STATE_DISPLAY_OVERRIDES[upper]) return STATE_DISPLAY_OVERRIDES[upper];
  // Title-case runs of all-caps (BIHAR → Bihar, JHARKHAND → Jharkhand).
  return toTitleCase(trimmed);
}
