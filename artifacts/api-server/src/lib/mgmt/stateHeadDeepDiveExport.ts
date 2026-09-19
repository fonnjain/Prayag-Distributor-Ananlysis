import ExcelJS from "exceljs";
import type { MemberKpis, TeamSummary } from "./deepDiveData.js";

/**
 * The state-head export is deliberately a separate workbook from the
 * member-level deep-dive workbook.  The member export has a long, established
 * contract; adding head rows to it would make old downloads change shape.
 */
export type StateHeadDeepDiveExportInput = {
  fy: string;
  stateHead: string;
  periodLabel?: string;
  periodMonths?: number[];
  members: MemberKpis[];
  teamSummary: TeamSummary;
  /** Period-resolved operands. Presence (including an empty object) means the
   * page selected a fiscal period and static YTD fields must not be reused. */
  periodMembers?: Record<string, StateHeadPeriodMember>;
  periodReportingMonthCount?: number | null;
  reportingMonthCount?: number | null;
  dataReadAt?: number | null;
  generatedAt?: Date;
  provisionalMonths?: string;
  fromDbSnapshot?: boolean;
  stale?: boolean;
  companyBenchmark?: {
    costRatio: number | null;
    returnPerRupee: number | null;
    source: string;
    population: string;
    peerCount: number;
  };
  sources?: {
    dashboard?: string;
    cost?: string;
    coverage?: string;
  };
  periodTeamOperands?: {
    headlineOb: number | null;
    headlineTarget: number | null;
    lflOb: number | null;
    lflTarget: number | null;
  };
};

export type StateHeadPeriodMember = {
  target: number | null;
  orderBooking: number | null;
  sales: number | null;
  source: string;
  targetReason?: string;
  orderBookingReason?: string;
  salesReason?: string;
  /** T.A. is a YTD-only source in the authoritative Data tab. */
  taBill: number | null;
  taReason?: string;
  coverageReason?: string;
};

/**
 * Resolve one operand from the authoritative monthly array.  A period is
 * complete only when it has exactly one row for each requested fiscal month;
 * a missing month, duplicate month, or null operand is never treated as zero.
 */
export function resolveAuthoritativePeriodValue(
  rows: Array<{ monthIdx: number; value: number | null }>,
  requestedMonths: number[],
  label: string,
): { value: number | null; reason: string } {
  if (requestedMonths.length === 0) {
    return { value: null, reason: `No fiscal months were selected for ${label}.` };
  }
  const requestedDbMonths = new Set(requestedMonths.map((month) => month - 1));
  const uniqueMonths = new Set(rows.map((row) => row.monthIdx));
  if (rows.length !== requestedMonths.length || uniqueMonths.size !== requestedMonths.length
    || [...requestedDbMonths].some((month) => !uniqueMonths.has(month))) {
    return {
      value: null,
      reason: `Incomplete ${label}: exactly one authoritative monthly row is required for every requested fiscal month; ${rows.length} row(s) for ${requestedMonths.length} requested month(s), with missing or duplicate months.`,
    };
  }
  if (rows.some((row) => row.value == null)) {
    return { value: null, reason: `Incomplete ${label}: one or more authoritative monthly values are unavailable.` };
  }
  return {
    value: rows.reduce((sum, row) => sum + row.value!, 0),
    reason: "",
  };
}

type Scalar = string | number | Date | null;
const GREY = "FFE7E7E7";
const NAVY = "FF17365D";
const BLUE = "FFD9EAF7";
const MONEY_FMT = '"₹"#,##,##0;[Red]-"₹"#,##,##0';

function state(value: number | null): "value" | "zero" | "unavailable" {
  return value == null ? "unavailable" : value === 0 ? "zero" : "value";
}

function grey(cell: ExcelJS.Cell): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
}

function numeric(cell: ExcelJS.Cell, value: number | null, fmt = "#,##,##0"): void {
  cell.value = value;
  if (value == null) grey(cell);
  else cell.numFmt = fmt;
}

