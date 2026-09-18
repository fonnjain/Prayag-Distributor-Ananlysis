import { Router } from "express";
import ExcelJS from "exceljs";
import { requireAdmin, requireSameOrigin } from "../lib/auth.js";
import { activityReport, ingestActivity, validateActivityBatch, validateDateRange } from "../lib/activity/service.js";

const router = Router();
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };

type ActivityDay = {
  date: string;
  activeMs: number;
  idleMs: number;
  totalMs: number;
  firstSeenAt: Date | string | null;
  lastSeenAt: Date | string | null;
  pageViews: number;
  actionCount: number;
};

type ActivitySummary = {
  userId: number;
  displayName: string;
  email: string;
  role: string;
  isActive: boolean;
  activeMs: number;
  idleMs: number;
  totalMs: number;
  firstSeenAt: Date | string | null;
  lastSeenAt: Date | string | null;
  pageViews: number;
  actionCount: number;
  current: boolean;
  days: ActivityDay[];
};

type ActivityReport = {
  timezone: string;
  from: string;
  to: string;
  summaries: ActivitySummary[];
  detail?: {
    pages: Array<{ path: string; views: number; lastSeenAt: Date | string | null }>;
    events: Array<{ occurredAt: Date | string; kind: string; path: string | null; action: string | null; state: string | null }>;
  };
};

function durationHours(ms: number) {
  return Math.round((Number(ms || 0) / 3_600_000) * 100) / 100;
}

function excelDate(value: Date | string | null | undefined) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed;
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: sheet.getRow(1).getCell(sheet.columnCount).address };
}

export function buildActivityWorkbook(report: ActivityReport, selectedUserId?: number) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prayag Sales Intelligence";
  workbook.created = new Date();

  const info = workbook.addWorksheet("Info");
  info.columns = [{ width: 24 }, { width: 80 }];
  [
    ["Report", selectedUserId ? "Individual User Activity" : "All Users Activity Summary"],
    ["From", report.from],
    ["To", report.to],
    ["Timezone", report.timezone],
    ["Scope", selectedUserId ? (report.summaries[0]?.displayName ?? `User ${selectedUserId}`) : "All users with recorded activity"],
    ["Generated", new Date()],
    ["Note", "Active and idle time are calculated from recorded telemetry. Concurrent browser tabs are unioned rather than double-counted."],
  ].forEach(([label, value]) => {
    const row = info.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  });
  info.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const summary = workbook.addWorksheet("User Summary");
  summary.columns = [
    { header: "User", key: "displayName", width: 28 },
    { header: "Email", key: "email", width: 34 },
    { header: "Role", key: "role", width: 16 },
    { header: "Account Active", key: "isActive", width: 15 },
    { header: "Active Now", key: "current", width: 13 },
    { header: "Active Hours", key: "activeHours", width: 14 },
    { header: "Idle Hours", key: "idleHours", width: 13 },
    { header: "Total Hours", key: "totalHours", width: 13 },
    { header: "Page Views", key: "pageViews", width: 13 },
    { header: "Actions", key: "actionCount", width: 11 },
    { header: "First Seen", key: "firstSeenAt", width: 21 },
    { header: "Last Seen", key: "lastSeenAt", width: 21 },
  ];
  for (const row of report.summaries) {
    summary.addRow({
      ...row,
      isActive: row.isActive ? "Yes" : "No",
      current: row.current ? "Yes" : "No",
      activeHours: durationHours(row.activeMs),
      idleHours: durationHours(row.idleMs),
      totalHours: durationHours(row.totalMs),
      firstSeenAt: excelDate(row.firstSeenAt),
      lastSeenAt: excelDate(row.lastSeenAt),
    });
  }
  summary.getColumn("activeHours").numFmt = "0.00";
  summary.getColumn("idleHours").numFmt = "0.00";
  summary.getColumn("totalHours").numFmt = "0.00";
  summary.getColumn("firstSeenAt").numFmt = "dd-mmm-yyyy hh:mm";
  summary.getColumn("lastSeenAt").numFmt = "dd-mmm-yyyy hh:mm";
  styleSheet(summary);

  const daily = workbook.addWorksheet("Daily Activity");
  daily.columns = [
    { header: "User", key: "displayName", width: 28 },
    { header: "Email", key: "email", width: 34 },
    { header: "Date", key: "date", width: 13 },
    { header: "Active Hours", key: "activeHours", width: 14 },
    { header: "Idle Hours", key: "idleHours", width: 13 },
    { header: "Total Hours", key: "totalHours", width: 13 },
    { header: "Page Views", key: "pageViews", width: 13 },
    { header: "Actions", key: "actionCount", width: 11 },
    { header: "First Seen", key: "firstSeenAt", width: 21 },
    { header: "Last Seen", key: "lastSeenAt", width: 21 },
  ];
  for (const user of report.summaries) {
    for (const day of user.days) {
      daily.addRow({
        displayName: user.displayName,
        email: user.email,
        date: day.date,
        activeHours: durationHours(day.activeMs),
        idleHours: durationHours(day.idleMs),
        totalHours: durationHours(day.totalMs),
        pageViews: day.pageViews,
        actionCount: day.actionCount,
        firstSeenAt: excelDate(day.firstSeenAt),
        lastSeenAt: excelDate(day.lastSeenAt),
      });
    }
  }
  daily.getColumn("activeHours").numFmt = "0.00";
  daily.getColumn("idleHours").numFmt = "0.00";
  daily.getColumn("totalHours").numFmt = "0.00";
  daily.getColumn("firstSeenAt").numFmt = "dd-mmm-yyyy hh:mm";
  daily.getColumn("lastSeenAt").numFmt = "dd-mmm-yyyy hh:mm";
  styleSheet(daily);

  if (selectedUserId && report.detail) {
    const pages = workbook.addWorksheet("Page Activity");
    pages.columns = [
      { header: "Path", key: "path", width: 58 },
      { header: "Views", key: "views", width: 12 },
      { header: "Last Seen", key: "lastSeenAt", width: 21 },
    ];
    for (const row of report.detail.pages) pages.addRow({ ...row, lastSeenAt: excelDate(row.lastSeenAt) });
    pages.getColumn("lastSeenAt").numFmt = "dd-mmm-yyyy hh:mm";
    styleSheet(pages);

    const events = workbook.addWorksheet("Recent Events");
    events.columns = [
      { header: "Occurred At", key: "occurredAt", width: 21 },
      { header: "Kind", key: "kind", width: 14 },
      { header: "Page", key: "path", width: 58 },
      { header: "Action", key: "action", width: 32 },
      { header: "State", key: "state", width: 12 },
    ];
    for (const row of report.detail.events) events.addRow({ ...row, occurredAt: excelDate(row.occurredAt) });
    events.getColumn("occurredAt").numFmt = "dd-mmm-yyyy hh:mm";
    styleSheet(events);
  }

  return workbook;
}

