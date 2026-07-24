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
//   • n / 100_000  (lakh variant — used when Claude writes "18.35 lakh")
//   • n / 10_000_000  (crore variant — used when Claude writes "1.8 crore")

function collectLeaves(obj: unknown, out: number[]): void {
  if (typeof obj === "number" && isFinite(obj)) {
    out.push(obj);
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
    if (Math.abs(n) >= 50_000) allowed.push(n / 100_000);      // lakh
    if (Math.abs(n) >= 1_000_000) allowed.push(n / 10_000_000); // crore
  }
  return allowed;
}

// ── Text pre-processing ───────────────────────────────────────────────────────
// Neutralise fiscal-year tokens so "FY2026-27" doesn't inject 2026, 27 etc.

function preprocess(text: string): string {
  return text
    .replace(/\bFY\s*\d{4}-\d{2}\b/gi, "FYXX-XX")  // "FY2026-27"
    .replace(/\b\d{4}-\d{2}\b/g, "YYXX")            // "2026-27" bare
    .replace(/\b20\d{2}\b/g, "YYYY");               // standalone years 2000-2099
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
const NUM_RE =
  /(?:Rs\.?\s*|₹\s*)?(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(lakh|lakhs?|crores?|Cr|L)\b)?(\s*%)?/gi;

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
