/**
 * Retailer-count drift — Data tab typed count vs member working-sheet rows.
 *
 * The State Head Dashboard "Data" tab carries a TYPED retailer count per
 * member (maintained by the State Head); the member working sheet carries the
 * actual serial-numbered retailer rows. This module compares the two, per
 * member and per team, as a MAINTENANCE SIGNAL that belongs to the head:
 *
 *   - sheet > typed  → typed column is under-maintained (lagging behind
 *                      retailers the member has already recorded).
 *   - typed > sheet  → the head believes retailers exist that the member has
 *                      NOT recorded — a coverage gap in the opposite
 *                      direction, worth surfacing, not averaging away.
 *
 * Neither source is discarded: both counts are always returned.
 */

import { loadDeepDiveData, type MemberRef } from "./deepDiveData.js";
import { getMemberFileId } from "./memberSheet.js";
import { logger } from "../logger.js";

/** |typed − sheet| ≤ TOLERANCE counts as in-sync (routine churn). */
export const DRIFT_TOLERANCE = 3;

export type DriftDirection =
  | "IN_SYNC"                // within tolerance
  | "SHEET_EXCEEDS_TYPED"    // typed under-maintained
  | "TYPED_EXCEEDS_SHEET";   // possible unrecorded retailers

export type MemberDrift = {
  name: string;
  normKey: string;
  isLeft: boolean;
  status: "ok" | "loading" | "not-mapped" | "no-typed-count" | "error";
  typed: number | null;      // Data tab typed count (kept, never discarded)
  sheet: number | null;      // serial-numbered active rows in the member sheet
  drift: number | null;      // typed − sheet (negative = typed behind)
  direction: DriftDirection | null;
};

export type RetailerDriftReport = {
  fy: string;
  stateHead: string;
  tolerance: number;
  members: MemberDrift[];
  summary: {
    comparable: number;        // members with both counts
    pending: number;           // sheets still loading (retry later)
    notMapped: number;
    inSync: number;
    sheetExceedsTyped: number; // under-maintained typed entries
    typedExceedsSheet: number; // possible unrecorded retailers
    netDrift: number;          // Σ(typed − sheet) over comparable members
    typedTotal: number;
    sheetTotal: number;
  };
};

function classify(typed: number, sheet: number): DriftDirection {
  const d = typed - sheet;
  if (Math.abs(d) <= DRIFT_TOLERANCE) return "IN_SYNC";
  return d > 0 ? "TYPED_EXCEEDS_SHEET" : "SHEET_EXCEEDS_TYPED";
}

async function memberDrift(
  fy: string,
  ref: MemberRef,
): Promise<MemberDrift> {
  const base: Omit<MemberDrift, "status" | "typed" | "sheet" | "drift" | "direction"> = {
    name: ref.name,
    normKey: ref.normKey,
    isLeft: false,
  };

  if (!getMemberFileId(ref.normKey)) {
    return { ...base, status: "not-mapped", typed: null, sheet: null, drift: null, direction: null };
  }

  try {
    const data = await loadDeepDiveData(fy, ref.stateHead, ref.normKey);
    const typed = data.kpis?.totalRetailers ?? null;
    const isLeft = data.kpis?.isLeft ?? false;
    const rd = data.retailerDetail as
      | { status: string; rows?: unknown[] }
      | null;

    if (!rd || rd.status === "loading") {
      return { ...base, isLeft, status: "loading", typed, sheet: null, drift: null, direction: null };
    }
    if (rd.status !== "ok") {
      return { ...base, isLeft, status: "error", typed, sheet: null, drift: null, direction: null };
    }
    const sheet = (rd.rows ?? []).length;
    if (typed == null) {
      return { ...base, isLeft, status: "no-typed-count", typed, sheet, drift: null, direction: null };
    }
    return {
      ...base,
      isLeft,
      status: "ok",
      typed,
      sheet,
      drift: typed - sheet,
      direction: classify(typed, sheet),
    };
  } catch (err) {
    logger.warn({ err, fy, member: ref.normKey }, "retailerDrift: member load failed");
    return { ...base, status: "error", typed: null, sheet: null, drift: null, direction: null };
  }
}

/** Bounded-concurrency map — member sheet loads are Sheets-API heavy. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export async function loadRetailerDrift(fy: string, stateHead: string): Promise<RetailerDriftReport> {
  const head = await loadDeepDiveData(fy, stateHead, undefined);
  const refs = head.members;
  const members = await mapLimit(refs, 4, (ref) => memberDrift(fy, ref));

  const comparableRows = members.filter((m) => m.status === "ok");
  const summary = {
    comparable: comparableRows.length,
    pending: members.filter((m) => m.status === "loading").length,
    notMapped: members.filter((m) => m.status === "not-mapped").length,
    inSync: comparableRows.filter((m) => m.direction === "IN_SYNC").length,
    sheetExceedsTyped: comparableRows.filter((m) => m.direction === "SHEET_EXCEEDS_TYPED").length,
    typedExceedsSheet: comparableRows.filter((m) => m.direction === "TYPED_EXCEEDS_SHEET").length,
    netDrift: comparableRows.reduce((s, m) => s + (m.drift ?? 0), 0),
    typedTotal: comparableRows.reduce((s, m) => s + (m.typed ?? 0), 0),
    sheetTotal: comparableRows.reduce((s, m) => s + (m.sheet ?? 0), 0),
  };

  return { fy, stateHead, tolerance: DRIFT_TOLERANCE, members, summary };
}
