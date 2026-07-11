// Static config for the FY2026-27 SAP primary-sales pipeline. Imported (not
// read from disk) so esbuild bundles it — cwd-relative reads 500 in production.
import sale2627 from "../../../config/sale2627.json";

export type SapConfig = {
  rateList: { spreadsheetId: string; itemTab: string; customerTab: string };
  benchmark: { fy: string; months: string[]; amount: number; tolerancePct: number };
  matchTargetPct: number;
  crossFootToleranceRupees: number;
};

export const sapConfig = sale2627 as SapConfig;

// The pipeline is scoped to a single fiscal year: the SAP export is the
// authoritative primary-sales source for FY2026-27 only. Other years keep
// their existing register source.
export const SAP_FY = sapConfig.benchmark.fy;
