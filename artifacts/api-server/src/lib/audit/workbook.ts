// Audit Excel workbook builder. Produces an 8-tab .xlsx workbook from a FullVerifyReport.
// Built server-side with exceljs; streamed into a Buffer for the download endpoint.
import ExcelJS from "exceljs";
import type { FullVerifyReport, HealthCheck, CheckGroup } from "../mgmt/verifyFull.js";
import { readVerifyAnchors } from "../config/verifyAnchors.js";
import auditAnchors from "../../../config/audit_anchors.json";

// ── Formatting helpers ─────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pass: "FFD4EDDA",
  warn: "FFFFF3CD",
  fail: "FFFFFBF8",    // very light red to preserve readability
  pending: "FFD1ECF1",
  skip: "FFE2E3E5",
};

const STATUS_FONT: Record<string, string> = {
  pass: "FF155724",
  warn: "FF856404",
  fail: "FF842029",
  pending: "FF0C5460",
  skip: "FF383D41",
};

function statusFill(status: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_COLOR[status] ?? "FFFFFFFF" } };
}

function statusFontColor(status: string): Partial<ExcelJS.Font> {
  return { color: { argb: STATUS_FONT[status] ?? "FF000000" }, bold: status === "fail" };
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return "₹" + Math.abs(n).toLocaleString("en-IN");
}

