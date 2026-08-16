/**
 * Match an alert code against a routing pattern.
 *
 * Supported patterns:
 *   '*'   — matches every code
 *   'A*'  — prefix wildcard (matches A1, A2, A3…)
 *   'B3'  — exact match
 */
export function matchesPattern(code: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return code.startsWith(pattern.slice(0, -1));
  }
  return code === pattern;
}
