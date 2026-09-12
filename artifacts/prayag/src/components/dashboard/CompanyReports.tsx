import { trunc2 } from "@/lib/trunc";
// Company-wide primary sales Reports 1-7.
//
// All reports read from sale_line (live register chain).
// Three rules enforced everywhere:
//   RULE 1 — LIKE MONTHS: only same calendar months as current FY so far.
//   RULE 2 — LITRE RULE: Report 4 qty is per-group only, never cross-group total.
//   RULE 3 — LIVE DATA: sale_line populated from live register chain.
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGlobalFilter } from "@/data/global-filter-context";
import { QuotaWaitBanner, quotaDelayMs } from "./quotaWait";
import { SnapshotBanner, useSnapshotRefresh } from "./snapshotRefresh";
import { AlertTriangle, Info, ChevronDown, ChevronUp, ChevronRight, Home, Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  entityFilterQuery,
  hasEntityFilter,
  type EntityFilterValue,
} from "./CompanyReportFilters";
import StateFilter from "../ui/StateFilter";
import { useToast } from "@/hooks/use-toast";
import { hydrateGlobalFilterFromUrl, serializeGlobalFilterToUrl, HydrationLock, statesEqual } from "@/data/global-filter-codec";

// ── Types (matching server CompanyReportsPayload) ─────────────────────────────

type ReportRow = {
  label: string;
  thisFy: number;
  lastFy: number;
  diff: number;
  growthPct: number | null;
  sharePct: number;
};

type QtyRow = {
  group: string;
  groupRaw: string;
  customer: string;
  state: string;
  qtyThisFy: number;
  qtyLastFy: number;
  amountThisFy: number;
  amountLastFy: number;
  unit: string;
};

type SaleCustomerRow = {
  customer: string;
  state: string;
  head: string;
  thisFy: number;
  lastFy: number;
  diff: number;
};

type GroupFullRow = {
  group: string;
  thisFyLike: number;
  lastFyLike: number;
  lastFyFull: number;
  growthLike: number | null;
};

