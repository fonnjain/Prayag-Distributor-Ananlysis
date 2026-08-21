/**
 * Employee codes are roster evidence, not person identity.
 *
 * A code may belong to more than one real person. Callers must handle all
 * candidates and may use `unique` only after this resolver has established
 * that exactly one candidate exists.
 */

export type EmployeeCodeResolution<T> =
  | { status: "none"; code: string | null; candidates: [] }
  | { status: "unique"; code: string; candidates: [T]; unique: T }
  | { status: "ambiguous"; code: string; candidates: T[] };

export function normaliseEmployeeCode(value: string | null | undefined): string | null {
  const code = value?.trim() ?? "";
  return code || null;
}

export function resolveEmployeeCode<T>(
  employeeCode: string | null | undefined,
  candidates: Iterable<T>,
  getCandidateCode: (candidate: T) => string | null | undefined,
): EmployeeCodeResolution<T> {
  const code = normaliseEmployeeCode(employeeCode);
  if (!code) return { status: "none", code: null, candidates: [] };

  const matches = [...candidates].filter(
    (candidate) => normaliseEmployeeCode(getCandidateCode(candidate)) === code,
  );
  if (matches.length === 0) return { status: "none", code, candidates: [] };
  if (matches.length === 1) {
    return { status: "unique", code, candidates: [matches[0]!], unique: matches[0]! };
  }
  return { status: "ambiguous", code, candidates: matches };
}

/** Numeric registry keys are historical source aliases, never person identity. */
export function isLegacyNumericSourceKey(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Resolve an in-memory person key only when it has exactly one candidate.
 * Numeric keys are legacy source aliases, never current person identities,
 * even where today's source happens to expose a single candidate.
 */
export function resolveUniquePersonIdentityKey<T>(
  key: string | null | undefined,
  candidates: Iterable<T>,
  getKey: (candidate: T) => string | null | undefined,
): T | null {
  const identityKey = key?.trim() ?? "";
  if (!identityKey || isLegacyNumericSourceKey(identityKey)) return null;

  const matches = [...candidates].filter(
    (candidate) => (getKey(candidate)?.trim() ?? "") === identityKey,
  );
  return matches.length === 1 ? matches[0]! : null;
}