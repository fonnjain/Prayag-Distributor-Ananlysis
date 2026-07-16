// GET /primary-targets/state-achievement?fy=2026-27&months=Apr-26,May-26,Jun-26,Jul-26
//
// Returns state-bifurcated primary order-booking targets with actuals from the
// Order Book FY2627 sheet.  Achievement = actual booking / target.
//
// State map: a target state name may correspond to one or more register STATE
// values in the order booking sheet (e.g. DELHI → DELHI A + DELHI NCR).
// HP is flagged as isNewTerritory; its achievement is expected to be ~0.
import { Router, type Request, type Response } from "express";
import { db, primaryStateTargets } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { resolveHeadKey } from "../lib/mgmt/names.js";
import { loadOrderBookByState } from "../lib/mgmt/orderBookByState.js";

const router = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;

// ── State map: target state → register state(s) in the order booking sheet ───
// Verified: 24 of 24 target states resolve against the live order booking register.
const STATE_REGISTER_MAP: Record<string, string[]> = {
  "W-BENGAL":      ["W-BENGAL"],
  "BIHAR":         ["BIHAR"],
  "JHARKHAND":     ["JHARKHAND"],
  "ODISHA":        ["ODISHA"],
  "ASSAM":         ["ASSAM"],
  "AP":            ["AP"],
  "Telangana":     ["Telangana"],
  "UP(R)":         ["UP ( R )"],
  "MP":            ["MP"],
  "MAHARASTRA R":  ["MAHARASTRA R"],
  "Chhattisgarh":  ["Chhattisgarh"],
  "MAHARASTRA L":  ["MAHARASTRA L"],
  "Goa":           ["Goa"],
  "Rajasthan":     ["Rajasthan"],
  "Haryana":       ["Haryana"],
  "Uttarakhand":   ["Uttarakhand"],
  "DELHI":         ["DELHI A", "DELHI NCR"],  // sum of two register states
  "UP(A)":         ["UP ( A )"],
  "Tamilnadu":     ["Tamilnadu"],
  "Karnataka":     ["Karnataka (B)"],
  "Kerala":        ["Kerala"],
  "PUNJAB":        ["PUNJAB"],
  "HP":            ["HP"],                    // new territory — actual ~0
  "KASHMIR":       ["KASHMIR"],
  "Gujarat":       ["Gujarat"],
};

// States with no established order-booking history — not an error, not underperformance.
const NEW_TERRITORY_STATES = new Set(["HP"]);

// ── Types ────────────────────────────────────────────────────────────────────

type MonthCell = {
  month: string;
  targetLakh: number;
  actualLakh: number;
  source: string;
};

type StateRow = {
  state: string;
  isNewTerritory: boolean;
  registerStates: string[];
  monthly: MonthCell[];
  totalTargetLakh: number;
  totalActualLakh: number;
  achievementPct: number | null;
};

type HeadBlock = {
  stateHead: string;
  states: StateRow[];
  totalTargetLakh: number;
  totalActualLakh: number;
  achievementPct: number | null;
};

// ── Route ────────────────────────────────────────────────────────────────────