type Payload = {
  fy: string;
  priorFy: string;
  likeMonths: string[];
  likeMonthsPrior: string[];
  asOfDate: string;
  r1r2_byState: ReportRow[];
  r1_partyByCustomer?: Array<SaleCustomerRow & { district: string }>;
  r2_byStateMonth?: Array<{ state: string; month: string; thisFy: number | null; lastFy: number | null }>;
  r3_byGroup: ReportRow[];
  r3_bySubcategory?: Array<{ group: string; subcategory: string; thisFy: number; lastFy: number }>;
  r3a_byStateGroup: Array<{ state: string; group: string; subcategory: string; thisFy: number; lastFy: number }>;
  r3b_byPartyGroup: Array<{ customer: string; state: string; group: string; subcategory: string; thisFy: number; lastFy: number }>;
  r3c_byGroupFull: GroupFullRow[];
  r4_byGroupQty: QtyRow[];
  r5_byCustomer: SaleCustomerRow[];
  r5_collectionNote: string;
  r6_byGroupFull: GroupFullRow[];
  r6_bySubcategoryFull?: Array<{ group: string; subcategory: string; thisFyLike: number; lastFyLike: number; lastFyFull: number; growthLike: number | null }>;
  r7_asOf: {
    date: string;
    total: number;
    byGroup: Array<{ group: string; amount: number }>;
    byState: Array<{ state: string; amount: number }>;
    invoiceCount: number;
    customerCount: number;
    note: string;
  };
  monthlyPrimary?: Array<{ label: string; amount: number }>;
  meta?: { snapshotSavedAt?: number; refreshing?: boolean };
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  return `\u20b9${trunc2((n / 1e7))} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "\u2014";
  return `${n >= 0 ? "+" : ""}${n}%`;
}

function fmtQty(n: number, unit: string): string {
  const unitLabel = unit === "L" || unit.toUpperCase() === "LTR" || unit.toUpperCase() === "LITRE"
    ? "L" : unit || "pcs";
  return `${n.toLocaleString("en-IN")} ${unitLabel}`;
}

function growthColor(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  return pct >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400";
}

// ── Shared table components ───────────────────────────────────────────────────

function CompareTable({
  rows,
  fyLabel,
  priorFyLabel,
  limit = 30,
  showGrowth = true,
  onRowClick,
  parentAmount,
}: {
  rows: ReportRow[];
  fyLabel: string;
  priorFyLabel: string;
  limit?: number;
  showGrowth?: boolean;
  onRowClick?: (label: string) => void;
  parentAmount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = expanded ? rows : rows.slice(0, limit);

  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 px-1">No data for this selection.</p>;
  }

  const totalThis = rows.reduce((s, r) => s + r.thisFy, 0);
  const totalLast = rows.reduce((s, r) => s + r.lastFy, 0);

  return (
    <div className="rounded-lg border border-border overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Name</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">{fyLabel}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">{priorFyLabel}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Diff</th>
            {showGrowth && <th className="text-right py-2 px-3 font-medium text-muted-foreground">Growth</th>}
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Share</th>
          </tr>
        </thead>
        <tbody>
          {display.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(r.label) : undefined} className={cn("border-b border-border/30 hover:bg-muted/20", onRowClick && "cursor-pointer hover:bg-muted/40 transition-colors")}>
              <td className="py-1.5 px-3 max-w-[180px] truncate">{r.label}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.thisFy)}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFy)}</td>
              <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", r.diff >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                {r.diff >= 0 ? "+" : ""}{fmtCr(r.diff)}
              </td>
              {showGrowth && (
                <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", growthColor(r.growthPct))}>
                  {fmtPct(r.growthPct)}
                </td>
              )}
              <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{r.sharePct}%</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-muted/30 border-t border-border font-semibold">
            <td className="py-1.5 px-3">Total</td>
            <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(totalThis)}</td>
            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(totalLast)}</td>
            <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", totalThis - totalLast >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
              {totalThis - totalLast >= 0 ? "+" : ""}{fmtCr(totalThis - totalLast)}
            </td>
            {showGrowth && <td className="py-1.5 px-3" />}
            <td className="py-1.5 px-3" />
          </tr>
          {parentAmount !== undefined && (
            <>
              <tr className="bg-muted/10 font-medium text-muted-foreground">
                <td className="py-1.5 px-3">Parent Record Total</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(parentAmount)}</td>
                <td colSpan={showGrowth ? 4 : 3} />
              </tr>
              <tr className={Math.abs(totalThis - parentAmount) >= 100000 ? "bg-red-500/10 font-semibold text-red-700 dark:text-red-400" : "bg-muted/10 font-medium text-muted-foreground"}>
                <td className="py-1.5 px-3">Mismatch (Unattributed)</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(totalThis - parentAmount)}</td>
                <td colSpan={showGrowth ? 4 : 3} />
              </tr>
            </>
          )}
        </tfoot>
      </table>
      {rows.length > limit && !expanded && (
        <button
          className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30"
          onClick={() => setExpanded(true)}
        >
          Show all {rows.length} rows
        </button>
      )}
    </div>
  );
}

// ── Like-months label ─────────────────────────────────────────────────────────

function LikeMonthsBadge({ months, priorMonths, fy, priorFy }: { months: string[]; priorMonths: string[]; fy: string; priorFy: string }) {
  if (months.length === 0) return null;
  const first = months[0].slice(0, 3);
  const last = months[months.length - 1].slice(0, 3);
  const range = first === last ? first : `${first}–${last}`;
  return (
    <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-500/5 p-2.5 text-xs text-blue-800 dark:text-blue-300">
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
      <span>
        <strong>Rule 1 — Like months:</strong> comparing {range} FY {fy} ({months.length} month{months.length !== 1 ? "s" : ""})
        against the same {range} months of FY {priorFy}. {months.length < 12 ? "Incomplete current year — never compare to full prior year." : "Full year."}
      </span>
    </div>
  );
}

// ── Report 4 ──────────────────────────────────────────────────────────────────

function Report4({ rows, fy, priorFy, likeMonths }: { rows: QtyRow[]; fy: string; priorFy: string; likeMonths: string[] }) {
  const groups = useMemo(() => [...new Set(rows.map((r) => r.group))].sort(), [rows]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  const activeGroup = selectedGroup || groups[0] || "";
  const groupRows = useMemo(
    () => rows.filter((r) => r.group === activeGroup).sort((a, b) => b.amountThisFy - a.amountThisFy),
    [rows, activeGroup],
  );

  // Detect if this group has mixed units (e.g. Plumbing mixes WATER TANK Ltr with pipe pcs).
  const hasMixedCategories = useMemo(
    () => new Set(groupRows.map((r) => r.unit || "pcs")).size > 1,
    [groupRows],
  );

  const fmtRowUnit = (unit: string) => (unit === "Ltr" ? "Ltr" : unit || "pcs");

  const [expanded, setExpanded] = useState(false);
  const LIMIT = 40;
  const display = expanded ? groupRows : groupRows.slice(0, LIMIT);

  const totalAmountThis = groupRows.reduce((s, r) => s + r.amountThisFy, 0);
  const totalAmountLast = groupRows.reduce((s, r) => s + r.amountLastFy, 0);

  const first = likeMonths[0]?.slice(0, 3) ?? "";
  const last = likeMonths[likeMonths.length - 1]?.slice(0, 3) ?? "";
  const range = first === last ? first : `${first}–${last}`;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          <strong>Rule 2 — Litre rule:</strong> quantity is shown per group only. Water tanks are in litres; everything else is in pieces.
          Never sum quantity across groups — the total would be meaningless. Select one group below.
        </span>
      </div>

      {groups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => { setSelectedGroup(g); setExpanded(false); }}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                activeGroup === g
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {activeGroup && (
        <>
          <p className="text-xs text-muted-foreground">
            Group: <strong>{activeGroup}</strong>
            {hasMixedCategories
              ? <span className="text-amber-600"> — mixed units (litres + pieces — see each row)</span>
              : null}
            {range && ` — ${range} comparison`}
          </p>
          <div className="rounded-lg border border-border overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Customer</th>
                  {hasMixedCategories && <th className="text-left py-2 px-3 font-medium text-muted-foreground">Category</th>}
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Qty {fy}</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Qty {priorFy}</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount {fy}</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount {priorFy}</th>
                </tr>
              </thead>
              <tbody>
                {display.map((r, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="py-1.5 px-3 max-w-[160px] truncate">{r.customer || "—"}</td>
                    {hasMixedCategories && <td className="py-1.5 px-3 text-[11px] text-muted-foreground">{r.groupRaw || "—"}</td>}
                    <td className="py-1.5 px-3 max-w-[120px] truncate text-muted-foreground">{r.state || "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{r.qtyThisFy > 0 ? `${r.qtyThisFy.toLocaleString("en-IN")} ${fmtRowUnit(r.unit)}` : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{r.qtyLastFy > 0 ? `${r.qtyLastFy.toLocaleString("en-IN")} ${fmtRowUnit(r.unit)}` : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{r.amountThisFy > 0 ? fmtCr(r.amountThisFy) : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{r.amountLastFy > 0 ? fmtCr(r.amountLastFy) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 border-t border-border font-semibold">
                  <td className="py-1.5 px-3" colSpan={hasMixedCategories ? 3 : 2}>Total amount</td>
                  <td className="py-1.5 px-3 text-right text-muted-foreground text-[10px] italic" colSpan={2}>
                    qty total suppressed (Rule 2)
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(totalAmountThis)}</td>
                  <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(totalAmountLast)}</td>
                </tr>
              </tfoot>
            </table>
            {groupRows.length > LIMIT && !expanded && (
              <button
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30"
                onClick={() => setExpanded(true)}
              >
                Show all {groupRows.length} rows
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}


// ── Shared Drill Components ───────────────────────────────────────────────────

type ColumnDef<T> = {
  header: string;
  align?: "left" | "right";
  isSumTarget?: boolean;
  render: (row: T) => React.ReactNode;
};

function DrillTable<T>({
  rows,
  columns,
  onRowClick,
  parentAmount,
  amountKey,
  limit = 50,
  isTruncated = false,
  totalRows,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  onRowClick?: (row: T) => void;
  parentAmount?: number;
  amountKey?: (row: T) => number;
  limit?: number;
  isTruncated?: boolean;
  totalRows?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = expanded ? rows : rows.slice(0, limit);

  const sumAmount = amountKey ? rows.reduce((s, r) => s + amountKey(r), 0) : 0;
  const mismatch = parentAmount !== undefined ? sumAmount - parentAmount : 0;
  const colSpanTarget = Math.max(1, columns.findIndex(c => c.isSumTarget));

  return (
    <div className="rounded-lg border border-border overflow-auto bg-card">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            {columns.map((c, i) => (
              <th key={i} className={cn("py-2 px-3 font-medium text-muted-foreground", c.align === "right" ? "text-right" : "text-left")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="py-4 text-center text-muted-foreground">No data for this selection.</td>
            </tr>
          )}
          {display.map((r, i) => (
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn(
                "border-b border-border/30",
                onRowClick ? "cursor-pointer hover:bg-muted/40 transition-colors" : "hover:bg-muted/20"
              )}
            >
              {columns.map((c, j) => (
                <td key={j} className={cn("py-1.5 px-3", c.align === "right" && "text-right font-mono tabular-nums")}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {amountKey && (
          <tfoot>
            <tr className="bg-muted/30 border-t border-border font-semibold">
              <td colSpan={colSpanTarget} className="py-1.5 px-3 text-muted-foreground">Total</td>
              {columns.slice(colSpanTarget).map((c, i) => {
                if (c.isSumTarget) return <td key={i} className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(sumAmount)}</td>;
                return <td key={i} />;
              })}
            </tr>
            {parentAmount !== undefined && (
              <>
                <tr className="bg-muted/10 font-medium text-muted-foreground">
                  <td colSpan={colSpanTarget} className="py-1.5 px-3">Parent Record Total</td>
                  {columns.slice(colSpanTarget).map((c, i) => {
                    if (c.isSumTarget) return <td key={i} className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(parentAmount)}</td>;
                    return <td key={i} />;
                  })}
                </tr>
                <tr className={!isTruncated && Math.abs(mismatch) >= 100000 ? "bg-red-500/10 font-semibold text-red-700 dark:text-red-400" : "bg-muted/10 font-medium text-muted-foreground"}>
                  <td colSpan={colSpanTarget} className="py-1.5 px-3">{isTruncated ? "Mismatch (Truncated)" : "Mismatch (Unattributed)"}</td>
                  {columns.slice(colSpanTarget).map((c, i) => {
                    if (c.isSumTarget) return <td key={i} className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(mismatch)}</td>;
                    return <td key={i} />;
                  })}
                </tr>
              </>
            )}
          </tfoot>
        )}
      </table>
      {rows.length > limit && !expanded && (
        <button
          className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30 transition-colors"
          onClick={() => setExpanded(true)}
        >
          Show all {rows.length} {isTruncated ? `(of ${totalRows} total)` : "rows"}
        </button>
      )}
      {isTruncated && expanded && (
        <div className="w-full py-2 text-xs text-center text-muted-foreground border-t border-border/30">
          Showing maximum {rows.length} rows (out of {totalRows} matching items)
        </div>
      )}
    </div>
  );
}

function DrillBreadcrumbs({ reportLabel, drillPath, onNavigate }: { reportLabel: string; drillPath: string[]; onNavigate: (index: number) => void; }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm mb-4 bg-muted/30 px-3 py-2 rounded-lg border border-border">
      <button onClick={() => onNavigate(-1)} className={cn("flex items-center gap-1.5 font-medium transition-colors", drillPath.length === 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
        <Home className="h-4 w-4" /> {reportLabel}
      </button>
      {drillPath.map((segment, i) => (
        <div key={i} className="flex items-center gap-2">
          <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
          <button onClick={() => onNavigate(i)} className={cn("font-medium transition-colors max-w-[200px] truncate", i === drillPath.length - 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {segment}
          </button>
        </div>
      ))}
    </div>
  );
}

function DiffCell({ value }: { value: number }) {
  if (value === 0) return <span className="text-muted-foreground">—</span>;
  return <span className={value > 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
    {value > 0 ? "+" : ""}{fmtCr(value)}
  </span>;
}

function GrowthCell({ value }: { value: number | null }) {
  return <span className={growthColor(value)}>{fmtPct(value)}</span>;
}

function R4ItemDrill({ fy, priorFy, state, customer, group, months, entityFilter }: { fy: string; priorFy: string; state: string; customer: string; group: string; months: string; entityFilter: EntityFilterValue }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["r4items", fy, state, customer, group, months, entityFilter.heads],
    queryFn: async () => {
      const q = new URLSearchParams();
      q.set("fy", fy);
      q.set("state", state);
      q.set("customers", JSON.stringify([customer]));
      q.set("group", group);
      if (months) q.set("months", months);
      if (entityFilter.heads.length > 0) q.set("heads", JSON.stringify(entityFilter.heads));
      const url = `/api/company-reports/r4/items?${q.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch items");
      return res.json() as Promise<{
        rows: Array<{
          code: string; itemName: string; group: string; subcategory: string;
          qtyThisFy: number; qtyLastFy: number;
          amountThisFy: number; amountLastFy: number;
        }>;
        truncated: boolean;
        totalRows: number;
        reconciliation: { parentAmount: number; childAmount: number; delta: number; unattributed: number | null; complete: boolean };
      }>;
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading items...</span>
      </div>
    );
  }
  if (error) return <div className="py-8 text-center text-sm text-destructive">Failed to load items.</div>;
  if (!data) return null;

  return (
    <DrillTable
      rows={data.rows}
      isTruncated={data.truncated}
      totalRows={data.totalRows}
      parentAmount={data.reconciliation.parentAmount}
      amountKey={(r) => r.amountThisFy}
      columns={[
        { header: "Item Code", render: r => <span className="text-muted-foreground">{r.code}</span> },
        { header: "Name", render: r => r.itemName },
        { header: "Sub-category", render: r => <span className="text-[11px] text-muted-foreground">{r.subcategory}</span> },
        { header: `Qty FY ${fy}`, align: "right", render: r => r.qtyThisFy > 0 ? r.qtyThisFy.toLocaleString("en-IN") : "—" },
        { header: `Qty FY ${priorFy}`, align: "right", render: r => r.qtyLastFy > 0 ? r.qtyLastFy.toLocaleString("en-IN") : "—" },
        { header: `Amount FY ${fy}`, align: "right", isSumTarget: true, render: r => r.amountThisFy > 0 ? fmtCr(r.amountThisFy) : "—" },
        { header: `Amount FY ${priorFy}`, align: "right", render: r => r.amountLastFy > 0 ? fmtCr(r.amountLastFy) : "—" },
      ]}
    />
  );
}