function parseReportParams(req: Parameters<Parameters<typeof router.get>[1]>[0]) {
  const { from, to } = validateDateRange(req.query.from, req.query.to);
  const rawUserId = req.query.userId;
  const userId = rawUserId === undefined ? undefined : Number(rawUserId);
  if (rawUserId !== undefined && (!Number.isInteger(userId) || userId! <= 0)) throw new Error("Invalid userId");
  return { from, to, userId };
}

router.post("/activity/events", requireSameOrigin, async (req, res) => {
  // A cookie-authenticated session is deliberately stricter than the global gate.
  if (!req.authUser || !req.authSessionId || req.apiKey) return void res.status(401).json({ error: "Cookie session required" });
  try {
    const result = await ingestActivity(req.authUser.id, req.authSessionId, validateActivityBatch(req.body));
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid")) return void res.status(400).json({ error: err.message });
    req.log.error({ err }, "activity event ingestion failed");
    res.status(500).json({ error: "Unable to record activity" });
  }
});

router.get("/auth/activity", requireAdmin, async (req, res) => {
  try {
    const { from, to, userId } = parseReportParams(req);
    res.json(await activityReport(from, to, userId));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("YYYY-MM-DD") || err.message.includes("Date range") || err.message === "Invalid userId")) return void res.status(400).json({ error: err.message });
    req.log.error({ err }, "activity report failed");
    res.status(500).json({ error: "Unable to load activity" });
  }
});

router.get("/auth/activity/export", requireAdmin, async (req, res) => {
  try {
    const { from, to, userId } = parseReportParams(req);
    const report = await activityReport(from, to, userId) as ActivityReport;
    const workbook = buildActivityWorkbook(report, userId);
    const buffer = await workbook.xlsx.writeBuffer();
    const user = report.summaries[0];
    const safeName = userId
      ? (user?.displayName ?? `user-${userId}`).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || `user-${userId}`
      : "all-users";
    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="User_Activity_${safeName}_${from}_to_${to}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("YYYY-MM-DD") || err.message.includes("Date range") || err.message === "Invalid userId")) return void res.status(400).json({ error: err.message });
    req.log.error({ err }, "activity export failed");
    res.status(500).json({ error: "Unable to export activity" });
  }
});

export default router;