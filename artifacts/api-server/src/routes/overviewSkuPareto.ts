import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { GetOverviewSkuParetoQueryParams, GetOverviewSkuParetoResponse } from "@workspace/api-zod";
import { currentOpenFy, fyMonthLabels } from "../lib/fyAnchors.js";
import { buildSkuPareto, normalizeSkuParetoRange, SkuParetoRangeError } from "../lib/skuPareto.js";

const router: IRouter = Router();

export function validateSkuParetoRangeParams(
  monthFrom: number | undefined,
  monthTo: number | undefined,
): string | null {
  for (const [name, value] of [["monthFrom", monthFrom], ["monthTo", monthTo] ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 12)) {
      return `${name} must be an integer from 1 to 12`;
    }
  }
  if (monthFrom != null && monthTo != null && monthFrom > monthTo) {
    return "monthFrom must be less than or equal to monthTo";
  }
  return null;
}

router.get("/overview/sku-pareto", async (req: Request, res: Response): Promise<void> => {
  const parsed = GetOverviewSkuParetoQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const fy = parsed.data.fy ?? currentOpenFy();
  try {
    const explicitRangeError = validateSkuParetoRangeParams(parsed.data.monthFrom, parsed.data.monthTo);
    if (explicitRangeError) {
      res.status(400).json({ error: explicitRangeError });
      return;
    }
    // Resolve omitted bounds before the ordered-range check. For an open FY,
    // monthFrom=12 with no monthTo must be rejected against the effective YTD
    // end rather than slipping through as two independently valid inputs.
    const { monthFrom, monthTo } = normalizeSkuParetoRange(fy, parsed.data.monthFrom, parsed.data.monthTo);
    const labels = fyMonthLabels(fy).slice(monthFrom - 1, monthTo);
    const rows = await db.execute<{ code: string; amount: string; month_label: string }>(sql`
      SELECT code, amount::text, month_label
      FROM sale_line_current
      WHERE fy = ${fy}
        AND month_label IN (${sql.join(labels.map((label) => sql`${label}`), sql`, `)})
    `);
    const report = buildSkuPareto(fy, rows.rows.map((row) => ({
      code: row.code,
      amount: Number(row.amount),
      monthLabel: row.month_label,
    })), monthFrom, monthTo);
    res.json(GetOverviewSkuParetoResponse.parse(report));
  } catch (err) {
    if (err instanceof SkuParetoRangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err, fy }, "overview SKU Pareto build failed");
    res.status(500).json({ error: "Could not compute overview SKU Pareto." });
  }
});

export default router;