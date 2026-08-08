// Register-join resolver for Product_Upload_Sample_File.csv.
//
// The sale register writes product codes differently from the product master.
// This resolves a register code to a master code using a STRICT 4-step order.
// The ordering matters: exact match ALWAYS runs first, so legitimate register
// codes that merely look like they carry a colour/length suffix (e.g. 130-B,
// 141-E, 121-E, 129-C) are never mangled — they match exactly and stop there.
//
//   1. Exact match on the register code.
//   2. "P" + all digits  → strip the leading P  (P6818 → 6818).
//   3. Trailing colour letter (B, G, P, J, W) after an optional space or
//      hyphen → strip the suffix to get the base code, keep the letter as the
//      colour (7118-B → 7118, 4011B → 4011, 4303 J → 4303).
//   4. Collapse internal whitespace (Q724MB → Q724 MB is handled by comparing
//      the whitespace-stripped forms).
//
// The resolver is PURE: it takes the register code plus a membership test for
// the master (a Set or a predicate) and returns which step resolved it. No DB,
// no I/O — so it is unit-testable against the spec's verified examples.

export type ResolveMethod =
  | "exact"
  | "p_strip"
  | "colour_suffix"
  | "whitespace"
  | "unresolved";

export type ResolveResult = {
  /** The register code as given. */
  registerCode: string;
  /** The master code it resolved to, or null when unresolved. */
  masterCode: string | null;
  /** Which step resolved it (or 'unresolved'). */
  method: ResolveMethod;
  /** Colour letter captured by the colour-suffix step, if any. */
  colour: string | null;
};

/** A membership test against the master code set. */
export type MasterHas = (code: string) => boolean;

const COLOUR_LETTERS = new Set(["B", "G", "P", "J", "W"]);

/** "P" followed by one or more digits (nothing else). */
const P_DIGITS_RE = /^P(\d+)$/;

/** base + optional space/hyphen + single colour letter at the very end. */
const COLOUR_SUFFIX_RE = /^(.*?)[\s-]?([BGPJW])$/;

/** Collapse every run of internal whitespace to nothing (Q724 MB → Q724MB). */
function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Resolve a single register code to a master code.
 *
 * @param registerCode raw code from the sale register
 * @param has          membership test against the master (exact code present)
 * @param masterCodes  optional list of all master codes, needed ONLY for the
 *                     whitespace step (step 4), which matches by comparing the
 *                     whitespace-stripped forms of register and master codes.
 */
export function resolveProductCode(
  registerCode: string,
  has: MasterHas,
  masterCodes?: Iterable<string>,
): ResolveResult {
  const code = (registerCode ?? "").trim();

  // Step 1 — exact match ALWAYS first. 130-B etc. stop here.
  if (has(code)) {
    return { registerCode, masterCode: code, method: "exact", colour: null };
  }

  // Step 2 — "P" + all digits → strip the P.
  const pm = P_DIGITS_RE.exec(code);
  if (pm) {
    const base = pm[1];
    if (has(base)) {
      return { registerCode, masterCode: base, method: "p_strip", colour: null };
    }
  }

  // Step 3 — trailing colour letter after optional space/hyphen.
  const cm = COLOUR_SUFFIX_RE.exec(code);
  if (cm) {
    const base = cm[1];
    const colour = cm[2];
    if (base.length > 0 && COLOUR_LETTERS.has(colour) && has(base)) {
      return { registerCode, masterCode: base, method: "colour_suffix", colour };
    }
  }

  // Step 4 — collapse internal whitespace and match against the master's own
  // whitespace-stripped forms (register Q724MB → master "Q724 MB").
  if (masterCodes) {
    const target = stripWhitespace(code);
    if (target.length > 0) {
      for (const m of masterCodes) {
        if (stripWhitespace(m) === target && m !== code) {
          return { registerCode, masterCode: m, method: "whitespace", colour: null };
        }
      }
    }
  }

  return { registerCode, masterCode: null, method: "unresolved", colour: null };
}

/** Build a fast membership test + whitespace index from a list of codes. */
export function buildResolverIndex(masterCodes: Iterable<string>): {
  has: MasterHas;
  codes: string[];
} {
  const codes = Array.from(masterCodes);
  const set = new Set(codes);
  return { has: (c: string) => set.has(c), codes };
}
