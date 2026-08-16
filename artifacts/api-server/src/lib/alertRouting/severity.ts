import { pool } from "@workspace/db";
import { matchesPattern } from "./patterns.js";
import type { SeverityConfig } from "./types.js";

let _cache: SeverityConfig[] | null = null;

export async function getSeverityConfigs(): Promise<SeverityConfig[]> {
  if (_cache) return _cache;
  const { rows } = await pool.query<{
    code_pattern: string;
    is_severe: boolean;
    escalation_window_days: number;
  }>(
    `SELECT code_pattern, is_severe, escalation_window_days
     FROM alert_severity_config ORDER BY id`,
  );
  _cache = rows.map((r) => ({
    codePattern: r.code_pattern,
    isSevere: r.is_severe,
    escalationWindowDays: r.escalation_window_days,
  }));
  return _cache;
}

export function invalidateSeverityCache(): void {
  _cache = null;
}

/**
 * Return the most-specific severity config for a given alert code.
 * Priority: exact match > prefix wildcard > global wildcard.
 */
export async function getSeverityForCode(code: string): Promise<SeverityConfig> {
  const configs = await getSeverityConfigs();

  const exact = configs.find(
    (c) => !c.codePattern.includes("*") && matchesPattern(code, c.codePattern),
  );
  if (exact) return exact;

  const prefix = configs.find(
    (c) =>
      c.codePattern.endsWith("*") &&
      c.codePattern !== "*" &&
      matchesPattern(code, c.codePattern),
  );
  if (prefix) return prefix;

  const fallback = configs.find((c) => c.codePattern === "*");
  return fallback ?? { codePattern: "*", isSevere: false, escalationWindowDays: 14 };
}