function money(cell: ExcelJS.Cell, value: number | null): void {
  numeric(cell, value, MONEY_FMT);
}

function percent(cell: ExcelJS.Cell, value: number | null): void {
  cell.value = value == null ? null : value / 100;
  if (value == null) grey(cell);
  cell.numFmt = "0.00%";
}

function title(ws: ExcelJS.Worksheet, text: string, headers: string[]): void {
  ws.addRow([text]);
  ws.mergeCells(1, 1, 1, Math.max(1, headers.length));
  const t = ws.getCell(1, 1);
  t.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  ws.getRow(1).height = 24;
  ws.addRow(headers);
  const h = ws.getRow(2);
  h.font = { bold: true };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  h.alignment = { wrapText: true, vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 2 }];
}

function finish(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, index) => { ws.getColumn(index + 1).width = width; });
  ws.eachRow((row, rowNumber) => {
    if (rowNumber > 2) row.alignment = { wrapText: true, vertical: "top" };
  });
  if (widths.length > 0) {
    const end = String.fromCharCode(64 + Math.min(widths.length, 26));
    ws.autoFilter = { from: "A2", to: `${end}2` };
  }
}

function memberOb(member: MemberKpis): number | null {
  const values = [member.orderBooking, member.newPartyOrderBooking, member.directDealersOrder];
  return values.some((value) => value == null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

function memberTarget(member: MemberKpis): number | null {
  return member.totalTargetToDate;
}

function periodMember(input: StateHeadDeepDiveExportInput, member: MemberKpis): StateHeadPeriodMember | null {
  return input.periodMembers?.[member.normKey] ?? null;
}

function targetValue(input: StateHeadDeepDiveExportInput, member: MemberKpis): number | null {
  const period = periodMember(input, member);
  return period ? period.target : input.periodMembers !== undefined ? null : memberTarget(member);
}

function obValue(input: StateHeadDeepDiveExportInput, member: MemberKpis): number | null {
  const period = periodMember(input, member);
  return period ? period.orderBooking : input.periodMembers !== undefined ? null : memberOb(member);
}

function salesValue(input: StateHeadDeepDiveExportInput, member: MemberKpis): number | null {
  const period = periodMember(input, member);
  return period ? period.sales : input.periodMembers !== undefined ? null : member.sale;
}

function sourceValue(input: StateHeadDeepDiveExportInput, member: MemberKpis, fallback: string): string {
  return periodMember(input, member)?.source ?? fallback;
}

function reasonValue(input: StateHeadDeepDiveExportInput, member: MemberKpis, field: keyof StateHeadPeriodMember): string {
  const period = periodMember(input, member);
  if (!period) return "";
  const reason = period[field];
  return typeof reason === "string" ? reason : "";
}

function exclusion(input: StateHeadDeepDiveExportInput, member: MemberKpis): { excluded: boolean; reason: string } {
  if (member.isLeft) return { excluded: true, reason: "LEFT member; team headline is active-only." };
  const target = targetValue(input, member);
  if (input.periodMembers === undefined && input.teamSummary.zeroTargetActiveNames.includes(member.name)) {
    return { excluded: true, reason: "No target recorded; headline includes OB but LFL excludes this member." };
  }
  if (target != null && target <= 0) {
    return { excluded: true, reason: "No target recorded; headline includes OB but LFL excludes this member." };
  }
  if (target == null) return { excluded: true, reason: "Target unavailable; like-for-like is incomplete for this member." };
  return { excluded: false, reason: "" };
}

function addOperand(
  ws: ExcelJS.Worksheet,
  label: string,
  value: number | null,
  source: string,
  kind: "money" | "number" = "number",
): void {
  const row = ws.addRow([label, null, null, null, null, state(value), source, value == null ? "Unavailable in resolved page payload." : ""]);
  if (kind === "money") money(row.getCell(2), value);
  else numeric(row.getCell(2), value);
}

function addRatio(
  ws: ExcelJS.Worksheet,
  label: string,
  numerator: number | null,
  denominator: number | null,
  source: string,
): void {
  const value = numerator != null && denominator != null && denominator > 0
    ? numerator / denominator * 100 : null;
  const row = ws.addRow([label, null, null, null, null, state(value), source, value == null ? "Unavailable because an operand is unavailable or non-positive." : ""]);
  money(row.getCell(3), numerator);
  money(row.getCell(4), denominator);
  percent(row.getCell(5), value);
}

export function buildStateHeadDeepDiveWorkbook(input: StateHeadDeepDiveExportInput): ExcelJS.Workbook {
  const sourceDashboard = input.sources?.dashboard ?? "Resolved STATE HEAD DASHBOARD Data tab";
  const sourceCost = input.sources?.cost ?? sourceDashboard;
  const sourceCoverage = input.sources?.coverage ?? sourceDashboard;
  const active = input.members.filter((member) => !member.isLeft);
  const periodScoped = input.periodMembers !== undefined;
  const defaultNoTargetNames = new Set(input.teamSummary.zeroTargetActiveNames);
  // Only an explicit numeric target <= 0 is a genuine no-target member.
  // Null is an unresolved operand and must not be turned into a no-target
  // member or a zero in any team total.
  const noTargetMembers = active.filter((member) => {
    const target = targetValue(input, member);
    return typeof target === "number" && target <= 0;
  });
  const withTarget = active.filter((member) => periodScoped
    ? (typeof targetValue(input, member) === "number" && targetValue(input, member)! > 0)
    : !defaultNoTargetNames.has(member.name));
  const unknownTargetMembers = active.filter((member) => targetValue(input, member) == null);
  const noTargetObValues = noTargetMembers.map((member) => obValue(input, member));
  const noTargetOb = noTargetMembers.length > 0 && noTargetObValues.every((value) => value != null)
    ? noTargetObValues.reduce<number>((sum, value) => sum + value!, 0)
    : null;
  const summaryMeta = periodScoped
    ? {
        activeMembers: active.length,
        leftMembers: input.members.length - active.length,
        zeroTargetActiveCount: noTargetMembers.length,
        zeroTargetActiveOb: noTargetOb,
        zeroTargetActiveNames: noTargetMembers.map((member) => member.name),
      }
    : {
        activeMembers: input.teamSummary.activeMembers,
        leftMembers: input.teamSummary.leftMembers,
        zeroTargetActiveCount: input.teamSummary.zeroTargetActiveCount,
        zeroTargetActiveOb: input.teamSummary.zeroTargetActiveOb,
        zeroTargetActiveNames: input.teamSummary.zeroTargetActiveNames,
      };
  const lflObValues = withTarget.map((member) => obValue(input, member));
  const lflTargetValues = withTarget.map((member) => targetValue(input, member));
  const lflOb = lflObValues.every((value) => value != null)
    ? lflObValues.reduce<number>((sum, value) => sum + value, 0) : null;
  const lflTarget = lflTargetValues.every((value) => value != null)
    ? lflTargetValues.reduce<number>((sum, value) => sum + value, 0) : null;
  const periodUnknownTarget = periodScoped && unknownTargetMembers.length > 0;
  const periodUnknownHeadlineOb = periodScoped && active.some((member) => obValue(input, member) == null);
  const periodLflMembers = withTarget;
  const periodUnknownLflOb = periodScoped && periodLflMembers.some((member) => obValue(input, member) == null);
  const knownTargetValues = active.map((member) => targetValue(input, member));
  const knownObValues = active.map((member) => obValue(input, member));
  const totalTarget = knownTargetValues.every((value) => value != null)
    ? knownTargetValues.reduce<number>((sum, value) => sum + value, 0) : null;
  const totalOb = knownObValues.every((value) => value != null)
    ? knownObValues.reduce<number>((sum, value) => sum + value, 0) : null;
  const headlineOperands = input.periodTeamOperands ?? (periodScoped
    ? {
        headlineOb: periodUnknownHeadlineOb ? null : totalOb,
        headlineTarget: periodUnknownTarget ? null : totalTarget,
        lflOb: periodUnknownTarget || periodUnknownLflOb ? null : lflOb,
        lflTarget: periodUnknownTarget ? null : lflTarget,
      }
    : {
        headlineOb: input.teamSummary.totalOB,
        headlineTarget: input.teamSummary.totalTarget,
        lflOb: input.teamSummary.likeForLikeAchievementPct == null
          ? null
          : input.teamSummary.likeForLikeAchievementPct / 100 * input.teamSummary.totalTarget,
        lflTarget: input.teamSummary.totalTarget,
      });
  const disclosure =
    summaryMeta.zeroTargetActiveCount === 0
      ? "0 active members have no target recorded. Headline includes their OB but contributes no target denominator. Like-for-like excludes them entirely."
      : summaryMeta.zeroTargetActiveOb == null
      ? `${summaryMeta.zeroTargetActiveCount} active members have no target recorded - order booking is unavailable for the no-target group. Headline includes their OB but contributes no target denominator. Like-for-like excludes them entirely.`
      : `${summaryMeta.zeroTargetActiveCount} active members have no target recorded - carrying Rs ${(
          summaryMeta.zeroTargetActiveOb / 10_000_000
        ).toFixed(2)} Cr of order booking. Headline includes their OB but contributes no target denominator. Like-for-like excludes them entirely.`;

  // 1. Team summary
  const summary = inputTeamSummary(input, summaryMeta, sourceDashboard, disclosure, active, withTarget, headlineOperands);
  summary.workbook.getWorksheet("Team summary")?.addRow([
    "August secondary_head_month ordered (separate line)",
    input.teamSummary.augustSecondaryHeadOrdered ?? null,
    "secondary_head_month; state_head identity",
  ]);
  const comparison = summary.workbook.addWorksheet("State-head reconciliation");
  title(comparison, "State-head order reconciliation — separate measures", [
    "State head", "Product-Wise ex-GST", "August secondary ordered", "Difference", "Difference %",
  ]);
  for (const row of input.teamSummary.stateHeadComparison ?? []) {
    const excelRow = comparison.addRow([
      row.stateHead, row.productWiseOrderValue, row.augustSecondaryHeadOrdered,
      row.difference, row.percentage == null ? null : row.percentage / 100,
    ]);
    for (const col of [2, 3, 4]) money(excelRow.getCell(col), excelRow.getCell(col).value as number | null);
    excelRow.getCell(5).numFmt = "0.00%";
  }
  finish(comparison, [28, 22, 24, 20, 16]);
  summary.workbook.getWorksheet("Team summary")?.addRow([
    "Product-Wise order value (ex-GST; separate line)",
    input.teamSummary.productWiseOrderValue ?? null,
    "secondary_order_line.basic_order_value; person_registry identity",
  ]);
  summary.workbook.getWorksheet("Team summary")?.addRow([
    "Product-Wise mapping controls",
    `${input.teamSummary.productWiseMapping?.mappedCount ?? 0} mapped / ${input.teamSummary.productWiseMapping?.unmappedCount ?? 0} unmapped`,
    JSON.stringify(input.teamSummary.productWiseMapping?.reasons ?? {}),
  ]);

  // 2. Members
  const members = summary.workbook.addWorksheet("Members");
  title(members, "All members under selected state head", [
    "Member", "State head", "Status",
    "Target", "Target marker", "Target source",
    "Order booking", "OB marker", "OB source",
    "Sales received", "Sales marker", "Sales source",
    "Achievement", "Achievement marker", "Achievement source",
    "CTC", "CTC marker", "CTC source",
    "T.A.", "T.A. marker", "T.A. source",
    "Retailers", "Retailers marker", "Visited", "Visited marker",
    "Visits", "Visits marker", "Coverage source",
    "August secondary ordered (separate)", "Product-Wise ex-GST (separate)", "Product-Wise reason",
    "Excluded from LFL", "Exclusion reason",
  ]);
  for (const member of input.members) {
    const target = targetValue(input, member);
    const ob = obValue(input, member);
    const sales = salesValue(input, member);
    const achieve = target != null && target > 0 && ob != null ? ob / target * 100 : null;
    const excluded = exclusion(input, member);
    const targetReason = reasonValue(input, member, "targetReason") || (target == null ? "Target unavailable for selected period." : "");
    const obReason = reasonValue(input, member, "orderBookingReason") || (ob == null ? "Order booking unavailable for selected period." : "");
    const salesReason = reasonValue(input, member, "salesReason") || (sales == null ? "Sales unavailable for selected period." : "");
    const row = members.addRow([
      member.name, member.stateHead, member.isLeft ? "LEFT" : "Active",
      target, state(target), sourceValue(input, member, sourceDashboard),
      ob, state(ob), sourceValue(input, member, sourceDashboard),
      sales, state(sales), sourceValue(input, member, member.saleSource ?? sourceDashboard),
      achieve == null ? null : achieve / 100, state(achieve), achieve == null ? "Recomputed OB ÷ target; operand unavailable." : "Recomputed OB ÷ target",
      member.ctcMonthly, state(member.ctcMonthly), sourceCost,
      periodScoped ? null : member.taBillStCost, periodScoped ? "unavailable" : state(member.taBillStCost), sourceCost,
      periodScoped ? null : member.totalRetailers, periodScoped ? "unavailable" : state(member.totalRetailers),
      periodScoped ? null : member.visitedRetailers, periodScoped ? "unavailable" : state(member.visitedRetailers),
      periodScoped ? null : member.totalVisitsYtd, periodScoped ? "unavailable" : state(member.totalVisitsYtd), sourceCoverage,
      member.augustSecondaryHeadOrdered ?? null, member.productWiseOrderValue ?? null,
      member.productWiseOrderValueReason ?? "",
      excluded.excluded ? "Yes" : "No", excluded.reason,
    ]);
    for (const col of [4, 7, 10, 16, 19, 29, 30]) money(row.getCell(col), row.getCell(col).value as number | null);
    const achievementCell = row.getCell(13);
    achievementCell.numFmt = "0.00%";
    if (achieve == null) grey(achievementCell);
    for (const col of [22, 24, 26]) numeric(row.getCell(col), row.getCell(col).value as number | null);
    if (target == null) row.getCell(6).value = `${sourceValue(input, member, sourceDashboard)}; ${targetReason}`;
    if (ob == null) row.getCell(9).value = `${sourceValue(input, member, sourceDashboard)}; ${obReason}`;
    if (sales == null) row.getCell(12).value = `${sourceValue(input, member, member.saleSource ?? sourceDashboard)}; ${salesReason}`;
    if (periodScoped) {
      row.getCell(21).value = reasonValue(input, member, "taReason") || "T.A. is available only as YTD; unavailable for selected period.";
      row.getCell(28).value = reasonValue(input, member, "coverageReason") || "Coverage fields are not period-resolved by the authoritative monthly source.";
    }
  }
  finish(members, [30, 22, 12, 16, 14, 36, 18, 12, 36, 18, 14, 42, 16, 18, 28, 16, 14, 30, 16, 14, 30, 14, 18, 14, 18, 14, 18, 36, 18, 58]);

  // 3. Cost and ROI
  const cost = summary.workbook.addWorksheet("Cost and ROI");
  title(cost, "Cost and return on investment", [
    "Member / measure", "Status", "CTC", "T.A.", "Total cost", "Sales received",
    "Cost ratio", "Return per rupee", "Cost ratio marker", "Return marker", "Excluded from LFL", "Source", "Reason",
  ]);
  const reportingMonths = input.reportingMonthCount ?? null;
  const costMonths = input.periodReportingMonthCount ?? reportingMonths;
  const rowCost = (member: MemberKpis): number | null => {
    const ctc = member.ctcMonthly != null && costMonths != null
      ? member.ctcMonthly * costMonths
      : member.ctcAnnual != null && costMonths != null
        ? member.ctcAnnual * costMonths / 12
        : null;
    const ta = periodScoped ? null : member.taBillStCost;
    return ctc == null && ta == null ? null : (ctc ?? 0) + (ta ?? 0);
  };
  const memberCosts = active.map(rowCost);
  const totalCost = memberCosts.length === 0 || memberCosts.some((value) => value == null)
    ? null
    : memberCosts.reduce<number>((sum, value) => sum + value!, 0);
  const resolvedSales = active.map((member) => salesValue(input, member));
  const totalSales = resolvedSales.length > 0 && resolvedSales.every((value) => value != null)
    ? resolvedSales.reduce<number>((sum, value) => sum + value!, 0) : null;
  const totalCtc = active.length > 0 && active.every((member) => member.ctcMonthly != null && costMonths != null)
    ? active.reduce((sum, member) => sum + member.ctcMonthly! * costMonths!, 0) : null;
  const totalTa = periodScoped ? null : active.length > 0 && active.every((member) => member.taBillStCost != null)
    ? active.reduce((sum, member) => sum + member.taBillStCost!, 0) : null;
  const totalRow = cost.addRow(["HEAD TOTAL", "Active members", totalCtc, totalTa, totalCost, totalSales,
    totalCost != null && totalSales != null && totalSales > 0 ? totalCost / totalSales : null,
    totalCost != null && totalCost > 0 && totalSales != null ? totalSales / totalCost : null,
    state(totalCost != null && totalSales != null && totalSales > 0 ? totalCost / totalSales : null),
    state(totalCost != null && totalCost > 0 && totalSales != null ? totalSales / totalCost : null), "", sourceCost, ""]);
  money(totalRow.getCell(3), totalCtc); money(totalRow.getCell(4), totalTa); money(totalRow.getCell(5), totalCost); money(totalRow.getCell(6), totalSales);
  numeric(totalRow.getCell(7), totalCost != null && totalSales != null && totalSales > 0 ? totalCost / totalSales : null, "0.00%");
  numeric(totalRow.getCell(8), totalCost != null && totalCost > 0 && totalSales != null ? totalSales / totalCost : null, "0.00");
  const benchmark = input.companyBenchmark;
  const benchmarkRow = cost.addRow(["COMPANY BENCHMARK", benchmark?.population ?? "Company active population", null, null, null, null,
    benchmark?.costRatio, benchmark?.returnPerRupee, state(benchmark?.costRatio ?? null), state(benchmark?.returnPerRupee ?? null),
    "", benchmark?.source ?? "Company benchmark not resolved", benchmark ? `${benchmark.peerCount} peers` : "Unavailable"]);
  numeric(benchmarkRow.getCell(7), benchmark?.costRatio ?? null, "0.00%");
  numeric(benchmarkRow.getCell(8), benchmark?.returnPerRupee ?? null, "0.00");
  for (const member of input.members) {
    const total = rowCost(member);
    const sales = salesValue(input, member);
    const ratio = total != null && sales != null && sales > 0 ? total / sales : null;
    const roi = total != null && total > 0 && sales != null ? sales / total : null;
    const excluded = exclusion(input, member);
    const row = cost.addRow([member.name, member.isLeft ? "LEFT" : "Active",
      member.ctcMonthly != null && costMonths != null ? member.ctcMonthly * costMonths : null,
      periodScoped ? null : member.taBillStCost, total, salesValue(input, member), ratio, roi, state(ratio), state(roi),
      excluded.excluded ? "Yes" : "No", sourceCost,
      ratio == null || roi == null ? `Cost or sales operand unavailable; no zero substituted.${periodScoped ? " T.A. is YTD-only and excluded for selected period." : ""}` : "",
    ]);
    money(row.getCell(3), row.getCell(3).value as number | null); money(row.getCell(4), row.getCell(4).value as number | null);
    money(row.getCell(5), row.getCell(5).value as number | null); money(row.getCell(6), row.getCell(6).value as number | null);
    numeric(row.getCell(7), ratio, "0.00%"); numeric(row.getCell(8), roi, "0.00");
  }
  finish(cost, [30, 18, 16, 16, 18, 18, 16, 18, 18, 16, 18, 42, 58]);

  // 4. Missing data
  const missing = summary.workbook.addWorksheet("Missing data");
  title(missing, "Missing data and coverage limits", ["Member", "Data item", "Marker", "Reason", "Source", "Scope"]);
  for (const member of input.members) {
    const checks: Array<[string, number | null, string, string]> = [
      ["Target", targetValue(input, member), reasonValue(input, member, "targetReason") || "No target recorded for this member in the selected period.", sourceDashboard],
      ["Order booking", obValue(input, member), reasonValue(input, member, "orderBookingReason") || "No order-booking operand was resolved for the selected period.", sourceDashboard],
      ["Sales received", salesValue(input, member), reasonValue(input, member, "salesReason") || "Sales source returned no value for the selected period; this is unavailable, not zero.", member.saleSource ?? sourceDashboard],
      ["CTC", member.ctcMonthly, "CTC was not present in the resolved cost fields.", sourceCost],
      ["T.A.", periodScoped ? null : member.taBillStCost, periodScoped ? "T.A. is YTD-only and cannot be period-resolved." : "T.A. was not present in the resolved cost fields.", sourceCost],
      ["Retailers", periodScoped ? null : member.totalRetailers, periodScoped ? "Coverage is not period-resolved by the authoritative monthly source." : "Retailer coverage count was not resolved.", sourceCoverage],
      ["Visited", periodScoped ? null : member.visitedRetailers, periodScoped ? "Coverage is not period-resolved by the authoritative monthly source." : "Visited-retailer count was not resolved.", sourceCoverage],
      ["Visits", periodScoped ? null : member.totalVisitsYtd, periodScoped ? "Coverage is not period-resolved by the authoritative monthly source." : "Visit count was not resolved; unavailable is not zero.", sourceCoverage],
    ];
    for (const [item, value, reason, source] of checks) {
      if (value == null) missing.addRow([member.name, item, "unavailable", reason, source, "Selected state head"]);
    }
  }
  if (missing.rowCount === 2) missing.addRow(["", "No missing member-level fields", "value", "", sourceDashboard, "Selected state head"]);
  finish(missing, [30, 24, 18, 72, 48, 24]);

  // 5. Info
  const info = summary.workbook.addWorksheet("Info");
  title(info, "Export information, sources and coverage", ["Field", "Value"]);
  const infoRows: Array<[string, Scalar]> = [
    ["Scope", `All members under state head ${input.stateHead}`],
    ["State head", input.stateHead],
    ["FY", input.fy],
    ["Period / filters", input.periodLabel ?? "Full FY / current page selection"],
    ["Selected fiscal months", input.periodMonths?.join(", ") ?? "All resolved months"],
    ["Member count", input.members.length],
    ["Active members", active.length],
    ["LEFT members", input.members.filter((member) => member.isLeft).length],
    ["Dashboard source", sourceDashboard],
    ["Cost source", sourceCost],
    ["Coverage source", sourceCoverage],
    ["Target / OB / sales coverage", `${withTarget.length}/${active.length} active with target; ${active.filter((member) => obValue(input, member) != null).length}/${active.length} with OB; ${active.filter((member) => salesValue(input, member) != null).length}/${active.length} with sales`],
    ["Reporting month count for CTC", costMonths],
    ["Period resolution", periodScoped ? "Targets, OB, sales and achievement are summed from authoritative monthly arrays for the selected fiscal months. YTD-only cost/coverage fields are unavailable where not resolvable." : "Current page YTD values from the resolved Data tab."],
    ["Company benchmark", benchmark ? `${benchmark.population}; ${benchmark.peerCount} peers; ${benchmark.source}` : "Unavailable — no resolved company benchmark population"],
    ["Provisional months", input.provisionalMonths ?? "No provisional-month note supplied."],
    ["Data-read timestamp", input.dataReadAt == null ? null : new Date(input.dataReadAt).toISOString()],
    ["Generated timestamp", (input.generatedAt ?? new Date()).toISOString()],
    ["Snapshot basis", `${input.fromDbSnapshot ? "DB snapshot" : "live resolved read"}${input.stale ? "; stale snapshot served while source was busy" : ""}`],
    ["Order booking vs sales", "Order booking is committed order value; sales received is goods dispatched/received. They are separate measures and are not substituted."],
    ["Like-for-like disclosure", disclosure],
    ["Three-state markers", "value = resolved amount; zero = genuine resolved zero; unavailable = blank grey with a reason."],
  ];
  infoRows.forEach(([field, value]) => info.addRow([field, value]));
  finish(info, [36, 140]);

  for (const worksheet of summary.workbook.worksheets) {
    worksheet.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === "number" && !cell.numFmt) cell.numFmt = "#,##0";
    }));
  }
  return summary.workbook;
}

