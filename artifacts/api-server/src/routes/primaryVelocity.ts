// GET /primary-performance/velocity?fy=2026-27
//
// Intra-month order-booking pace for the CURRENT open month.
// Scores each state head against the company pacing curve (FY2025-26 derived),
// with a confidence band.  Only fires "Behind" when below the band's LOW edge.
// Before day 15 all heads are "too_early" — no Behind flags.
//
// Returns JSON including per-head sparklines (daily amounts) and momentum
// (last-3-days vs prior-3-days rate).
import { Router, type Request, type Response } from "express";
import { db, primaryStateTargets } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { resolveHeadKey } from "../lib/mgmt/names.js";
import { loadVelocityDailyBooking } from "../lib/mgmt/velocityReader.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import pacingConfig from "../../config/pacing_curve.json";

const router = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;

// HP is new territory — near-zero is expected, never flag as behind.
const NEW_TERRITORY_HEADS = new Set(["sulinderpal"]);

// ── Curve interpolation ───────────────────────────────────────────────────────

type CurvePoint = { day: number; cumPct: number; bandLow: number; bandHigh: number };

function interpolateCurve(
  anchors: CurvePoint[],
  effectiveDay: number,
): { cumPct: number; bandLow: number; bandHigh: number } {
  if (effectiveDay <= anchors[0].day) return anchors[0];
  const last = anchors[anchors.length - 1];
  if (effectiveDay >= last.day) return last;
  for (let i = 1; i < anchors.length; i++) {
    if (effectiveDay <= anchors[i].day) {
      const a = anchors[i - 1];
      const b = anchors[i];
      const t = (effectiveDay - a.day) / (b.day - a.day);
      return {
        cumPct:   a.cumPct   + t * (b.cumPct   - a.cumPct),
        bandLow:  a.bandLow  + t * (b.bandLow  - a.bandLow),
        bandHigh: a.bandHigh + t * (b.bandHigh - a.bandHigh),
      };
    }
  }
  return last;
}

// Head's own typical pace, interpolated from the 4 config anchors.
// Anchors: (0,0), (15, d15), (20, d20), (25, d25), (28, d28), (31, 100).
type HeadPace = { d15: number; d20: number; d25: number; d28: number };

function interpolateHeadTypical(pace: HeadPace, effectiveDay: number): number {
  const anchors = [
    { day: 0, pct: 0 },
    { day: 15, pct: pace.d15 },
    { day: 20, pct: pace.d20 },
    { day: 25, pct: pace.d25 },
    { day: 28, pct: pace.d28 },
    { day: 31, pct: 100 },
  ];
  if (effectiveDay <= 0) return 0;
  if (effectiveDay >= 31) return 100;
  for (let i = 1; i < anchors.length; i++) {
    if (effectiveDay <= anchors[i].day) {
      const a = anchors[i - 1];
      const b = anchors[i];
      const t = (effectiveDay - a.day) / (b.day - a.day);
      return a.pct + t * (b.pct - a.pct);
    }
  }
  return 100;
}

// ── Days in month helper ──────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number): number {
  // month: 0-based
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// ── Month label from calendar month (0-based) + FY ───────────────────────────

const MONTH_ABBRS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];
const MONTH_FULL = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function monthLabelFromCal(calMonth: number, fy: string): string {
  const abbr = MONTH_ABBRS[calMonth];
  const fyStart = Number(fy.slice(2, 4)); // "26" from "2026-27"
  const fyEnd   = Number(fy.slice(5, 7)); // "27"
  const lateMonths = new Set(["Jan","Feb","Mar"]);
  const yr = lateMonths.has(abbr) ? fyEnd : fyStart;
  return `${abbr}-${yr}`;
}

// ── Derived-target months (Apr, May = seasonal estimate) ─────────────────────

const DERIVED_MONTHS = new Set(["Apr-26", "May-26"]);

// ── Status scoring ────────────────────────────────────────────────────────────

type Status = "too_early" | "on_pace" | "ahead" | "behind";

function scoreStatus(
  dayOfMonth: number,
  actualPct: number,
  bandLow: number,
  bandHigh: number,
  isNewTerritory: boolean,
): Status {
  if (dayOfMonth < 15) return "too_early";
  if (isNewTerritory) return "on_pace"; // HP: never flag behind
  if (actualPct > bandHigh) return "ahead";
  if (actualPct < bandLow) return "behind";
  return "on_pace";
}

// ── Momentum ──────────────────────────────────────────────────────────────────

type Momentum = "building" | "stalling" | "steady" | "early";

