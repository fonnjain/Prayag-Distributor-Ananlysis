// M1 — Momentum insights route. Rate + direction, seasonally adjusted / real,
// composed entirely from existing services (see lib/momentum/momentumInsights).
//
// Entity filters: `heads`, `states`, `customers` (JSON arrays — same contract
// as company reports) plus `person=<member name>` which resolves to the
// distributors that member serves (distributor directory) and filters by that
// customer set.
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildMomentumInsights } from "../lib/momentum/momentumInsights.js";
import { parseMonthsParam } from "../lib/periodMonths.js";
import { type EntityFilter, hasEntityFilterValues } from "../lib/saleLineFilter.js";
import { loadDistributorDirectory } from "../lib/mgmt/distributorDirectory.js";
import { loadRoster } from "../lib/mgmt/roster.js";
import { normMemberKey } from "../lib/mgmt/memberResolver.js";
import { logger } from "../lib/logger.js";

const router = Router();
const FY = "2026-27";

function parseJsonArray(v: unknown): string[] | undefined {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
      return arr.length > 0 ? arr : undefined;
    }
  } catch {
    /* fall through */
  }
  throw new Error("filter params must be JSON string arrays");
}

/**
 * Resolve a team member (person) to the sale_line customer names of the
 * distributors they serve. Member-sheet spellings differ in case from the
 * register ("Vidhya sales" vs "Vidhya Sales"), so the names are re-resolved
 * against sale_line case-insensitively and the REGISTER spelling is returned —
 * entityConds matches exactly. A distributor with no primary line simply
 * contributes nothing (correct: zero primary business).
 */
async function personCustomers(person: string): Promise<string[]> {
  const dir = await loadDistributorDirectory(FY);
  const key = normMemberKey(person);
  const sheetNames = dir.distributors
    .filter((d) => d.members.some((m) => normMemberKey(m) === key))
    .map((d) => d.name.toUpperCase().trim());
  if (sheetNames.length === 0) return [];
  const r = await db.execute(sql`
    SELECT DISTINCT customer FROM sale_line_current
    WHERE customer IS NOT NULL
      AND upper(trim(customer)) IN (${sql.join(sheetNames.map((n) => sql`${n}`), sql`, `)})`);
  return (r.rows ?? []).map((row: any) => String(row.customer));
}

router.get("/momentum/insights", async (req, res) => {
  try {
    const parsed = parseMonthsParam(req.query.months, FY);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    let filter: EntityFilter | undefined;
    try {
      filter = {
        heads: parseJsonArray(req.query.heads),
        states: parseJsonArray(req.query.states),
        customers: parseJsonArray(req.query.customers),
      };
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const person = typeof req.query.person === "string" ? req.query.person.trim() : "";
    if (person) {
      const dists = await personCustomers(person);
      if (dists.length === 0) {
        // Explicit: the person resolved to no distributors — match nothing,
        // never fall back to unfiltered figures.
        filter = { ...filter, none: true };
      } else if (filter.customers?.length) {
        const set = new Set(dists.map((d) => d.toUpperCase().trim()));
        const inter = filter.customers.filter((c) => set.has(c.toUpperCase().trim()));
        filter = inter.length > 0 ? { ...filter, customers: inter } : { ...filter, none: true };
      } else {
        filter = { ...filter, customers: dists };
      }
    }
    if (!filter?.none && !hasEntityFilterValues(filter)) filter = undefined;
    const data = await buildMomentumInsights(FY, parsed.months ?? null, filter);
    res.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A selection with no complete month is a client-side period problem.
    if (msg.startsWith("No complete month")) {
      res.status(400).json({ error: msg });
      return;
    }
    logger.error({ err: e }, "momentum/insights failed");
    res.status(500).json({ error: msg });
  }
});

// People options for the person filter — active roster members + state heads.
router.get("/momentum/people", async (_req, res) => {
  try {
    const roster = await loadRoster();
    const people = roster.members
      .filter((m) => !(m.activeLeft ?? "").toUpperCase().includes("LEFT"))
      .map((m) => ({ name: m.name, stateHead: m.stateHead ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ people });
  } catch (e) {
    logger.error({ err: e }, "momentum/people failed");
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