// Keeps the implementation above readable while allowing the first worksheet
// to be returned together with the workbook under construction.
type TeamSummaryMeta = Pick<
  TeamSummary,
  "activeMembers" | "leftMembers" | "zeroTargetActiveCount" | "zeroTargetActiveNames"
> & { zeroTargetActiveOb: number | null };

function inputTeamSummary(
  input: StateHeadDeepDiveExportInput,
  teamSummary: TeamSummaryMeta,
  source: string,
  disclosure: string,
  active: MemberKpis[],
  withTarget: MemberKpis[],
  operands: {
    headlineOb: number | null;
    headlineTarget: number | null;
    lflOb: number | null;
    lflTarget: number | null;
  },
): { workbook: ExcelJS.Workbook } {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Team summary");
  title(summary, "Team summary — selected state head", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Marker", "Source", "Reason"]);
  addOperand(summary, "Active members", teamSummary.activeMembers, source);
  addOperand(summary, "LEFT members", teamSummary.leftMembers, source);
  addOperand(summary, "Active members with no target", teamSummary.zeroTargetActiveCount, source);
  addRatio(summary, "Headline OB achievement", operands.headlineOb, operands.headlineTarget, source);
  addRatio(summary, "Like-for-like OB achievement", operands.lflOb, operands.lflTarget, source);
  const disclosureRow = summary.addRow(["Disclosure (verbatim)", disclosure]);
  summary.mergeCells(disclosureRow.number, 2, disclosureRow.number, 8);
  disclosureRow.getCell(2).alignment = { wrapText: true, vertical: "top" };
  summary.addRow(["Members excluded from like-for-like", teamSummary.zeroTargetActiveNames.join("; ") || "None"]);
  const names = teamSummary.zeroTargetActiveNames;
  if (names.length > 0) {
    for (const name of names) summary.addRow(["Excluded member", name]);
  }
  summary.addRow(["Coverage", `${active.length} active members in selected head; ${withTarget.length} with positive target.`]);
  finish(summary, [38, 36, 18, 18, 16, 18, 48, 72]);
  return { workbook };
}

export async function buildStateHeadDeepDiveExport(input: StateHeadDeepDiveExportInput): Promise<Buffer> {
  return Buffer.from(await buildStateHeadDeepDiveWorkbook(input).xlsx.writeBuffer());
}

/** Generated evidence used by focused tests and the export route log. */
export function stateHeadWorkbookEvidence(workbook: ExcelJS.Workbook): string {
  const sheets = workbook.worksheets.map((sheet) => `${sheet.name} (${sheet.rowCount} rows)`).join(", ");
  const info = workbook.getWorksheet("Info");
  const infoText = info
    ? (info.getRows(3, Math.max(0, info.rowCount - 2)) ?? [])
      .map((row) => `${String(row.getCell(1).value ?? "")}=${String(row.getCell(2).value ?? "")}`)
      .join(" | ")
    : "Info sheet missing";
  return `Sheets: ${sheets}\nInfo: ${infoText}`;
}
