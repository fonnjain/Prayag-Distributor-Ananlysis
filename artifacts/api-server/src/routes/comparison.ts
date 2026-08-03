// ── C1 — POST /api/comparison ────────────────────────────────────────────────
// Contract layer only: selection schema in, basis block + guard report +
// value matrix out. Blocked comparisons return 422 with the reason.
// No rendering, no charts, no suggestions — those are C2 to C4.

import { Router, type Request, type Response } from "express";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  runComparison, ComparisonError, CATALOGUE_SUMMARY,
  type ComparisonResponse, type BlockedResponse,
} from "../lib/comparison/comparison.js";
import { loadDeepDiveData } from "../lib/mgmt/deepDiveData.js";
import { runCohort, CohortError, type CohortRequest } from "../lib/comparison/cohort.js";
import { fyForDate } from "../lib/mgmt/targetEngine.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── C2 — entity option lists for the selector UI ────────────────────────────
// Selection support only: names, no figures. Long lists (code/retailer) are
// searchable and capped.
router.get("/comparison/entities", async (req: Request, res: Response): Promise<void> => {
  const type = String(req.query.type ?? "");
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const like = `%${q}%`;
  const currentFy = fyForDate(new Date());
  try {
    switch (type) {
      case "company":
        res.json({ entities: ["company"] });
        return;
      case "head": {
        const dd = await loadDeepDiveData(currentFy, undefined, undefined, { skipExtras: true });
        res.json({ entities: dd.stateHeads });
        return;
      }
      case "member": {
        const dd = await loadDeepDiveData(currentFy, undefined, undefined, { skipExtras: true });
        res.json({
          entities: [...new Set(dd.members.map((m) => m.name))].sort(),
          // duplicate display names need context.stateHead — surface heads per name
          memberHeads: dd.members.map((m) => ({ name: m.name, stateHead: m.stateHead })),
        });
        return;
      }
      case "distributor": {
        const rows = await db.execute(sql`
          SELECT DISTINCT customer FROM sale_line_current
          WHERE customer IS NOT NULL AND customer <> ''
            ${q ? sql`AND lower(customer) LIKE ${like}` : sql``}
          ORDER BY customer LIMIT 500`);
        res.json({ entities: (rows.rows as { customer: string }[]).map((r) => r.customer), searchable: true });
        return;
      }
      case "segment": {
        const rows = await db.execute(sql`
          SELECT DISTINCT group_canon FROM sale_line_current
          WHERE group_canon IS NOT NULL AND group_canon <> ''
          ORDER BY group_canon`);
        res.json({ entities: (rows.rows as { group_canon: string }[]).map((r) => r.group_canon) });
        return;
      }
      case "code": {
        const rows = await db.execute(sql`
          SELECT DISTINCT code FROM sale_line_current
          WHERE code IS NOT NULL AND code <> ''
            ${q ? sql`AND lower(code) LIKE ${like}` : sql``}
          ORDER BY code LIMIT 200`);
        res.json({ entities: (rows.rows as { code: string }[]).map((r) => r.code), searchable: true });
        return;
      }
      case "retailer": {
        const rows = await db.execute(sql`
          SELECT DISTINCT customer FROM secondary_register_line
          WHERE customer IS NOT NULL AND customer <> ''
            ${q ? sql`AND lower(customer) LIKE ${like}` : sql``}
          ORDER BY customer LIMIT 200`);
        res.json({ entities: (rows.rows as { customer: string }[]).map((r) => r.customer), searchable: true });
        return;
      }
      default:
        res.status(400).json({ error: `unknown entity type '${type}'` });
        return;
    }
  } catch (err) {
    logger.error({ err }, "comparison entities failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/comparison/catalogue", (_req: Request, res: Response): void => {
  res.json(CATALOGUE_SUMMARY());
});

// ── Mode D: cohorts — a cohort is a RULE, not a hand-picked list ─────────────
// Cold builds (company-wide Sheets loads) can take minutes — far past the dev/prod
// proxy timeout. So the build runs detached from the request: the first request
// kicks it off and any request still waiting after SYNC_WAIT_MS gets a 202
// {building:true} JSON the client can poll, instead of a proxy 502 HTML page.
const cohortBuilds = new Map<string, Promise<unknown>>();
const cohortCache = new Map<string, { at: number; result: unknown }>();
const COHORT_CACHE_TTL_MS = 10 * 60 * 1000;
const COHORT_CACHE_MAX = 40;
const COHORT_SYNC_WAIT_MS = 45_000;
const COHORT_RULES = new Set(["assignment", "achievementBand", "distributorTier", "customerStatus", "segmentSeason", "sheetMapped"]);
const COHORT_CHANNELS = new Set(["territory", "project", "all"]);

router.post("/comparison/cohort", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as CohortRequest;
  // Validate BEFORE keying — request-controlled junk must not mint cache entries.
  if (!COHORT_RULES.has(body.rule as string)) {
    res.status(400).json({ error: `unknown rule '${String(body.rule)}' — valid: ${[...COHORT_RULES].join(", ")}` });
    return;
  }
  if (body.channel != null && !COHORT_CHANNELS.has(body.channel)) {
    res.status(400).json({ error: `unknown channel '${String(body.channel)}'` });
    return;
  }
  if (body.fy != null && !/^\d{4}-\d{2}$/.test(body.fy)) {
    res.status(400).json({ error: `fy must look like '2026-27', got '${String(body.fy)}'` });
    return;
  }
  if (body.band != null && (typeof body.band !== "number" || !(body.band > 0 && body.band < 1))) {
    res.status(400).json({ error: "band must be a number strictly between 0 and 1" });
    return;
  }
  const key = JSON.stringify([body.rule, body.band ?? null, body.fy ?? null, body.channel ?? null]);
  try {
    const cached = cohortCache.get(key);
    if (cached && Date.now() - cached.at < COHORT_CACHE_TTL_MS) {
      res.json(cached.result);
      return;
    }
    let build = cohortBuilds.get(key);
    if (!build) {
      build = runCohort(body)
        .then((result) => {
          // evict expired entries, then oldest, to keep the cache bounded
          const now = Date.now();
          for (const [k, v] of cohortCache) if (now - v.at >= COHORT_CACHE_TTL_MS) cohortCache.delete(k);
          while (cohortCache.size >= COHORT_CACHE_MAX) {
            const oldest = cohortCache.keys().next().value;
            if (oldest == null) break;
            cohortCache.delete(oldest);
          }
          cohortCache.set(key, { at: now, result });
          return result;
        })
        .finally(() => cohortBuilds.delete(key));
      cohortBuilds.set(key, build);
      build.catch(() => {}); // avoid unhandled rejection when all waiters time out
    }
    const timeout = new Promise<typeof STILL_BUILDING>((resolve) =>
      setTimeout(() => resolve(STILL_BUILDING), COHORT_SYNC_WAIT_MS).unref?.());
    const outcome = await Promise.race([build, timeout]);
    if (outcome === STILL_BUILDING) {
      res.status(202).json({ building: true, retryAfter: 20, note: "cohort build in progress — figures are being assembled from the working sheets; retry shortly" });
      return;
    }
    res.json(outcome);
  } catch (err) {
    if (err instanceof CohortError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "cohort failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "cohort failed" });
  }
});
const STILL_BUILDING = Symbol("cohort-still-building");

router.post("/comparison", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await runComparison(req.body ?? {});
    if (result.blocked) {
      res.status(422).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    if (err instanceof ComparisonError) {
      res.status(err.status).json({ error: err.message, detail: err.detail ?? null });
      return;
    }
    logger.error({ err }, "comparison failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── C2 — Excel export ────────────────────────────────────────────────────────
// Renders exactly what runComparison returns. Every sheet carries the full
// basis strip — a figure must never leave this page without its basis.
const MAX_CONCURRENT_COMPARISON_EXPORTS = 2;
let activeComparisonExports = 0;

function guardLine(g: { id: number; name: string; status: string; detail: string | null }): string {
  return `Guard ${g.id} ${g.name}: ${g.status}${g.detail ? ` — ${g.detail}` : ""}`;
}

/** Compact full-basis header written on top of every figure-bearing sheet —
 *  a figure must never leave the page without its complete basis. */
function basisHeaderLines(result: ComparisonResponse | BlockedResponse): string[] {
  const b = result.basis;
  const lines: string[] = [];
  if (b.channelLabel) lines.push(b.channelLabel);
  lines.push([
    b.entityType ? `entity: ${b.entityType}` : null,
    b.basis ? `basis: ${b.basis}` : null,
    b.population ? `population: ${b.population}` : null,
    b.normalise ? `normalise: ${b.normalise}` : null,
  ].filter(Boolean).join(" · "));
  if (b.periods?.length) lines.push("Periods: " + b.periods.map((p) => `${p.label} [${p.completeness}]`).join("; "));
  if (b.sources && Object.keys(b.sources).length) lines.push("Sources: " + Object.entries(b.sources).map(([m, s]) => `${m} ← ${s}`).join("; "));
  lines.push("Guards: " + result.guards.map((g) => `G${g.id} ${g.name}=${g.status}`).join("; "));
  const fired = result.guards.filter((g) => g.status === "annotated" || g.status === "blocked");
  for (const g of fired) lines.push(guardLine(g));
  return lines;
}

function writeBasisHeader(ws: ExcelJS.Worksheet, result: ComparisonResponse | BlockedResponse): void {
  for (const line of basisHeaderLines(result)) {
    const r = ws.addRow([line]);
    r.font = { bold: line === result.basis.channelLabel, size: 9 };
    r.getCell(1).alignment = { wrapText: true };
  }
  ws.addRow([]);
}

function addBasisSheet(wb: ExcelJS.Workbook, result: ComparisonResponse | BlockedResponse): void {
  const ws = wb.addWorksheet("Basis");
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 110;
  const add = (k: string, v: string) => {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true };
  };
  if (result.blocked) {
    add("RESULT", "BLOCKED — this comparison would mislead. Reason below. A refusal is a result, not an error.");
    add("Reason", result.reason);
  }
  const b = result.basis;
  if (b.channelLabel) add("CHANNEL", b.channelLabel);
  if (b.entityType) add("Entity type", String(b.entityType));
  if (b.basis) add("Basis", String(b.basis));
  if (b.population) add("Population", String(b.population));
  if (b.normalise) add("Normalise", String(b.normalise));
  for (const p of b.periods ?? []) add("Period", `${p.label} — ${p.completeness} (${p.months.join(", ") || "no months with data"})`);
  for (const [m, s] of Object.entries(b.sources ?? {})) add("Source", `${m} ← ${s}`);
  for (const g of result.guards) add("Guard", guardLine(g));
  if (!result.blocked) for (const n of result.notes) add("Note", n);
}

router.post("/comparison/export", async (req: Request, res: Response): Promise<void> => {
  if (activeComparisonExports >= MAX_CONCURRENT_COMPARISON_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeComparisonExports++;
  try {
    const result = await runComparison(req.body ?? {});
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();
    addBasisSheet(wb, result);

    if (!result.blocked) {
      const ws = wb.addWorksheet("Comparison");
      const periodLabels = result.basis.periods.map((p) => `${p.label} [${p.completeness}]`);
      const hasTrend = result.matrix.some((row) => row.trend);
      const header = ["Entity", "Measure", "Source", ...periodLabels, ...(hasTrend ? ["Level (latest)", "Direction (slope, complete periods only)"] : [])];
      writeBasisHeader(ws, result);
      const hr = ws.addRow(header);
      hr.font = { bold: true };
      for (const row of result.matrix) {
        const cells = row.cells.map((c) => {
          if (c.suppressed) return `SUPPRESSED — ${c.note ?? "guard"}`;
          if (c.value == null) return c.note ?? "not recorded yet";
          let out = String(c.value);
          if (c.real != null) out += ` (real: ${c.real}, index: ${c.realIndexName ?? "?"})`;
          else if (c.note) out += ` — ${c.note}`;
          return out;
        });
        const trendCols = hasTrend
          ? [
              row.trend?.level == null ? "" : `${row.trend.level}${row.trend.levelIsPartial ? " (partial period)" : ""}`,
              row.trend?.direction == null ? (row.trend?.directionBasis ?? "") : `${row.trend.direction} — ${row.trend.directionBasis ?? ""}`,
            ]
          : [];
        const r = ws.addRow([row.entity, row.measureLabel, row.source ?? "", ...cells, ...trendCols]);
        if (row.excludeFromRanking) r.font = { italic: true };
      }
      ws.getColumn(1).width = 26; ws.getColumn(2).width = 34; ws.getColumn(3).width = 18;
      for (let i = 4; i < header.length + 1; i++) ws.getColumn(i).width = 34;
      if (result.quadrants?.length) {
        const qs = wb.addWorksheet("Quadrants");
        writeBasisHeader(qs, result);
        for (const q of result.quadrants) {
          qs.addRow([`${q.measureLabel} — ${q.splitRule} (split at ${q.levelSplit})`]).font = { bold: true };
          qs.addRow(["Quadrant", "Entity", "Level", "Direction"]).font = { bold: true };
          for (const g of q.groups) for (const e of g.entities) qs.addRow([g.label, e.entity, e.level, e.direction]);
          for (const nd of q.noDirection) qs.addRow(["no direction", nd.entity, "", nd.reason]);
          qs.addRow([]);
        }
        qs.getColumn(1).width = 44; qs.getColumn(2).width = 26; qs.getColumn(4).width = 60;
      }
      if (result.rosterChanges?.length) {
        const rs = wb.addWorksheet("Roster changes");
        writeBasisHeader(rs, result);
        rs.addRow(["Entity", "From FY", "To FY", "Joiners", "Leavers", "Note"]).font = { bold: true };
        for (const rc of result.rosterChanges) rs.addRow([rc.entity, rc.fromFy, rc.toFy, rc.joiners.join(", "), rc.leavers.join(", "), rc.note]);
        rs.getColumn(1).width = 22; rs.getColumn(4).width = 40; rs.getColumn(5).width = 40; rs.getColumn(6).width = 60;
      }
      if (result.likeForLike?.length) {
        const lf = wb.addWorksheet("Like-for-like");
        writeBasisHeader(lf, result);
        lf.addRow(["Entity", "Headline achievement %", "Like-for-like achievement %", "Untargeted members"]).font = { bold: true };
        for (const l of result.likeForLike) lf.addRow([l.entity, l.headlineAchievement, l.likeForLikeAchievement, l.untargetedMembers.join(", ")]);
        lf.getColumn(1).width = 26; lf.getColumn(2).width = 24; lf.getColumn(3).width = 26; lf.getColumn(4).width = 60;
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Comparison_${date}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (err instanceof ComparisonError) {
      res.status(err.status).json({ error: err.message, detail: err.detail ?? null });
      return;
    }
    logger.error({ err }, "comparison export failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeComparisonExports--;
  }
});

export default router;
