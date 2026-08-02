// Phase A2 — Numeric guard.
//
// After Claude returns report sections, every number in the text is extracted
// and checked against the verified Phase A1 payload.
//
// Any number that cannot be matched to a payload value (within formatting
// tolerances) is flagged. The report is then marked "requires_review" rather
// than silently published — it is NEVER auto-corrected.
//
// Matching tolerances (per spec):
//   - Indian lakh/crore notation (e.g. "18.35 lakh" ≈ 1,834,504)
//   - Indian thousands separators stripped (18,34,504 → 1834504)
//   - One decimal place of rounding (48.539% → 48.5% is valid)
//   - Absolute tolerance floor of ±0.15 covers small-integer rounding
//
// Exclusions:
//   - 4-digit calendar years (2020–2030) — appear in "FY2026-27" text
//   - Zero — appears universally and is not meaningful to check
//
// This guard is the single most important safeguard in the feature. It stops
// a fluent-but-wrong figure reaching a manager's desk.

import type { AiPayload } from "./aiPayload.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type UnmatchedNumber = {
  extracted: string;   // the raw text token
  value: number;       // the parsed + unit-converted canonical value
  sentence: string;    // surrounding sentence for context (≤ 200 chars)
};

export type GuardResult = {
  status: "ok" | "requires_review";
  unmatched: UnmatchedNumber[];
  checked: number;     // total distinct tokens checked
};

// ── Build the allowed-value set from a payload ────────────────────────────────
// Walk every numeric leaf in the payload JSON.  For each value n we add:
//   • n itself (raw INR or count)
//   • |n| (absolute — Claude may write "gap of -510" as a positive figure)
//   • n / 100_000  (lakh variant — "18.35 lakh")
//   • n / 10_000_000  (crore variant — "1.8 crore")
//
// String values are also scanned for embedded numerics so that labels like
// "Mid (15-40 km)" in distanceBands contribute 15 and 40 to the allowlist.

const EMBEDDED_NUM_RE = /\d+(?:\.\d+)?/g;

function collectLeaves(obj: unknown, out: number[]): void {
  if (typeof obj === "number" && isFinite(obj)) {
    out.push(obj);
    return;
  }
  if (typeof obj === "string") {
    // Extract any numeric tokens embedded in string labels (e.g. band thresholds)
    let m: RegExpExecArray | null;
    EMBEDDED_NUM_RE.lastIndex = 0;
    while ((m = EMBEDDED_NUM_RE.exec(obj)) !== null) {
      const n = parseFloat(m[0]);
      if (isFinite(n) && n !== 0) out.push(n);
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => collectLeaves(v, out));
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      collectLeaves(v, out);
    }
  }
}

function buildAllowed(payload: AiPayload): number[] {
  const raw: number[] = [];
  collectLeaves(payload, raw);

  const allowed: number[] = [];
  for (const n of raw) {
    allowed.push(n);
    allowed.push(Math.abs(n));                                     // absolute value
    if (Math.abs(n) >= 50_000) allowed.push(n / 100_000);         // lakh
    if (Math.abs(n) >= 1_000_000) allowed.push(n / 10_000_000);   // crore
    // 2-decimal display rounding: "Rs 0.14 lakh" for 13,890 is the payload
    // figure shown at 2 dp in lakh — a legitimate citation, not a new number.
    // The relative error of 2-dp rounding exceeds the 0.15% tolerance for
    // small displayed values, so allow the rounded rupee forms explicitly.
    if (Math.abs(n) >= 1_000) {
      allowed.push(Math.round((n / 100_000) * 100) / 100 * 100_000);      // lakh @ 2dp
    }
    if (Math.abs(n) >= 100_000) {
      allowed.push(Math.round((n / 10_000_000) * 100) / 100 * 10_000_000); // crore @ 2dp
    }
  }
  return allowed;
}

// ── Text pre-processing ───────────────────────────────────────────────────────
// Neutralise tokens that would inject spurious numbers:
//   • Full ISO dates first (2026-06-30 → YYYY-MM-DD) before partial masks consume them
//   • Fiscal-year references (FY2026-27, 2026-27 bare)
//   • Standalone calendar years (2026 etc.)
//   • Bracket field-path references ([top10[9]], [capacity.remaining]) — Claude
//     uses these to cite source fields; their embedded integers are not data values.

