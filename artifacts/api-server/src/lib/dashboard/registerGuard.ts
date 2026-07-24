// Pure functions for the register completeness guard.  No I/O, no logging,
// no DB access — all inputs are passed in, so every branch is unit-testable
// with synthetic values.

export const CLOSED_FY_MONTHS_REQUIRED = 12;
export const MAGNITUDE_TOLERANCE_PCT = 2;

export interface RegisterGuardParams {
  fy: string;
  dbTotalInr: number;
  rowCount: number;
  monthCount: number;
  sheetTotalInr: number;
  minRowCount: number;
  closedFyMonthsRequired?: number;
  magnitudeTolerancePct?: number;
}

export interface RegisterGuardResult {
  passed: boolean;
  source: "db" | "sheet";
  rejectionReason?: string;
  dbTotalInr: number;
  sheetTotalInr: number;
  rowCount: number;
  monthCount: number;
  deviationPct: number;
}

export function checkRegisterGuard(p: RegisterGuardParams): RegisterGuardResult {
  const moReq = p.closedFyMonthsRequired ?? CLOSED_FY_MONTHS_REQUIRED;
  const tolPct = p.magnitudeTolerancePct ?? MAGNITUDE_TOLERANCE_PCT;
  const devPct =
    (Math.abs(p.dbTotalInr - p.sheetTotalInr) / p.sheetTotalInr) * 100;
  const base: Omit<RegisterGuardResult, "passed" | "source" | "rejectionReason"> = {
    dbTotalInr: p.dbTotalInr,
    sheetTotalInr: p.sheetTotalInr,
    rowCount: p.rowCount,
    monthCount: p.monthCount,
    deviationPct: devPct,
  };

  if (p.monthCount < moReq) {
    return {
      ...base,
      passed: false,
      source: "sheet",
      rejectionReason: `FY${p.fy}: ${p.monthCount}/${moReq} months present — incomplete register rejected`,
    };
  }

  if (devPct > tolPct) {
    return {
      ...base,
      passed: false,
      source: "sheet",
      rejectionReason:
        `FY${p.fy}: deviation ${devPct.toFixed(1)}% exceeds ${tolPct}% tolerance` +
        ` — db=${p.dbTotalInr}, sheet=${p.sheetTotalInr}`,
    };
  }

  if (p.rowCount < p.minRowCount) {
    return {
      ...base,
      passed: false,
      source: "sheet",
      rejectionReason: `FY${p.fy}: row count ${p.rowCount} is below anchor ${p.minRowCount}`,
    };
  }

  return { ...base, passed: true, source: "db" };
}

// Pure staleness check: given what was stored in the snapshot manifest and the
// current row count from the DB, returns true if the snapshot is stale.
// source === "sheet" snapshots are never considered stale (guard had already
// fallen back at build time; the current DB state may have since recovered,
// but that is caught on the next scheduled sync — not on serve).
export function isSnapshotStale(
  storedGuard: RegisterGuardResult | undefined | null,
  currentRowCount: number,
  minRowCount: number,
): boolean {
  if (!storedGuard || storedGuard.source !== "db") return false;
  return currentRowCount < minRowCount;
}