function R7PartyDrill({ fy, asOf, type, value, entityFilter, months }: { fy: string; asOf: string; type: "state" | "group"; value: string; entityFilter: EntityFilterValue; months: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["r7parties", fy, asOf, type, value, entityFilter.heads, entityFilter.states, entityFilter.customers, months],
    queryFn: async () => {
      const q = new URLSearchParams();
      q.set("fy", fy);
      q.set("asOf", asOf);
      q.set(type, value);
      if (entityFilter.heads.length > 0) q.set("heads", JSON.stringify(entityFilter.heads));
      if (entityFilter.states.length > 0) q.set("states", JSON.stringify(entityFilter.states));
      if (entityFilter.customers.length > 0) q.set("customers", JSON.stringify(entityFilter.customers));
      if (months) q.set("months", months);
      const url = `/api/company-reports/r7/parties?${q.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch parties");
      return res.json() as Promise<{
        rows: Array<{ customer: string; state: string; group: string; amount: number }>;
        reconciliation: { parentAmount: number; childAmount: number; delta: number };
      }>;
    }
  });

  if (isLoading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading parties...</div>;
  if (error) return <div className="py-8 text-center text-sm text-destructive">Failed to load parties.</div>;
  if (!data) return null;

  return (
    <DrillTable
      rows={data.rows}
      parentAmount={data.reconciliation.parentAmount}
      amountKey={(r) => r.amount}
      columns={[
        { header: "Party", render: r => r.customer },
        { header: "State", render: r => <span className="text-muted-foreground">{r.state}</span> },
        { header: "Group", render: r => <span className="text-muted-foreground">{r.group}</span> },
        { header: "Amount", align: "right", isSumTarget: true, render: r => fmtCr(r.amount) },
      ]}
    />
  );
}

// ── Master Router Component ───────────────────────────────────────────────────

type ReportId = "1" | "2" | "3" | "3a" | "3b" | "4" | "5" | "6" | "7";

const TABS: { id: ReportId; label: string; description: string }[] = [
  { id: "1", label: "Report 1", description: "State → Party" },
  { id: "2", label: "Report 2", description: "State → Month (Growth sorted)" },
  { id: "3", label: "Report 3", description: "Master → Sub-category" },
  { id: "3a", label: "Report 3A", description: "State → Master → Sub-category" },
  { id: "3b", label: "Report 3B", description: "State → Party → Master" },
  { id: "4", label: "Report 4", description: "State → Party → Group → Item (Qty/Amount)" },
  { id: "5", label: "Report 5", description: "Customer → Group" },
  { id: "6", label: "Report 6", description: "Master → Sub-category (Full Prior Year)" },
  { id: "7", label: "Report 7", description: "As-of date snapshot (State/Group → Party)" },
];

export default function CompanyReports() {
  const { fy, periodMode, monthIdx, rangeFrom, rangeTo, applyGlobalFilterState, effectivePeriodFrom, effectivePrimaryPeriodTo, effectivePeriodLabel } = useGlobalFilter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = useMemo(() => new URLSearchParams(searchString), [searchString]);

  const hydrationLock = useMemo(() => new HydrationLock(), []);

  const currentStateRef = useRef({ fy, periodMode, monthIdx, rangeFrom, rangeTo });
  currentStateRef.current = { fy, periodMode, monthIdx, rangeFrom, rangeTo };

  // Window popstate hydration listener
  useEffect(() => {
    const handlePopState = () => {
      const currentParams = new URLSearchParams(window.location.search);
      if (currentParams.has("fy")) {
        const urlState = hydrateGlobalFilterFromUrl(currentParams);
        if (!statesEqual(urlState, currentStateRef.current)) {
          hydrationLock.setPending(urlState, currentStateRef.current);
          applyGlobalFilterState(urlState);
        }
      }
    };

    window.addEventListener("popstate", handlePopState);

    // Initial mount hydration
    const currentParams = new URLSearchParams(window.location.search);
    if (currentParams.has("fy")) {
      const urlState = hydrateGlobalFilterFromUrl(currentParams);
      if (!statesEqual(urlState, currentStateRef.current)) {
        hydrationLock.setPending(urlState, currentStateRef.current);
        applyGlobalFilterState(urlState);
      }
    } else {
      const nextParams = new URLSearchParams(currentParams);
      if (serializeGlobalFilterToUrl(nextParams, currentStateRef.current)) {
        setLocation(window.location.pathname + "?" + nextParams.toString(), { replace: true });
      }
    }

    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyGlobalFilterState, setLocation, hydrationLock]);

  // Context -> URL synchronization effect
  useEffect(() => {
    const currentState = { fy, periodMode, monthIdx, rangeFrom, rangeTo };

    if (hydrationLock.shouldBlockSync(currentState)) {
      return;
    }

    // Normal context change -> write to URL
    const nextParams = new URLSearchParams(window.location.search);
    const changed = serializeGlobalFilterToUrl(nextParams, currentState);
    if (changed) {
      setLocation(window.location.pathname + "?" + nextParams.toString(), { replace: true });
    }
  }, [fy, periodMode, monthIdx, rangeFrom, rangeTo, setLocation, hydrationLock]);

  const activeReport = (searchParams.get("report") as ReportId) || "1";
  const drillPath = useMemo(() => searchParams.getAll("drill"), [searchParams]);
  const { toast } = useToast();

  const setActiveReport = useCallback((newReport: string, replace = false) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("report", newReport);
    nextParams.delete("drill");
    setLocation(window.location.pathname + "?" + nextParams.toString(), { replace });
  }, [searchParams, setLocation]);

  const onDrill = useCallback((segment: string) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.append("drill", segment);
    setLocation(window.location.pathname + "?" + nextParams.toString());
  }, [searchParams, setLocation]);

  const handleNavigate = useCallback((index: number, replace = false) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("drill");
    drillPath.slice(0, index + 1).forEach(p => nextParams.append("drill", p));
    setLocation(window.location.pathname + "?" + nextParams.toString(), { replace });
  }, [searchParams, drillPath, setLocation]);

  const entityFilter = useMemo<EntityFilterValue>(() => {
    const parse = (k: string) => {
      try { const v = JSON.parse(searchParams.get(k) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
    };
    return { heads: parse("heads"), states: parse("states"), customers: parse("customers") };
  }, [searchParams]);

  const setEntityFilter = useCallback((next: EntityFilterValue) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next.heads.length) nextParams.set("heads", JSON.stringify(next.heads)); else nextParams.delete("heads");
    if (next.states.length) nextParams.set("states", JSON.stringify(next.states)); else nextParams.delete("states");
    if (next.customers.length) nextParams.set("customers", JSON.stringify(next.customers)); else nextParams.delete("customers");
    nextParams.delete("drill"); // clear drill on filter change
    setLocation(window.location.pathname + "?" + nextParams.toString());
  }, [searchParams, setLocation]);

  const monthsParam = useMemo(() => {
    if (periodMode === "ytd" || periodMode === "full") return "";
    const fyStart = parseInt(fy.split("-")[0], 10);
    if (isNaN(fyStart)) return "";
    const NAMES = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
    const labels: string[] = [];
    for (let m = effectivePeriodFrom; m <= effectivePrimaryPeriodTo; m++) {
      const yy = m <= 9 ? fyStart : fyStart + 1;
      labels.push(`${NAMES[m - 1]}-${String(yy).slice(-2)}`);
    }
    return labels.length > 0 ? labels.join(",") : "";
  }, [periodMode, fy, effectivePeriodFrom, effectivePrimaryPeriodTo]);

  const filterQuery = useMemo(
    () => `${monthsParam ? `&months=${encodeURIComponent(monthsParam)}` : ""}${entityFilterQuery(entityFilter)}`,
    [monthsParam, entityFilter],
  );
  const filtersActive = monthsParam !== "" || hasEntityFilter(entityFilter);

  useEffect(() => {
    if (!data) return;
    let validLength = 0;

    let validReport = activeReport;
    if (!["1", "2", "3", "3a", "3b", "4", "5", "6", "7"].includes(validReport)) {
      validReport = "1";
    }

    if (drillPath.length > 0) {
      if (validReport === "1" || validReport === "2") {
        validLength = data.r1r2_byState.some(r => r.label === drillPath[0]) ? 1 : 0;
      } else if (validReport === "3") {
        validLength = data.r3_byGroup.some(r => r.label === drillPath[0]) ? 1 : 0;
      } else if (validReport === "3a") {
        if (data.r3a_byStateGroup.some(r => r.state === drillPath[0])) {
          validLength = 1;
          if (drillPath.length > 1 && data.r3a_byStateGroup.some(r => r.state === drillPath[0] && r.group === drillPath[1])) validLength = 2;
        }
      } else if (validReport === "3b") {
        if (data.r3b_byPartyGroup.some(r => r.state === drillPath[0])) {
          validLength = 1;
          if (drillPath.length > 1 && data.r3b_byPartyGroup.some(r => r.state === drillPath[0] && r.customer === drillPath[1])) {
            validLength = 2;
          }
        }
      } else if (validReport === "4") {
        if (data.r4_byGroupQty.some(r => r.state === drillPath[0])) {
          validLength = 1;
          if (drillPath.length > 1 && data.r4_byGroupQty.some(r => r.state === drillPath[0] && r.customer === drillPath[1])) {
            validLength = 2;
            if (drillPath.length > 2 && data.r4_byGroupQty.some(r => r.state === drillPath[0] && r.customer === drillPath[1] && r.group === drillPath[2])) {
              validLength = 3;
            }
          }
        }
      } else if (validReport === "5") {
        validLength = data.r5_byCustomer.some(r => r.customer === drillPath[0]) ? 1 : 0;
      } else if (validReport === "6") {
        validLength = data.r6_byGroupFull.some(r => r.group === drillPath[0]) ? 1 : 0;
      } else if (validReport === "7") {
        if (drillPath[0].startsWith("group:")) {
          validLength = data.r7_asOf.byGroup.some(r => r.group === drillPath[0].slice(6)) ? 1 : 0;
        } else if (drillPath[0].startsWith("state:")) {
          validLength = data.r7_asOf.byState.some(r => r.state === drillPath[0].slice(6)) ? 1 : 0;
        }
      }
    }

    if (validReport !== activeReport) {
      toast({ title: "Invalid report", description: "Report not found, redirecting to Report 1.", variant: "destructive" });
      setActiveReport("1", true);
    } else if (drillPath.length > validLength) {
      toast({ title: "Drill path reset", description: "The previously selected rows are no longer present in the current filter scope.", variant: "destructive" });
      handleNavigate(validLength - 1, true);
    }
  }, [data, activeReport, drillPath, handleNavigate, setActiveReport, toast]);

  const [quotaWait, setQuotaWait] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  const dataUrl = `/api/company-reports?fy=${encodeURIComponent(fy)}${filterQuery}`;
  useSnapshotRefresh(data?.meta, dataUrl, (fresh) => setData(fresh as Payload));

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(dataUrl)
      .then((r) => {
        if (!r.ok)
          return r.json().then((e: { error?: string; quota?: boolean; retryAfter?: number }) => {
            if (r.status === 503 && e.quota) {
              setQuotaWait(true);
              setLoading(false);
              retryTimer = setTimeout(() => setRetryTick((t) => t + 1), quotaDelayMs(e.retryAfter));
              return null;
            }
            throw new Error(e.error ?? r.statusText);
          });
        return r.json() as Promise<Payload>;
      })
      .then((d) => {
        if (d === null) return;
        setQuotaWait(false);
        setData(d);
        setLoading(false);
      })
      .catch((err: Error) => { setQuotaWait(false); setError(err.message); setLoading(false); });
    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [dataUrl, retryTick]);

  const likeMonthsLabel = useMemo(() => {
    if (!data || data.likeMonths.length === 0) return "";
    const first = data.likeMonths[0].slice(0, 3);
    const last = data.likeMonths[data.likeMonths.length - 1].slice(0, 3);
    return first === last ? first : `${first}–${last}`;
  }, [data]);

  const priorFy = data?.priorFy || "";
  const activeTabObj = TABS.find((t) => t.id === activeReport);

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Company Reports 1–7</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Primary sales (Prayag to Distributors) — from live invoice register.
            {data && likeMonthsLabel ? ` Comparing ${likeMonthsLabel} FY ${fy} vs FY ${data.priorFy}.` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/company-reports/export?fy=${encodeURIComponent(fy)}${filterQuery}`}
            download
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted shadow-sm transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download report
          </a>
          <a
            href={`/api/company-reports/working-data?fy=${encodeURIComponent(fy)}${filterQuery}`}
            download
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted shadow-sm transition-colors"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Download working data
          </a>
        </div>
      </div>

      {/* Entity filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CompanyReportFilterBar fy={fy} value={entityFilter} onChange={setEntityFilter} />
        {periodMode !== "ytd" && periodMode !== "full" && (
          <span className="rounded-md bg-blue-500/10 px-2 py-1 text-[11px] text-blue-800 dark:text-blue-300">
            Period: {effectivePeriodLabel} — compared against the same months last year
          </span>
        )}
      </div>
      {filtersActive && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Filters active — figures below are a subset and will not match the unfiltered company totals.
        </p>
      )}

      {/* State */}
      {quotaWait && <QuotaWaitBanner testId="quota-wait" />}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">
          Failed to load company reports: {error}
        </div>
      )}
      {!data && loading && !quotaWait && (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading primary sales data...</div>
      )}

      {/* Body */}
      {data && (
        <>
          <SnapshotBanner meta={data.meta} />

          {data.likeMonths.length === 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>No complete months found in {fy} sale data. Backfill the register to see reports.</span>
            </div>
          )}

          {/* Tab bar */}
          <div className="overflow-x-auto">
            <div className="flex gap-1 border-b border-border pb-0 min-w-max">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveReport(t.id)}
                  className={cn(
                    "px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
                    activeReport === t.id
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{activeTabObj?.description}</p>

          {/* Report content */}
          {drillPath.length > 0 && <DrillBreadcrumbs reportLabel={activeTabObj?.label || "Report"} drillPath={drillPath} onNavigate={handleNavigate} />}

          {activeReport === "1" && (() => {
            if (drillPath.length === 0) {
              return <CompareTable rows={data.r1r2_byState} fyLabel={`FY ${fy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`} priorFyLabel={`FY ${data.priorFy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`} onRowClick={(val) => data.r1_partyByCustomer?.some(c => c.state === val) ? onDrill(val) : undefined} />;
            }
            if (drillPath.length === 1) {
              const state = drillPath[0];
              const parentRow = data.r1r2_byState.find(r => r.label === state);
              const rows = data.r1_partyByCustomer?.filter(r => r.state === state) ?? [];
              return <DrillTable
                rows={rows}
                parentAmount={parentRow?.thisFy}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Party", render: r => r.customer || "—" },
                  { header: "District", render: r => <span className="text-muted-foreground">{r.district || "—"}</span> },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.diff} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "2" && (() => {
            if (drillPath.length === 0) {
              const rows = [...data.r1r2_byState].sort((a, b) => {
                if (a.growthPct == null && b.growthPct == null) return 0;
                if (a.growthPct == null) return 1;
                if (b.growthPct == null) return -1;
                return b.growthPct - a.growthPct;
              });
              return <CompareTable rows={rows} fyLabel={`FY ${fy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`} priorFyLabel={`FY ${data.priorFy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`} showGrowth onRowClick={(val) => data.r2_byStateMonth?.some(c => c.state === val) ? onDrill(val) : undefined} />;
            }
            if (drillPath.length === 1) {
              const state = drillPath[0];
              const parentRow = data.r1r2_byState.find(r => r.label === state);
              const rows = data.r2_byStateMonth?.filter(r => r.state === state) ?? [];
              return <DrillTable
                rows={rows}
                parentAmount={parentRow?.thisFy}
                amountKey={r => r.thisFy || 0}
                columns={[
                  { header: "Month", render: r => r.month },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => r.thisFy != null ? fmtCr(r.thisFy) : "—" },
                  { header: `FY ${priorFy}`, align: "right", render: r => r.lastFy != null ? fmtCr(r.lastFy) : "—" },
                  { header: "Diff", align: "right", render: r => <DiffCell value={(r.thisFy || 0) - (r.lastFy || 0)} /> },
                  { header: "Growth", align: "right", render: r => <GrowthCell value={r.lastFy ? (((r.thisFy || 0) / r.lastFy) - 1) * 100 : null} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "3" && (() => {
            if (drillPath.length === 0) {
              return <CompareTable rows={data.r3_byGroup} fyLabel={`FY ${fy}`} priorFyLabel={`FY ${priorFy}`} onRowClick={(val) => data.r3_bySubcategory?.some(c => c.group === val) ? onDrill(val) : undefined} />;
            }
            if (drillPath.length === 1) {
              const group = drillPath[0];
              const parentRow = data.r3_byGroup.find(r => r.label === group);
              const rows = data.r3_bySubcategory?.filter(r => r.group === group) ?? [];
              return <DrillTable
                rows={rows}
                parentAmount={parentRow?.thisFy}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Sub-category", render: r => r.subcategory },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                  { header: "Growth", align: "right", render: r => <GrowthCell value={r.lastFy ? ((r.thisFy / r.lastFy) - 1) * 100 : null} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "3a" && (() => {
            if (drillPath.length === 0) {
              const rowsMap = new Map<string, { state: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3a_byStateGroup) {
                const ex = rowsMap.get(r.state) ?? { state: r.state, thisFy: 0, lastFy: 0 };
                ex.thisFy += r.thisFy;
                ex.lastFy += r.lastFy;
                rowsMap.set(r.state, ex);
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r3a_byStateGroup.some(c => c.state === r.state && c.group) ? onDrill(r.state) : undefined}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "State", render: r => r.state },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            if (drillPath.length === 1) {
              const state = drillPath[0];
              const parentAmount = data.r3a_byStateGroup.filter(r => r.state === state).reduce((s, r) => s + r.thisFy, 0);
              const rowsMap = new Map<string, { group: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3a_byStateGroup) {
                if (r.state === state) {
                  const ex = rowsMap.get(r.group) ?? { group: r.group, thisFy: 0, lastFy: 0 };
                  ex.thisFy += r.thisFy;
                  ex.lastFy += r.lastFy;
                  rowsMap.set(r.group, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r3a_byStateGroup.some(c => c.state === state && c.group === r.group && c.subcategory) ? onDrill(r.group) : undefined}
                parentAmount={parentAmount}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Master Group", render: r => r.group },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            if (drillPath.length === 2) {
              const state = drillPath[0];
              const group = drillPath[1];
              const parentAmount = data.r3a_byStateGroup.filter(r => r.state === state && r.group === group).reduce((s, r) => s + r.thisFy, 0);
              const rows = data.r3a_byStateGroup.filter(r => r.state === state && r.group === group).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                parentAmount={parentAmount}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Sub-category", render: r => r.subcategory },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "3b" && (() => {
            if (drillPath.length === 0) {
              const rowsMap = new Map<string, { state: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3b_byPartyGroup) {
                const ex = rowsMap.get(r.state) ?? { state: r.state, thisFy: 0, lastFy: 0 };
                ex.thisFy += r.thisFy;
                ex.lastFy += r.lastFy;
                rowsMap.set(r.state, ex);
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r3b_byPartyGroup.some(c => c.state === r.state && c.customer) ? onDrill(r.state) : undefined}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "State", render: r => r.state },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            if (drillPath.length === 1) {
              const state = drillPath[0];
              const parentAmount = data.r3b_byPartyGroup.filter(r => r.state === state).reduce((s, r) => s + r.thisFy, 0);
              const rowsMap = new Map<string, { customer: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3b_byPartyGroup) {
                if (r.state === state) {
                  const ex = rowsMap.get(r.customer) ?? { customer: r.customer, thisFy: 0, lastFy: 0 };
                  ex.thisFy += r.thisFy;
                  ex.lastFy += r.lastFy;
                  rowsMap.set(r.customer, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r3b_byPartyGroup.some(c => c.state === state && c.customer === r.customer && c.group) ? onDrill(r.customer) : undefined}
                parentAmount={parentAmount}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Party", render: r => r.customer },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            if (drillPath.length === 2) {
              const state = drillPath[0];
              const customer = drillPath[1];
              const parentAmount = data.r3b_byPartyGroup.filter(r => r.state === state && r.customer === customer).reduce((s, r) => s + r.thisFy, 0);
              const rowsMap = new Map<string, { group: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3b_byPartyGroup) {
                if (r.state === state && r.customer === customer) {
                  const ex = rowsMap.get(r.group) ?? { group: r.group, thisFy: 0, lastFy: 0 };
                  ex.thisFy += r.thisFy;
                  ex.lastFy += r.lastFy;
                  rowsMap.set(r.group, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                parentAmount={parentAmount}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Master Group", render: r => r.group },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "4" && (() => {
            if (drillPath.length === 0) {
              const rowsMap = new Map<string, { state: string, amountThisFy: number, amountLastFy: number }>();
              for (const r of data.r4_byGroupQty) {
                const ex = rowsMap.get(r.state) ?? { state: r.state, amountThisFy: 0, amountLastFy: 0 };
                ex.amountThisFy += r.amountThisFy;
                ex.amountLastFy += r.amountLastFy;
                rowsMap.set(r.state, ex);
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.amountThisFy - a.amountThisFy);
              return (
                <div className="space-y-4">
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <strong>Rule 2 — Litre rule:</strong> quantity is shown per group only. Water tanks are in litres; everything else is in pieces.
                      Never sum quantity across groups — the total would be meaningless.
                    </span>
                  </div>
                  <DrillTable
                    rows={rows}
                    onRowClick={r => data.r4_byGroupQty.some(c => c.state === r.state && c.customer) ? onDrill(r.state) : undefined}
                    amountKey={r => r.amountThisFy}
                    columns={[
                      { header: "State", render: r => r.state },
                      { header: `Amount FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.amountThisFy) },
                      { header: `Amount FY ${priorFy}`, align: "right", render: r => fmtCr(r.amountLastFy) },
                    ]}
                  />
                </div>
              );
            }
            if (drillPath.length === 1) {
              const state = drillPath[0];
              const parentAmount = data.r4_byGroupQty.filter(r => r.state === state).reduce((s, r) => s + r.amountThisFy, 0);
              const rowsMap = new Map<string, { customer: string, amountThisFy: number, amountLastFy: number }>();
              for (const r of data.r4_byGroupQty) {
                if (r.state === state) {
                  const ex = rowsMap.get(r.customer) ?? { customer: r.customer, amountThisFy: 0, amountLastFy: 0 };
                  ex.amountThisFy += r.amountThisFy;
                  ex.amountLastFy += r.amountLastFy;
                  rowsMap.set(r.customer, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.amountThisFy - a.amountThisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r4_byGroupQty.some(c => c.state === state && c.customer === r.customer && c.group) ? onDrill(r.customer) : undefined}
                parentAmount={parentAmount}
                amountKey={r => r.amountThisFy}
                columns={[
                  { header: "Party", render: r => r.customer },
                  { header: `Amount FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.amountThisFy) },
                  { header: `Amount FY ${priorFy}`, align: "right", render: r => fmtCr(r.amountLastFy) },
                ]}
              />;
            }
            if (drillPath.length === 2) {
              const state = drillPath[0];
              const customer = drillPath[1];
              const parentAmount = data.r4_byGroupQty.filter(r => r.state === state && r.customer === customer).reduce((s, r) => s + r.amountThisFy, 0);
              const rowsMap = new Map<string, { group: string, amountThisFy: number, amountLastFy: number, qtyThisFy: number, qtyLastFy: number, unit: string }>();
              for (const r of data.r4_byGroupQty) {
                if (r.state === state && r.customer === customer) {
                  const ex = rowsMap.get(r.group) ?? { group: r.group, amountThisFy: 0, amountLastFy: 0, qtyThisFy: 0, qtyLastFy: 0, unit: r.unit };
                  ex.amountThisFy += r.amountThisFy;
                  ex.amountLastFy += r.amountLastFy;
                  ex.qtyThisFy += r.qtyThisFy;
                  ex.qtyLastFy += r.qtyLastFy;
                  if (!ex.unit) ex.unit = r.unit;
                  rowsMap.set(r.group, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.amountThisFy - a.amountThisFy);
              return <DrillTable
                rows={rows}
                onRowClick={r => data.r4_byGroupQty.some(c => c.state === state && c.customer === customer && c.group === r.group) ? onDrill(r.group) : undefined}
                parentAmount={parentAmount}
                amountKey={r => r.amountThisFy}
                columns={[
                  { header: "Group", render: r => r.group },
                  { header: `Qty FY ${fy}`, align: "right", render: r => r.qtyThisFy > 0 ? fmtQty(r.qtyThisFy, r.unit) : "—" },
                  { header: `Qty FY ${priorFy}`, align: "right", render: r => r.qtyLastFy > 0 ? fmtQty(r.qtyLastFy, r.unit) : "—" },
                  { header: `Amount FY ${fy}`, align: "right", isSumTarget: true, render: r => r.amountThisFy > 0 ? fmtCr(r.amountThisFy) : "—" },
                  { header: `Amount FY ${priorFy}`, align: "right", render: r => r.amountLastFy > 0 ? fmtCr(r.amountLastFy) : "—" },
                ]}
              />;
            }
            if (drillPath.length === 3) {
              return <R4ItemDrill fy={fy} priorFy={priorFy} state={drillPath[0]} customer={drillPath[1]} group={drillPath[2]} months={monthsParam} entityFilter={entityFilter} />;
            }
            return null;
          })()}

          {activeReport === "5" && (() => {
            if (drillPath.length === 0) {
              return (
                <div className="space-y-4">
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span><strong>Collection column:</strong> {data.r5_collectionNote}</span>
                  </div>
                  <DrillTable
                    rows={data.r5_byCustomer}
                    onRowClick={r => data.r3b_byPartyGroup.some(c => c.customer === r.customer && c.group) ? onDrill(r.customer) : undefined}
                    amountKey={r => r.thisFy}
                    columns={[
                      { header: "Customer", render: r => r.customer || "—" },
                      { header: "State", render: r => <span className="text-muted-foreground">{r.state}</span> },
                      { header: "State Head", render: r => <span className="text-muted-foreground">{r.head}</span> },
                      { header: `Sale FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                      { header: `Sale FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                      { header: "Diff", align: "right", render: r => <DiffCell value={r.diff} /> },
                      { header: "Collection", align: "right", render: r => <span className="italic text-[10px] text-muted-foreground">—</span> },
                    ]}
                  />
                </div>
              );
            }
            if (drillPath.length === 1) {
              const customer = drillPath[0];
              const parentAmount = data.r5_byCustomer.find(r => r.customer === customer)?.thisFy;
              const rowsMap = new Map<string, { group: string, thisFy: number, lastFy: number }>();
              for (const r of data.r3b_byPartyGroup) {
                if (r.customer === customer) {
                  const ex = rowsMap.get(r.group) ?? { group: r.group, thisFy: 0, lastFy: 0 };
                  ex.thisFy += r.thisFy;
                  ex.lastFy += r.lastFy;
                  rowsMap.set(r.group, ex);
                }
              }
              const rows = Array.from(rowsMap.values()).sort((a,b) => b.thisFy - a.thisFy);
              return <DrillTable
                rows={rows}
                parentAmount={parentAmount}
                amountKey={r => r.thisFy}
                columns={[
                  { header: "Group", render: r => r.group },
                  { header: `FY ${fy}`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFy) },
                  { header: `FY ${priorFy}`, align: "right", render: r => fmtCr(r.lastFy) },
                  { header: "Diff", align: "right", render: r => <DiffCell value={r.thisFy - r.lastFy} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "6" && (() => {
            if (drillPath.length === 0) {
              return <CompareTable rows={data.r6_byGroupFull.map(r => ({ label: r.group, thisFy: r.thisFyLike, lastFy: r.lastFyLike, diff: r.thisFyLike - r.lastFyLike, growthPct: r.growthLike, sharePct: 0 }))} fyLabel={`${fy} (like months)`} priorFyLabel={`${data.priorFy} (same months)`} onRowClick={(val) => data.r6_bySubcategoryFull?.some(c => c.group === val) ? onDrill(val) : undefined} />;
            }
            if (drillPath.length === 1) {
              const group = drillPath[0];
              const parentAmount = data.r6_byGroupFull.find(r => r.group === group)?.thisFyLike;
              const rows = data.r6_bySubcategoryFull?.filter(r => r.group === group) ?? [];
              return <DrillTable
                rows={rows}
                parentAmount={parentAmount}
                amountKey={r => r.thisFyLike}
                columns={[
                  { header: "Sub-category", render: r => r.subcategory },
                  { header: `${fy} (like months)`, align: "right", isSumTarget: true, render: r => fmtCr(r.thisFyLike) },
                  { header: `${data.priorFy} (same months)`, align: "right", render: r => fmtCr(r.lastFyLike) },
                  { header: `${data.priorFy} (full year)`, align: "right", render: r => <span className="text-muted-foreground">{fmtCr(r.lastFyFull)}</span> },
                  { header: "Growth", align: "right", render: r => <GrowthCell value={r.growthLike} /> },
                ]}
              />;
            }
            return null;
          })()}

          {activeReport === "7" && (() => {
            if (drillPath.length === 0) {
              const isMonthOnlyFy = fy === "2023-24";
              return (
                <div className="space-y-6">
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-muted-foreground">As-of date: <strong className="text-foreground">{data.r7_asOf.date}</strong></div>
                    <div className="text-xs text-muted-foreground">{data.r7_asOf.note}</div>
                  </div>
                  {isMonthOnlyFy && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                      FY2023-24 is month-only: the frozen source has 137,619 rows but no
                      invoice date or invoice identifier. The Invoice Count below is a
                      line-based fallback, not a distinct invoice count; daily and weekly
                      analysis is unavailable.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3">
                    {[
                      { label: "Total Sale", value: fmtCr(data.r7_asOf.total) },
                      { label: isMonthOnlyFy ? "Invoice Count*" : "Invoice Count", value: data.r7_asOf.invoiceCount.toLocaleString("en-IN") },
                      { label: "Customers", value: data.r7_asOf.customerCount.toLocaleString("en-IN") },
                    ].map((tile) => (
                      <div key={tile.label} className="flex-1 min-w-[130px] rounded-lg border border-border bg-card p-3 shadow-sm">
                        <p className="text-xs text-muted-foreground">{tile.label}</p>
                        <p className="text-xl font-semibold font-mono mt-0.5">{tile.value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">By Group</p>
                      <DrillTable
                        rows={data.r7_asOf.byGroup}
                        onRowClick={r => onDrill(`group:${r.group}`)}
                        amountKey={r => r.amount}
                        columns={[
                          { header: "Group", render: r => r.group },
                          { header: "Amount", align: "right", isSumTarget: true, render: r => fmtCr(r.amount) }
                        ]}
                      />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">By State</p>
                      <DrillTable
                        rows={data.r7_asOf.byState}
                        onRowClick={r => onDrill(`state:${r.state}`)}
                        amountKey={r => r.amount}
                        columns={[
                          { header: "State", render: r => r.state },
                          { header: "Amount", align: "right", isSumTarget: true, render: r => fmtCr(r.amount) }
                        ]}
                      />
                    </div>
                  </div>
                </div>
              );
            }
            if (drillPath.length === 1) {
              const isGroup = drillPath[0].startsWith("group:");
              const val = drillPath[0].slice(6);
              return <R7PartyDrill fy={fy} asOf={data.r7_asOf.date} type={isGroup ? "group" : "state"} value={val} entityFilter={entityFilter} months={monthsParam} />;
            }
            return null;
          })()}
        </>
      )}
    </div>
  );
}