function scoreMomentum(sparkline: number[], dayOfMonth: number): Momentum {
  if (dayOfMonth < 6) return "early";
  const last3  = (sparkline[dayOfMonth - 1] ?? 0) +
                 (sparkline[dayOfMonth - 2] ?? 0) +
                 (sparkline[dayOfMonth - 3] ?? 0);
  const prior3 = (sparkline[dayOfMonth - 4] ?? 0) +
                 (sparkline[dayOfMonth - 5] ?? 0) +
                 (sparkline[dayOfMonth - 6] ?? 0);
  if (prior3 <= 0) return last3 > 0 ? "building" : "early";
  const ratio = last3 / prior3;
  if (ratio > 1.15) return "building";
  if (ratio < 0.75 && dayOfMonth >= 20) return "stalling";
  return "steady";
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get(
  "/primary-performance/velocity",
  async (req: Request, res: Response): Promise<void> => {
    const fy =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : "2026-27";

    // Current date (server time)
    const now    = new Date();
    const todayY = now.getUTCFullYear();
    const todayM = now.getUTCMonth(); // 0-based
    const todayD = now.getUTCDate();

    // Determine if today's month is within the given FY.
    // FY "2026-27": Apr 2026 .. Mar 2027
    const fyStartYear = Number(fy.slice(0, 4));
    const fyStartMs   = Date.UTC(fyStartYear, 3, 1);    // Apr 1
    const fyEndMs     = Date.UTC(fyStartYear + 1, 2, 31, 23, 59, 59, 999); // Mar 31
    const todayMs     = now.getTime();

    if (todayMs < fyStartMs || todayMs > fyEndMs) {
      res.json({
        fy,
        month: null,
        isEarlyMonth: false,
        targetDerived: false,
        dayOfMonth: 0,
        daysInMonth: 0,
        effectiveDay: 0,
        expectedPct: 0,
        bandLow: 0,
        bandHigh: 0,
        company: null,
        heads: [],
        dataError: `Today is outside FY ${fy}. Velocity is only for the current open month.`,
        asOf: now.toISOString(),
      });
      return;
    }

    try {
      const calMonth     = todayM;
      const calYear      = todayY;
      const dayOfMonth   = todayD;
      const daysInMonth  = getDaysInMonth(calYear, calMonth);
      const monthLabel   = monthLabelFromCal(calMonth, fy);
      const monthFullStr = `${MONTH_FULL[calMonth]} ${calYear}`;

      // Scale day-of-month to a 31-day equivalent for the curve lookup.
      const effectiveDay = Math.round((dayOfMonth / daysInMonth) * 31);

      const curve = interpolateCurve(
        pacingConfig.companyCurve as CurvePoint[],
        effectiveDay,
      );

      const isEarlyMonth  = dayOfMonth < 15;
      const targetDerived = DERIVED_MONTHS.has(monthLabel);

      // 1. Load DB targets for the current month, summed by state_head.
      const dbRows = await db
        .select()
        .from(primaryStateTargets)
        .where(
          and(
            eq(primaryStateTargets.fy, fy),
            eq(primaryStateTargets.monthLabel, monthLabel),
          ),
        );

      // Group by stateHead display name -> {targetLakh, source}
      const targetByDisplay = new Map<string, { targetLakh: number; source: string }>();
      for (const row of dbRows) {
        const existing = targetByDisplay.get(row.stateHead) ?? { targetLakh: 0, source: row.source };
        existing.targetLakh += row.targetLakh;
        targetByDisplay.set(row.stateHead, existing);
      }

      // Build headKey -> {displayName, targetLakh, source}
      type HeadTarget = { displayName: string; targetLakh: number; source: string };
      const targetByKey = new Map<string, HeadTarget>();
      for (const [displayName, t] of targetByDisplay) {
        const hKey = resolveHeadKey(displayName);
        if (hKey) targetByKey.set(hKey, { displayName, ...t });
      }

      // 2. Load daily order-booking actuals.
      const bookingResult = await loadVelocityDailyBooking(calMonth, calYear);

      // 3. Build sparkline array (length = daysInMonth, 0-indexed by day-1).
      // Merge actual booking from sheet with DB target map.
      // Union of all head keys from both sources (target may have heads not in booking yet).
      const allHeadKeys = new Set([
        ...targetByKey.keys(),
        ...bookingResult.totalByHead.keys(),
      ]);

      const headTypicalPace = pacingConfig.headTypicalPace as Record<string, HeadPace>;

      type VelocityHeadRow = {
        stateHead: string;
        headKey: string;
        targetLakh: number;
        targetDerived: boolean;
        actualLakh: number;
        actualPct: number;
        expectedPct: number;
        bandLow: number;
        bandHigh: number;
        typicalPctToday: number;
        typicalPctRef: HeadPace | null;
        status: Status;
        momentum: Momentum;
        projectedClosePct: number | null;
        sparkline: number[];
        isNewTerritory: boolean;
        hasDateData: boolean;
      };

      const headRows: VelocityHeadRow[] = [];

      for (const hKey of allHeadKeys) {
        const target = targetByKey.get(hKey);
        if (!target) continue; // Only score heads that have a target
        if (target.targetLakh <= 0) continue;

        const totalRupees = bookingResult.totalByHead.get(hKey) ?? 0;
        const actualLakh  = totalRupees / 1e5; // rupees -> lakh
        const actualPct   = (actualLakh / target.targetLakh) * 100;

        const isNewTerritory = NEW_TERRITORY_HEADS.has(hKey);

        // Sparkline: array length = daysInMonth, index i = day (i+1)
        const sparkline = Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const dayMap = bookingResult.dailyByHead.get(hKey);
          return (dayMap?.get(day) ?? 0) / 1e5; // rupees -> lakh
        });

        const pace = headTypicalPace[hKey] ?? null;
        const typicalPctToday = pace ? interpolateHeadTypical(pace, effectiveDay) : -1;

        const status = scoreStatus(
          dayOfMonth,
          actualPct,
          curve.bandLow,
          curve.bandHigh,
          isNewTerritory,
        );

        const momentum = scoreMomentum(sparkline, dayOfMonth);

        // Projected close: only meaningful day 15+
        let projectedClosePct: number | null = null;
        if (!isEarlyMonth && curve.cumPct > 0) {
          projectedClosePct = Math.round((actualPct / (curve.cumPct / 100)) * 10) / 10;
        }

        headRows.push({
          stateHead: target.displayName,
          headKey: hKey,
          targetLakh: target.targetLakh,
          targetDerived,
          actualLakh: Math.round(actualLakh * 100) / 100,
          actualPct: Math.round(actualPct * 10) / 10,
          expectedPct: Math.round(curve.cumPct * 10) / 10,
          bandLow: Math.round(curve.bandLow * 10) / 10,
          bandHigh: Math.round(curve.bandHigh * 10) / 10,
          typicalPctToday: pace ? Math.round(typicalPctToday * 10) / 10 : -1,
          typicalPctRef: pace ?? null,
          status,
          momentum,
          projectedClosePct,
          sparkline: sparkline.map((v) => Math.round(v * 100) / 100),
          isNewTerritory,
          hasDateData: bookingResult.hasDateData,
        });
      }

      // Sort: Behind first, then On Pace / Too Early, then Ahead.
      const STATUS_ORDER: Record<Status, number> = {
        behind: 0, too_early: 1, on_pace: 2, ahead: 3,
      };
      headRows.sort((a, b) => {
        const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (so !== 0) return so;
        return a.actualPct - b.actualPct;
      });

      // Company summary
      const totalTargetLakh = headRows.reduce((s, h) => s + h.targetLakh, 0);
      const totalActualLakh = headRows.reduce((s, h) => s + h.actualLakh, 0);
      const companyActualPct = totalTargetLakh > 0
        ? Math.round((totalActualLakh / totalTargetLakh) * 1000) / 10
        : 0;
      const companyStatus = scoreStatus(
        dayOfMonth, companyActualPct, curve.bandLow, curve.bandHigh, false,
      );

      res.json({
        fy,
        month: monthLabel,
        monthFull: monthFullStr,
        dayOfMonth,
        daysInMonth,
        effectiveDay,
        expectedPct: Math.round(curve.cumPct * 10) / 10,
        bandLow: Math.round(curve.bandLow * 10) / 10,
        bandHigh: Math.round(curve.bandHigh * 10) / 10,
        isEarlyMonth,
        targetDerived,
        company: {
          targetLakh: Math.round(totalTargetLakh * 100) / 100,
          actualLakh: Math.round(totalActualLakh * 100) / 100,
          actualPct: companyActualPct,
          expectedPct: Math.round(curve.cumPct * 10) / 10,
          status: companyStatus,
        },
        heads: headRows,
        dataError: bookingResult.error,
        asOf: now.toISOString(),
      });
    } catch (err) {
      if (respondIfQuotaError(err, res)) return;
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "primaryVelocity: unhandled error");
      res.status(500).json({ error: msg });
    }
  },
);

export default router;