function preprocess(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "YYYY-MM-DD")  // full ISO dates first
    .replace(/\bFY\s*\d{4}-\d{2}\b/gi, "FYXX-XX")      // "FY2026-27"
    .replace(/\b\d{4}-\d{2}\b/g, "YYXX")               // "2026-27" bare
    .replace(/\b20\d{2}\b/g, "YYYY")                    // standalone years 2000-2099
    .replace(/\[[^\]]*\d[^\]]*\]/g, "[REF]")             // bracket field refs [top10[9]], etc.
    .replace(/(?:^|\n)(\d{1,2})\.\s/gm, "\n[N]. ");    // numbered list ordinals "9. Customer…"
}

// ── Number extraction ─────────────────────────────────────────────────────────
// Handles:
//   Indian format    18,34,504     → strips commas → 1834504
//   Western format   1,834,504     → strips commas → 1834504
//   Decimal          18.35
//   Lakh suffix      18.35 lakh    → * 100_000
//   Crore suffix     1.8 crore     → * 10_000_000
//   Percentage       48.5%         → stored as-is (0–100 range)
//   Currency prefix  Rs., ₹        → stripped

type ParsedToken = {
  raw: string;
  value: number;
  position: number;
};

// One globally-defined pattern, reset before each use.
// Uses \d+ (not \d{1,3}) as the leading group so that 4-digit numbers like
// 1005.72 are matched whole rather than split into "100" + "5.72".
const NUM_RE =
  /(?:Rs\.?\s*|₹\s*)?(\d+(?:,\d{2,3})*(?:\.\d+)?)(?:\s*(lakh|lakhs?|crores?|Cr|L)\b)?(\s*%)?/gi;

function extractTokens(text: string): ParsedToken[] {
  NUM_RE.lastIndex = 0;
  const tokens: ParsedToken[] = [];

  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(text)) !== null) {
    const numStr = m[1];
    if (!numStr) continue;

    const unit = (m[2] ?? "").toLowerCase().trim();
    const isPct = !!m[3]?.trim();

    const base = parseFloat(numStr.replace(/,/g, ""));
    if (isNaN(base) || !isFinite(base)) continue;
    if (base === 0) continue; // zero appears everywhere; skip

    let value: number;
    if (isPct) {
      value = base;
    } else if (unit === "lakh" || unit === "lakhs" || unit === "l") {
      value = base * 100_000;
    } else if (unit === "crore" || unit === "crores" || unit === "cr") {
      value = base * 10_000_000;
    } else {
      value = base;
    }

    tokens.push({ raw: m[0].trim(), value, position: m.index });
  }

  return tokens;
}

// ── Context extraction ────────────────────────────────────────────────────────

