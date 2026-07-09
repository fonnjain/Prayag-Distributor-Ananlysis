// Management Reports: filter options + Excel generation.
import { Router, type IRouter, type Request, type Response } from "express";
import { loadRoster, mgmtSources } from "../lib/mgmt/roster.js";
import { resolveOrderFileId } from "../lib/mgmt/orders.js";
import {
  buildManagementWorkbook,
  regionMap,
  type ReportFilters,
} from "../lib/mgmt/report.js";
import { loadTargetsForFy } from "../lib/mgmt/targets.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";

// The Target Master sheet is provisioned and writable; the status reflects
// whether any targets have actually been saved for the default FY yet.
async function targetsSource(req: Request): Promise<{
  key: string;
  name: string;
  status: string;
  detail: string;
}> {
  try {
    const map = await loadTargetsForFy(DEFAULT_FY);
    if (map.size > 0) {
      return {
        key: "targets",
        name: "Targets and business plans",
        status: "connected",
        detail: `${map.size} member target${map.size === 1 ? "" : "s"} saved in the Prayag Target Master sheet for ${DEFAULT_FY}. Achievement % columns fill from these.`,
      };
    }
    return {
      key: "targets",
      name: "Targets and business plans",
      status: "partial",
      detail:
        "The Prayag Target Master sheet is connected but has no saved targets for the current year yet. Set them in the Targets tab.",
    };
  } catch (err) {
    req.log.warn({ err }, "target master status check failed");
    return {
      key: "targets",
      name: "Targets and business plans",
      status: "missing",
      detail:
        "The Prayag Target Master sheet could not be read. Target and achievement % columns stay blank until it is reachable.",
    };
  }
}

router.get("/mgmt/options", async (req: Request, res: Response): Promise<void> => {
  try {
    const roster = await loadRoster();
    const cfg = mgmtSources();
    const fys = Object.keys(cfg.secondary_order_booking.files_by_year).sort().reverse();
    const states = [...new Set(roster.members.map((m) => m.state).filter(Boolean))].sort();
    const currentFyFile = await resolveOrderFileId(DEFAULT_FY);
    const sources = [
      {
        key: "roster",
        name: "Team member roster",
        status: roster.source === "hr_roster" ? "connected" : "partial",
        detail:
          roster.source === "hr_roster"
            ? `${roster.members.length} team members from the HR roster workbook`
            : `${roster.members.length} team members. The Team Member Details (HR) file is not shared with the connected Google account yet, so the roster comes from the live STATE HEAD DASHBOARD identity columns.`,
      },
      {
        key: "orders",
        name: "Secondary order booking",
        status: currentFyFile ? "connected" : "partial",
        detail: currentFyFile
          ? "Order booking workbooks found for the selected years."
          : "No 2026-27 order booking workbook exists in Drive yet; 2026-27 order columns will be blank until it is created. Earlier years (2021-22 to 2025-26) are connected.",
      },
      await targetsSource(req),
      {
        key: "sfa",
        name: "Field visits (SFA)",
        status: "missing",
        detail:
          "Visits, working days, GPS kilometres, and lead-counter columns stay blank until the SFA export is connected.",
      },
      {
        key: "payroll",
        name: "CTC and expenses",
        status: "missing",
        detail:
          "CTC, T.A. bill, and cost-ratio columns stay blank until payroll and expense sheets are connected.",
      },
    ];
    const regions = Object.entries(regionMap()).map(([name, sts]) => ({
      name,
      states: sts,
    }));
    res.json({ fys, defaultFy: DEFAULT_FY, regions, states, sources });
  } catch (err) {
    req.log.error({ err }, "mgmt options failed");
    res.status(500).json({ error: "Could not load report options." });
  }
});

router.post("/mgmt/report", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fy = typeof body.fy === "string" && body.fy.trim() !== "" ? body.fy.trim() : DEFAULT_FY;
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const intIn = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === "number" ? Math.round(v) : NaN;
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const filters: ReportFilters = {
    fy,
    states: strArr(body.states),
    regions: strArr(body.regions),
    monthFrom: intIn(body.monthFrom, 1, 12, 1),
    monthTo: intIn(body.monthTo, 1, 12, 12),
    lowPerfPct: intIn(body.lowPerfPct, 1, 100, 60),
  };
  if (filters.monthFrom > filters.monthTo) {
    res.status(400).json({ error: "monthFrom must not be after monthTo" });
    return;
  }
  const knownRegions = new Set(Object.keys(regionMap()));
  const badRegion = filters.regions.find((r) => !knownRegions.has(r));
  if (badRegion) {
    res.status(400).json({ error: `Unknown region: ${badRegion}` });
    return;
  }
  try {
    const started = Date.now();
    const { workbook, memberCount } = await buildManagementWorkbook(filters);
    if (memberCount === 0) {
      res.status(422).json({
        error:
          "No team members match the selected filters. Widen the state or region selection.",
      });
      return;
    }
    const scope =
      filters.regions.length > 0
        ? filters.regions.join("-")
        : filters.states.length > 0
          ? "Custom"
          : "All";
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `StateHeadDashboard_${fy}_${scope}_${stamp}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
    req.log.info(
      { fy, scope, memberCount, ms: Date.now() - started },
      "management report generated",
    );
  } catch (err) {
    req.log.error({ err, fy }, "management report failed");
    if (!res.headersSent) {
      res.status(500).json({
        error:
          "Could not generate the report. Google Sheets may be rate-limiting reads; try again in a minute.",
      });
    } else {
      res.end();
    }
  }
});

export default router;
