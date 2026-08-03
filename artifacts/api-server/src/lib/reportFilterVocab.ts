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