router.get(
  "/primary-targets/state-achievement",
  async (req: Request, res: Response): Promise<void> => {
    const fy =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : "2026-27";

    const monthsParam =
      typeof req.query.months === "string" ? req.query.months.trim() : "";
    const requestedMonths = monthsParam
      ? monthsParam.split(",").map((m) => m.trim()).filter(Boolean)
      : [];

    try {
      // 1. Load targets from DB
      const dbRows = await db
        .select()
        .from(primaryStateTargets)
        .where(
          requestedMonths.length > 0
            ? and(
                eq(primaryStateTargets.fy, fy),
                inArray(primaryStateTargets.monthLabel, requestedMonths),
              )
            : eq(primaryStateTargets.fy, fy),
        )
        .orderBy(
          primaryStateTargets.stateHead,
          primaryStateTargets.state,
          primaryStateTargets.monthLabel,
        );

      if (dbRows.length === 0) {
        res.json({
          fy,
          months: [],
          rows: [],
          companyTotals: [],
          actualsAvailable: false,
          actualsError: "No state targets found in database for this FY.",
        });
        return;
      }

      // 2. Load order-booking actuals by (head, state, month) from the live sheet
      const bookingResult = await loadOrderBookByState().catch((err: unknown) => ({
        amounts: new Map<string, number>(),
        error: err instanceof Error ? err.message : String(err),
      }));
      const actualsAvailable = bookingResult.error === null;

      // 3. Collect distinct months in fiscal-calendar order (Apr → Mar), not alphabetical.
      // Month labels look like "Apr-26", "May-26", …, "Jan-27", "Feb-27", "Mar-27".
      const FISCAL_ABBR_ORDER = [
        "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
      ];
      function fiscalMonthRank(label: string): number {
        const abbr = label.slice(0, 3);
        const idx  = FISCAL_ABBR_ORDER.indexOf(abbr);
        return idx < 0 ? 99 : idx;
      }
      const allMonths = [...new Set(dbRows.map((r) => r.monthLabel))].sort(
        (a, b) => fiscalMonthRank(a) - fiscalMonthRank(b),
      );

      // 4. Group DB rows by head → state → month
      type MonthEntry = { targetLakh: number; source: string };
      const headMap = new Map<
        string,                                       // canonical head name (from DB)
        Map<string, Map<string, MonthEntry>>          // state → month → entry
      >();

      for (const row of dbRows) {
        if (!headMap.has(row.stateHead)) headMap.set(row.stateHead, new Map());
        const stateMap = headMap.get(row.stateHead)!;
        if (!stateMap.has(row.state)) stateMap.set(row.state, new Map());
        stateMap.get(row.state)!.set(row.monthLabel, {
          targetLakh: row.targetLakh,
          source: row.source,
        });
      }

      // 5. Build response blocks
      const headBlocks: HeadBlock[] = [];

      for (const [head, stateMap] of headMap) {
        // Canonical head key matches the key used in the order-booking reader
        const headKey = resolveHeadKey(head);
        const stateRows: StateRow[] = [];
        let headTargetSum = 0;
        let headActualSum = 0;

        for (const [state, monthMap] of stateMap) {
          const registerStates = STATE_REGISTER_MAP[state] ?? [state];
          const isNew = NEW_TERRITORY_STATES.has(state);
          const monthly: MonthCell[] = [];
          let stateTargetSum = 0;
          let stateActualSum = 0;

          for (const month of allMonths) {
            const cell = monthMap.get(month);
            if (!cell) continue;

            // Sum actuals across all register states that map to this target state
            let actualRupees = 0;
            for (const regState of registerStates) {
              actualRupees += bookingResult.amounts.get(`${headKey}|${regState}|${month}`) ?? 0;
            }
            const actualLakh = actualRupees / 1e5;

            monthly.push({
              month,
              targetLakh: cell.targetLakh,
              actualLakh: Math.round(actualLakh * 100) / 100,
              source: cell.source,
            });
            stateTargetSum += cell.targetLakh;
            stateActualSum += actualLakh;
          }

          if (monthly.length === 0) continue;

          headTargetSum += stateTargetSum;
          headActualSum += stateActualSum;

          stateRows.push({
            state,
            isNewTerritory: isNew,
            registerStates,
            monthly,
            totalTargetLakh: Math.round(stateTargetSum * 100) / 100,
            totalActualLakh: Math.round(stateActualSum * 100) / 100,
            achievementPct: isNew
              ? null
              : stateTargetSum > 0
                ? Math.round((stateActualSum / stateTargetSum) * 1000) / 10
                : null,
          });
        }

        headBlocks.push({
          stateHead: head,
          states: stateRows,
          totalTargetLakh: Math.round(headTargetSum * 100) / 100,
          totalActualLakh: Math.round(headActualSum * 100) / 100,
          achievementPct:
            headTargetSum > 0
              ? Math.round((headActualSum / headTargetSum) * 1000) / 10
              : null,
        });
      }

      // Sort by target descending
      headBlocks.sort((a, b) => b.totalTargetLakh - a.totalTargetLakh);

      // 6. Company totals per month
      const companyTotals = allMonths.map((month) => {
        const tgt = dbRows
          .filter((r) => r.monthLabel === month)
          .reduce((s, r) => s + r.targetLakh, 0);
        const act = headBlocks.reduce(
          (s, h) =>
            s +
            h.states.reduce((ss, st) => {
              const m = st.monthly.find((mm) => mm.month === month);
              return ss + (m?.actualLakh ?? 0);
            }, 0),
          0,
        );
        return {
          month,
          targetLakh: Math.round(tgt * 100) / 100,
          actualLakh: Math.round(act * 100) / 100,
          achievementPct: tgt > 0 ? Math.round((act / tgt) * 1000) / 10 : null,
        };
      });

      res.json({
        fy,
        months: allMonths,
        rows: headBlocks,
        companyTotals,
        actualsAvailable,
        actualsError: bookingResult.error,
      });
    } catch (err) {
      req.log.error({ err, fy }, "primary-targets/state-achievement failed");
      res.status(500).json({ error: "Could not load state achievement data." });
    }
  },
);

export default router;
