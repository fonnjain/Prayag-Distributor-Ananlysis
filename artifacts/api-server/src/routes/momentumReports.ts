// GET /api/momentum-reports/export — Excel export for the Momentum page.
//
// The Momentum page's basis is the FY26-27 secondary order-book pipeline
// aggregated in the dashboard snapshot (monthly order value + top groups).
// Those aggregates carry ONLY month and group dimensions — no head, state or
// distributor exists in the source — so the shared entity filter bar does not
// apply here and this route exports the page exactly as shown.
import { Router } from "express";
import ExcelJS from "exceljs";
import { ensureSeeded } from "../lib/dashboard/sync.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";

const router = Router();

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

type OrdersData = {
  orders_fy2627: {
    monthly: Array<{ month: string; value_cr: number }>;
    groups: Array<{ group: string; value_cr: number }>;
  };
  totals: { orders_fy2627_ytd_cr: number };
};

router.get("/momentum-reports/export", async (req, res) => {
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const snapshot = await ensureSeeded();
    const data = snapshot.data as unknown as OrdersData;

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 95 }];
    const infoRows: Array<[string, string]> = [
      ["Page", "Momentum — FY26-27 secondary order-book pipeline (order value by month and group)"],
      ["Data synced at", snapshot.syncedAt.toISOString()],
      ["Orders YTD (Cr)", String(data.totals.orders_fy2627_ytd_cr)],
      ["Note", "Order-book aggregates carry only month and group dimensions — State Head / State / Distributor filters do not exist in this source, so this export always covers the whole company."],
    ];
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    const addSheet = (
      name: string,
      columns: Array<{ header: string; key: string; width?: number }>,
      rows: Array<Record<string, unknown>>,
    ) => {
      const ws = wb.addWorksheet(name);
      ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
      ws.getRow(1).eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = HEADER_FILL;
      });
      for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? ""));
      ws.views = [{ state: "frozen", ySplit: 1 }];
    };

    addSheet("Monthly Orders", [
      { header: "Month", key: "month", width: 12 },
      { header: "Order Value (Cr)", key: "value_cr", width: 18 },
    ], data.orders_fy2627.monthly as unknown as Array<Record<string, unknown>>);

    addSheet("Order Groups", [
      { header: "Group", key: "group", width: 28 },
      { header: "Order Value (Cr)", key: "value_cr", width: 18 },
    ], [...data.orders_fy2627.groups].sort((a, b) => b.value_cr - a.value_cr) as unknown as Array<Record<string, unknown>>);

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Momentum_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "momentum-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
