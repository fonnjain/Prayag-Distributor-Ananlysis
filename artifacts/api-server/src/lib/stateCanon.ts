/**
 * state_canon normalisation helpers.
 *
 * The ERP's territory management splits some geographic states into sub-territories
 * (e.g. "DELHI A" and "DELHI NCR" are both Delhi; "UP ( A )", "UP (AS)", "UP (S)"
 * are all Uttar Pradesh).  Analytics that GROUP BY or filter on raw state_canon
 * must expand to the full variant set, or they silently under-count.
 *
 * Single source of truth — import these helpers everywhere instead of maintaining
 * separate copies.
 */

export const STATE_CANON_NORMALISE: Record<string, string> = {
  "DELHI A":       "DELHI",
  "DELHI NCR":     "DELHI",
  "UP ( A )":      "UTTAR PRADESH",
  "UP (AS)":       "UTTAR PRADESH",
  "UP (S)":        "UTTAR PRADESH",
  "HP":            "HIMACHAL PRADESH",
  "KARNATAKA (B)": "KARNATAKA",
};

/** Return the canonical geographic state name for a raw state_canon value. */
export function normaliseStateCanon(raw: string | null): string | null {
  if (raw == null) return null;
  return STATE_CANON_NORMALISE[raw] ?? raw;
}

/**
 * Return every raw state_canon DB value that belongs to the same geographic state
 * as `raw`.  Always includes `raw` itself.  Pass this list to ANY(ARRAY[...])
 * filters so queries span territory splits correctly.
 */
export function stateVariants(raw: string | null): string[] {
  if (raw == null) return [];
  const canonical = STATE_CANON_NORMALISE[raw] ?? raw;
  const variants = new Set<string>();
  variants.add(raw);
  variants.add(canonical);
  for (const [k, v] of Object.entries(STATE_CANON_NORMALISE)) {
    if (v === canonical) variants.add(k);
  }
  return [...variants];
}

/**
 * Expand a user-supplied state filter array (which may contain canonical names,
 * raw split-variants, or a mix) to the full set of raw DB values.
 * Pass the result directly as the ANY($n::text[]) parameter.
 * Returns [] unchanged (= no filter) when the input is [].
 */
export function stateVariantsFromArray(states: string[]): string[] {
  if (states.length === 0) return [];
  return [...new Set(states.flatMap(stateVariants))];
}
