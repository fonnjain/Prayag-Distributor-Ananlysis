/**
 * Privileged-admin helpers for endpoints that mutate durable config files
 * (e.g. POST /registers/:fy/lock-month-anchor).
 *
 * Admin authority is granted by presenting the SESSION_SECRET env var as the
 * Bearer token. This is intentionally separate from the DB-backed API-key
 * system: any user can create a DB API key via POST /api/keys, so possession
 * of a DB key is not sufficient to authorise config mutations.
 *
 * SESSION_SECRET is already a strong random secret managed outside the
 * codebase; reusing it as the admin credential avoids adding a new secret.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Returns true iff `token` matches the SESSION_SECRET environment variable.
 * Uses a timing-safe comparison to prevent length-oracle attacks.
 * Returns false if SESSION_SECRET is unset (server misconfiguration safety).
 */
export function isAdminToken(token: string): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return false;
  // timingSafeEqual requires equal-length Buffers; a length mismatch is
  // safely rejected without timing leakage because secret length is not
  // sensitive (it is a fixed-length env var, not user-controlled data).
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * MONTH_NAMES for a fiscal year starting in April.
 * Index 0 = Apr (first month), index 11 = Mar (last month).
 */
const FY_START_MONTHS = new Set(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const FY_END_MONTHS = new Set(["Jan", "Feb", "Mar"]);

/**
 * Validates that a month label (e.g. "Jul-26") belongs to a fiscal year
 * (e.g. "2026-27").  Returns false for any malformed input.
 *
 * FY 2026-27 runs Apr-26 → Mar-27:
 *   - Apr/May/Jun/Jul/Aug/Sep/Oct/Nov/Dec with two-digit year 26 ✓
 *   - Jan/Feb/Mar with two-digit year 27 ✓
 */
export function isMonthInFy(month: string, fy: string): boolean {
  const fyMatch = fy.match(/^(\d{4})-(\d{2})$/);
  if (!fyMatch) return false;
  const startShort = parseInt(fyMatch[1].slice(2), 10); // "2026" → 26
  const endShort = parseInt(fyMatch[2], 10);             // "27"   → 27

  const mMatch = month.match(/^([A-Z][a-z]{2})-(\d{2})$/);
  if (!mMatch) return false;
  const mName = mMatch[1];
  const mYear = parseInt(mMatch[2], 10);

  if (FY_START_MONTHS.has(mName) && mYear === startShort) return true;
  if (FY_END_MONTHS.has(mName) && mYear === endShort) return true;
  return false;
}