function fmtCount(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function fmtDeltaPct(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function fmtActual(c: HealthCheck): string {
  if (c.actual == null) return "—";
  if (c.unit === "money") return fmtMoney(c.actual);
  if (c.unit === "count") return fmtCount(c.actual);
  if (c.unit === "pct") return c.actual.toFixed(1) + "%";
  return "—";
}

function fmtExpected(c: HealthCheck): string {
  if (c.expected == null) return "—";
  if (c.unit === "money") return fmtMoney(c.expected);
  if (c.unit === "count") return fmtCount(c.expected);
  if (c.unit === "pct") return c.expected.toFixed(1) + "%";
  return "—";
}

function groupSource(groupId: string, fy: string): string {
  const MAP: Record<string, string> = {
    targets_achievement: "Target Master (1ZLok3…) + STATE HEAD DASHBOARD xlsx",
    sale_order_booking: "State Head Sale (1RuXHIXf…) + Secondary OB folder",
    secondary: `Secondary OB ${fy} (Drive folder 1Ww2B1…)`,
    primary: "DB — sale_line table",
    name_match: "Target Master / Roster (1Nb8gRc…)",
    source_health: "Google Sheets API probes",
    truncation: "Secondary OB files — rowsRead from chunked API reads",
    report_logic: "DB — sale_line (Sunil Patel filtered queries)",
    crossfoot: "Secondary OB file aggregation",
  };
  return MAP[groupId] ?? "—";
}

function probableCause(check: HealthCheck): string {
  const k = check.key;
  if (k.includes("truncation")) {
    return "truncated read — rowsRead is a round number; actual total underreported (signature of the ₹46.34 Cr / 19% bug)";
  }
  if (k === "C3_sale_ne_order_booking") {
    return "wrong basis — Sale and Order Booking both reading from same source; should differ by >30%";
  }
  if (k.includes("B_monthly_ratio")) {
    return "quarterly target treated as annual — Q1 target / monthly gives ratio ~12 instead of 3";
  }
  if (k.includes("primary_head") && (check.actual ?? 0) === 0) {
    return "head-name normalisation broken — register alias (e.g. BIJJU→Biju C.O) not applied; ~₹10 Cr dropped";
  }
  if (k.includes("E1") || k.includes("E2") || k.includes("name_match")) {
    return "name mismatch — normalisation or alias map needs updating; unmatched targets are silently lost";
  }
  if (k.includes("E3") || k.includes("duplicate")) {
    return "duplicate rows — legacy curl-test or overlapping paste in Target Master";
  }
  if (k.includes("source_")) {
    return "source not accessible — check that the sheet is shared with the Google service account";
  }
  if (k.includes("report_logic")) {
    return "report computation error — like-months window or product/customer filter incorrect";
  }
  if (k.includes("cf_7_1")) {
    return "cross-foot mismatch — some rows not attributed to a team member; TM name column missing or blank";
  }
  if (k.startsWith("cf_")) {
    return "cross-foot mismatch — member/head sums do not reconcile to company total";
  }
  if (k.includes("target") || k.startsWith("A") || k.startsWith("B")) {
    return "target data not loaded, wrong FY applied, or correct period (Q1 vs annual) not used";
  }
  return "data quality issue — see Note column for details";
}

// ── Header row helper ─────────────────────────────────────────────────────────

function addHeaderRow(ws: ExcelJS.Worksheet, headers: string[], colWidths?: number[]): void {
  const row = ws.addRow(headers);
  row.font = { bold: true };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF343A40" } };
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  if (colWidths) {
    colWidths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

// ── Tab 1: Summary ─────────────────────────────────────────────────────────────

function buildSummarySheet(wb: ExcelJS.Workbook, report: FullVerifyReport, fy: string): void {
  const ws = wb.addWorksheet("Summary");
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 36;

  const allChecks = report.groups.flatMap((g) => g.checks);
  const counts = { pass: 0, warn: 0, fail: 0, pending: 0, skip: 0 };
  for (const c of allChecks) counts[c.status as keyof typeof counts] = (counts[c.status as keyof typeof counts] ?? 0) + 1;

  const rows: [string, string | number][] = [
    ["Run timestamp", new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"],
    ["Fiscal Year", fy],
    ["Groups run", report.groups.length],
    ["Total checks", allChecks.length],
    ["Pass", counts.pass],
    ["Warn", counts.warn],
    ["Fail", counts.fail],
    ["Pending", counts.pending],
    ["Skip", counts.skip],
    ["Overall verdict", report.overall.toUpperCase()],
    ["App", "Prayag India — Sales Intelligence"],
  ];

  const titleRow = ws.addRow(["Prayag Audit Report", ""]);
  titleRow.font = { bold: true, size: 14 };
  ws.addRow([]);

  for (const [k, v] of rows) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    if (k === "Overall verdict") {
      const status = report.overall === "fail" ? "fail" : report.overall === "warn" ? "warn" : "pass";
      r.getCell(2).fill = statusFill(status);
      r.getCell(2).font = { ...statusFontColor(status), bold: true };
    }
  }
}

// ── Tab 2: Checks ─────────────────────────────────────────────────────────────

function buildChecksSheet(wb: ExcelJS.Workbook, report: FullVerifyReport, fy: string): void {
  const ws = wb.addWorksheet("Checks");
  addHeaderRow(ws, ["Group", "Check", "Status", "Actual", "Expected", "Delta%", "Source Sheet", "Note"], [28, 52, 10, 18, 18, 10, 42, 60]);
  ws.autoFilter = "A1:H1";

  for (const group of report.groups) {
    for (const c of group.checks) {
      const row = ws.addRow([
        group.label,
        c.label,
        c.status.toUpperCase(),
        fmtActual(c),
        fmtExpected(c),
        fmtDeltaPct(c.deltaPct),
        groupSource(group.id, fy),
        c.note ?? "",
      ]);

      const statusCell = row.getCell(3);
      statusCell.fill = statusFill(c.status);
      statusCell.font = statusFontColor(c.status);
      row.alignment = { wrapText: false };

      if (c.status === "fail") {
        row.getCell(2).font = { bold: true };
      }
    }
  }
}

// ── Tab 3: Failures ───────────────────────────────────────────────────────────

function buildFailuresSheet(wb: ExcelJS.Workbook, report: FullVerifyReport, fy: string): void {
  const ws = wb.addWorksheet("Failures");
  addHeaderRow(ws, ["Group", "Check", "Actual", "Expected", "Delta%", "Source Sheet", "Note", "Probable Cause"], [28, 52, 18, 18, 10, 42, 60, 72]);

  const failures = report.groups.flatMap((g) =>
    g.checks.filter((c) => c.status === "fail").map((c) => ({ group: g, check: c })),
  );

  if (failures.length === 0) {
    const r = ws.addRow(["No failures", "", "", "", "", "", "", "All checks passed or are pending."]);
    r.font = { italic: true, color: { argb: "FF6C757D" } };
    return;
  }

  for (const { group, check: c } of failures) {
    const row = ws.addRow([
      group.label,
      c.label,
      fmtActual(c),
      fmtExpected(c),
      fmtDeltaPct(c.deltaPct),
      groupSource(group.id, fy),
      c.note ?? "",
      probableCause(c),
    ]);
    row.getCell(1).fill = statusFill("fail");
    row.getCell(2).font = { bold: true };
    row.getCell(8).font = { italic: true };
  }
}

// ── Tab 4: Source Health ──────────────────────────────────────────────────────

function buildSourceHealthSheet(wb: ExcelJS.Workbook, report: FullVerifyReport): void {
  const ws = wb.addWorksheet("Source Health");
  addHeaderRow(ws, ["Source", "Status", "Rows Read", "Truncation Flag", "Note"], [42, 12, 14, 18, 72]);

  const srcGroup = report.groups.find((g) => g.id === "source_health");
  const truncGroup = report.groups.find((g) => g.id === "truncation");

  // Map truncation info by FY
  const truncInfo = new Map<string, { rowsRead: number | null; flag: string }>();
  if (truncGroup) {
    for (const c of truncGroup.checks) {
      const fy = c.key.replace("truncation_", "");
      truncInfo.set(fy, {
        rowsRead: c.actual,
        flag: c.status === "fail" ? "TRUNCATED" : c.status === "pending" ? "PENDING" : c.status === "skip" ? "N/A" : "OK",
      });
    }
  }

  if (srcGroup) {
    for (const c of srcGroup.checks) {
      const fy = c.key.includes("2025") ? "2025-26" : c.key.includes("2026") ? "2026-27" : null;
      const trunc = fy ? truncInfo.get(fy) : null;

      const row = ws.addRow([
        c.label,
        c.status.toUpperCase(),
        trunc?.rowsRead != null ? trunc.rowsRead.toLocaleString("en-IN") : "N/A",
        trunc?.flag ?? "N/A",
        c.note ?? "",
      ]);
      row.getCell(2).fill = statusFill(c.status);
      row.getCell(2).font = statusFontColor(c.status);
      if (trunc?.flag === "TRUNCATED") {
        row.getCell(4).fill = statusFill("fail");
        row.getCell(4).font = statusFontColor("fail");
      }
    }
  }

  // Also add truncation-only sources (order booking files)
  for (const [fy, info] of truncInfo) {
    const alreadyAdded = srcGroup?.checks.some((c) => c.key.includes(fy));
    if (!alreadyAdded) {
      const row = ws.addRow([
        `Secondary OB ${fy}`,
        info.flag === "OK" ? "PASS" : info.flag,
        info.rowsRead != null ? info.rowsRead.toLocaleString("en-IN") : "N/A",
        info.flag,
        "",
      ]);
      row.getCell(2).fill = statusFill(info.flag === "OK" ? "pass" : info.flag === "PENDING" ? "pending" : "fail");
    }
  }
}

// ── Tab 5: Unmatched Names ────────────────────────────────────────────────────

function buildUnmatchedNamesSheet(wb: ExcelJS.Workbook, report: FullVerifyReport): void {
  const ws = wb.addWorksheet("Unmatched Names");
  addHeaderRow(ws, ["FY", "Name / Entry", "Source", "Value (target/CTC)", "Join Failed", "Note"], [10, 36, 28, 20, 24, 72]);

  const nameGroup = report.groups.find((g) => g.id === "name_match");
  if (!nameGroup) {
    ws.addRow(["—", "Name match group not run", "", "", "", ""]);
    return;
  }

  let hasUnmatched = false;
  for (const c of nameGroup.checks) {
    if (c.key.includes("E2") && (c.actual ?? 0) > 0 && c.note) {
      // Parse note: "'Name' (normKey: key; target: ₹X L); ..."
      const entries = c.note.split(";").map((s) => s.trim()).filter(Boolean);
      for (const entry of entries) {
        if (entry.startsWith("'") || entry.includes("normKey")) {
          const nameMatch = entry.match(/^'([^']+)'/);
          const targetMatch = entry.match(/target:\s*(₹[\d,.]+\s*[LCr]*)/i);
          ws.addRow([
            report.fy,
            nameMatch?.[1] ?? entry.slice(0, 40),
            "Target Master",
            targetMatch?.[1] ?? "—",
            "Target Master ↔ roster",
            "Unmatched name means its target is silently ignored in reports.",
          ]);
          hasUnmatched = true;
        }
      }
    }
    if (c.key.includes("E3") && (c.actual ?? 0) > 0 && c.note) {
      const parts = c.note.split(";").map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        ws.addRow([report.fy, p, "Target Master", "—", "Duplicate detection", "Old curl-test or legacy row — remove from Target Master."]);
        hasUnmatched = true;
      }
    }
  }

  if (!hasUnmatched) {
    const r = ws.addRow(["—", "No unmatched names detected", "", "", "", ""]);
    r.font = { italic: true, color: { argb: "FF6C757D" } };
  }
}

// ── Tab 6: Head Reconciliation ────────────────────────────────────────────────

function buildHeadReconSheet(wb: ExcelJS.Workbook, report: FullVerifyReport): void {
  const ws = wb.addWorksheet("Head Reconciliation");
  addHeaderRow(ws, ["Head", "Expected (Secondary)", "Actual (Secondary)", "Delta%", "Expected (Primary)", "Actual (Primary)", "Note"], [28, 22, 22, 10, 22, 22, 48]);

  // Secondary per-head checks come from the "secondary" group (Group D from verify.ts)
  const secGroup = report.groups.find((g) => g.id === "secondary");
  const primaryGroup = report.groups.find((g) => g.id === "primary");

  // Build a map of primary head checks for lookup
  const primaryByHead = new Map<string, HealthCheck>();
  if (primaryGroup) {
    for (const c of primaryGroup.checks) {
      if (c.key.includes("primary_head_")) {
        // Key format: primary_head_{normHead}_{fy}
        const parts = c.key.split("_");
        const head = parts.slice(2, -1).join("_");
        primaryByHead.set(head, c);
      }
    }
  }

  if (secGroup && secGroup.checks.length > 0) {
    for (const c of secGroup.checks) {
      if (c.unit !== "money" || c.expected == null) continue;
      // Extract head name from label
      const headName = c.label.replace(/^[A-Z\d.]+\s+—\s+/, "").replace(/\s+\(.*\)$/, "");
      const primaryCheck = primaryByHead.get(headName.toLowerCase().replace(/\s+/g, "_"));

      const row = ws.addRow([
        headName,
        fmtMoney(c.expected),
        fmtMoney(c.actual),
        fmtDeltaPct(c.deltaPct),
        primaryCheck ? fmtMoney(primaryCheck.expected) : "—",
        primaryCheck ? fmtMoney(primaryCheck.actual) : "—",
        c.note ?? "",
      ]);
      if (c.status === "fail") {
        row.getCell(1).fill = statusFill("fail");
        row.getCell(3).fill = statusFill("fail");
      } else if (c.status === "warn") {
        row.getCell(3).fill = statusFill("warn");
      }
    }
  } else {
    const r = ws.addRow(["No per-head secondary data", "", "", "", "", "", "Secondary OB file may not be loaded."]);
    r.font = { italic: true, color: { argb: "FF6C757D" } };
  }
}

// ── Tab 7: Cross-foots ────────────────────────────────────────────────────────

function buildCrossFootSheet(wb: ExcelJS.Workbook, report: FullVerifyReport): void {
  const ws = wb.addWorksheet("Cross-foots");
  addHeaderRow(ws, ["Check", "Status", "Expected", "Actual", "Delta%", "Note"], [52, 12, 20, 20, 10, 72]);

  const cfGroup = report.groups.find((g) => g.id === "crossfoot");
  if (!cfGroup || cfGroup.checks.length === 0) {
    const r = ws.addRow(["Cross-foot group not run or not available", "", "", "", "", cfGroup?.pendingNote ?? ""]);
    r.font = { italic: true, color: { argb: "FF6C757D" } };
    return;
  }

  for (const c of cfGroup.checks) {
    const row = ws.addRow([
      c.label,
      c.status.toUpperCase(),
      fmtExpected(c),
      fmtActual(c),
      fmtDeltaPct(c.deltaPct),
      c.note ?? "",
    ]);
    row.getCell(2).fill = statusFill(c.status);
    row.getCell(2).font = statusFontColor(c.status);
  }
}

// ── Tab 8: Anchors ────────────────────────────────────────────────────────────

function buildAnchorsSheet(wb: ExcelJS.Workbook, fy: string): void {
  const ws = wb.addWorksheet("Anchors");
  addHeaderRow(ws, ["FY / Scope", "Anchor Key", "Expected Value", "Unit", "Source"], [18, 48, 22, 12, 48]);

  const va = readVerifyAnchors();

  // Secondary OB anchors (fy_anchors)
  const fyAnchors = (va as Record<string, unknown>)["fy_anchors"] as Record<string, Record<string, unknown>> | undefined;
  if (fyAnchors?.[fy]) {
    const a = fyAnchors[fy] as Record<string, unknown>;
    const perHead = a["perHeadSale"] as Record<string, number> | undefined;
    ws.addRow([fy, "Secondary OB total (saleReportTotal)", fmtMoney(a["saleReportTotal"] as number), "₹", "verify_anchors.json"]);
    ws.addRow([fy, "Secondary OB registered members", fmtCount(a["registeredMembers"] as number), "count", "verify_anchors.json"]);
    ws.addRow([fy, "Secondary OB total orders", fmtCount(a["orders"] as number), "count", "verify_anchors.json"]);
    ws.addRow([fy, "Secondary OB registered retailers", fmtCount(a["registeredRetailers"] as number), "count", "verify_anchors.json"]);
    ws.addRow([fy, "Secondary OB active retailers", fmtCount(a["activeRetailers"] as number), "count", "verify_anchors.json"]);
    if (perHead) {
      for (const [head, amt] of Object.entries(perHead)) {
        ws.addRow([fy, `Secondary OB — ${head}`, fmtMoney(amt), "₹", "verify_anchors.json"]);
      }
    }
  }

  // Primary anchors
  const primaryAnchors = (va as Record<string, unknown>)["primary_anchors"] as Record<string, unknown> | undefined;
  if (primaryAnchors) {
    const pa = primaryAnchors[fy] as { total?: number; perHead?: Record<string, number> } | undefined;
    if (pa?.total) {
      ws.addRow([fy, "Primary sale total (dispatch)", fmtMoney(pa.total), "₹", "verify_anchors.json"]);
    }
    if (pa?.perHead) {
      for (const [head, amt] of Object.entries(pa.perHead)) {
        ws.addRow([fy, `Primary sale — ${head}`, fmtMoney(amt), "₹", "verify_anchors.json"]);
      }
    }
  }

  // Target anchors
  const ta = (va as Record<string, unknown>)["target_anchors"] as Record<string, unknown> | undefined;
  const taFy = ta?.[fy] as Record<string, unknown> | undefined;
  if (taFy) {
    for (const [k, v] of Object.entries(taFy)) {
      if (typeof v === "number") ws.addRow([fy, `Target — ${k}`, v, "", "verify_anchors.json"]);
    }
  }

  // Report logic anchors (Group 6)
  type AA = typeof auditAnchors;
  const aa = auditAnchors as AA;
  for (const rlc of aa.report_logic.checks) {
    ws.addRow([
      `${aa.report_logic.cy_fy} / ${aa.report_logic.ly_fy}`,
      `Group 6 — ${rlc.label}`,
      rlc.unit === "money" ? fmtMoney(rlc.expected) : fmtCount(rlc.expected),
      rlc.unit === "money" ? "₹" : "count",
      "audit_anchors.json",
    ]);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function buildAuditWorkbook(report: FullVerifyReport, fy: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();
  wb.modified = new Date();
  wb.properties.date1904 = false;

  buildSummarySheet(wb, report, fy);
  buildChecksSheet(wb, report, fy);
  buildFailuresSheet(wb, report, fy);
  buildSourceHealthSheet(wb, report);
  buildUnmatchedNamesSheet(wb, report);
  buildHeadReconSheet(wb, report);
  buildCrossFootSheet(wb, report);
  buildAnchorsSheet(wb, fy);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