function getSentence(text: string, pos: number): string {
  // Walk backward to the previous sentence boundary.
  let start = pos;
  while (start > 0 && text[start - 1] !== "." && text[start - 1] !== "\n") start--;
  // Walk forward to the next sentence boundary.
  let end = pos;
  while (end < text.length && text[end] !== "." && text[end] !== "\n") end++;
  const s = text.slice(start, end + 1).trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

// ── Tolerance check ───────────────────────────────────────────────────────────
// Allow:
//   ±0.15  absolute floor  (covers one-decimal rounding on small numbers)
//   0.15%  of the larger value  (covers lakh/crore 2-decimal rounding)

function withinTolerance(extracted: number, allowed: number): boolean {
  const diff = Math.abs(extracted - allowed);
  const tol = Math.max(0.15, Math.abs(allowed) * 0.0015);
  return diff <= tol;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function runNumericGuard(
  sections: Record<string, { title: string; body: string }>,
  payload: AiPayload,
): GuardResult {
  const allowed = buildAllowed(payload);
  const unmatched: UnmatchedNumber[] = [];
  let checked = 0;

  const rawText = Object.values(sections)
    .map((s) => `${s.title}. ${s.body}`)
    .join("\n\n");

  const cleanText = preprocess(rawText);
  const tokens = extractTokens(cleanText);

  for (const tok of tokens) {
    checked++;
    if (!allowed.some((a) => withinTolerance(tok.value, a))) {
      unmatched.push({
        extracted: tok.raw,
        value: tok.value,
        sentence: getSentence(cleanText, tok.position),
      });
    }
  }

  return {
    status: unmatched.length === 0 ? "ok" : "requires_review",
    unmatched,
    checked,
  };
}

// ── Period guard ──────────────────────────────────────────────────────────────
// When the payload covers more than one fiscal month (i.e. it is a multi-month
// YTD report), a sentence that attributes a specific figure to a single named
// month — e.g. "in April the team booked Rs 2.56 Cr" — is misleading because
// the payload only carries YTD cumulative values, not per-month breakdowns.
// This guard flags such sentences so a reviewer can verify them before the
// document leaves the system.
//
// Patterns flagged:
//   "in April", "during April", "for April" followed within 120 chars by a number
//   "[Month] saw" followed within 120 chars by a number
//   "Q1 ...", "Q2 ...", "Q3 ...", "Q4 ..." followed within 80 chars by a number,
//   when toFiscalMonth > 3 (i.e. more than one quarter is covered)

export type FlaggedPeriodSentence = {
  sentence: string;
  termMentioned: string;
  reason: string;
};

export type PeriodGuardResult = {
  status: "ok" | "requires_review";
  flagged: FlaggedPeriodSentence[];
};

const MONTH_LIST =
  "January|February|March|April|May|June|July|August|September|October|November|December";

function periodGetSentence(text: string, pos: number): string {
  let start = pos;
  while (start > 0 && text[start - 1] !== "." && text[start - 1] !== "\n") start--;
  let end = pos;
  while (end < text.length && text[end] !== "." && text[end] !== "\n") end++;
  const s = text.slice(start, end + 1).trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

export function runPeriodGuard(
  sections: Record<string, { title: string; body: string }>,
  toFiscalMonth: number,
): PeriodGuardResult {
  // Only relevant for multi-month periods (2+ fiscal months covered).
  if (toFiscalMonth <= 1) return { status: "ok", flagged: [] };

  const rawText = Object.values(sections)
    .map((s) => `${s.title}. ${s.body}`)
    .join("\n\n");

  const flagged: FlaggedPeriodSentence[] = [];
  const seenSentences = new Set<string>();

  function checkRe(re: RegExp, buildReason: (match: string) => string): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawText)) !== null) {
      const term = m[1] ?? m[0];
      const sentence = periodGetSentence(rawText, m.index);
      const key = sentence.slice(0, 100);
      if (!seenSentences.has(key)) {
        seenSentences.add(key);
        flagged.push({ sentence, termMentioned: term, reason: buildReason(term) });
      }
    }
  }

  // "in/during/for [Month]" within 120 chars of a numeric token
  const inMonthRe = new RegExp(
    `\\b(?:in|during|for)\\s+(${MONTH_LIST})\\b[^.]{0,120}(?:\\d|Rs\\.?|₹)`,
    "gi",
  );
  checkRe(inMonthRe, (t) =>
    `"in ${t}" in a YTD report may imply a single-month figure; payload covers April to cutoff month cumulatively.`,
  );

  // "[Month] saw" within 120 chars of a numeric token
  const sawRe = new RegExp(
    `\\b(${MONTH_LIST})\\s+saw\\b[^.]{0,120}(?:\\d|Rs\\.?|₹)`,
    "gi",
  );
  checkRe(sawRe, (t) =>
    `"${t} saw" in a YTD report may imply a single-month figure; payload is cumulative.`,
  );

  // "Q1/Q2/Q3/Q4" within 80 chars of a number — only flag if the period spans
  // more than one quarter (toFiscalMonth > 3).
  if (toFiscalMonth > 3) {
    const qRe = /\b(Q[1-4])\b[^.]{0,80}(?:\d|Rs\.?|₹)/gi;
    checkRe(qRe, (t) =>
      `"${t}" in a multi-quarter YTD report may imply a single-quarter figure; payload covers April to cutoff month cumulatively.`,
    );
  }

  return {
    status: flagged.length === 0 ? "ok" : "requires_review",
    flagged,
  };
}
