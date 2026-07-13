// Company-wide primary sales Reports 1-7.
//
// All reports read from sale_line (live register chain).
// Three rules enforced everywhere:
//   RULE 1 — LIKE MONTHS: only same calendar months as current FY so far.
//   RULE 2 — LITRE RULE: Report 4 qty is per-group only, never cross-group total.
//   RULE 3 — LIVE DATA: sale_line populated from live register chain.
import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, Info, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

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
  r3_byGroup: ReportRow[];
  r3a_byStateGroup: Array<{ state: string; group: string; thisFy: number; lastFy: number }>;
  r3b_byPartyGroup: Array<{ customer: string; state: string; group: string; thisFy: number; lastFy: number }>;
  r3c_byGroupFull: GroupFullRow[];
  r4_byGroupQty: QtyRow[];
  r5_byCustomer: SaleCustomerRow[];
  r5_collectionNote: string;
  r6_byGroupFull: GroupFullRow[];
  r7_asOf: {
    date: string;
    total: number;
    byGroup: Array<{ group: string; amount: number }>;
    byState: Array<{ state: string; amount: number }>;
    invoiceCount: number;
    customerCount: number;
    note: string;
  };
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
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
}: {
  rows: ReportRow[];
  fyLabel: string;
  priorFyLabel: string;
  limit?: number;
  showGrowth?: boolean;
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
            <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
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

  // Determine predominant unit for this group
  const predominantUnit = useMemo(() => {
    const unitCounts: Record<string, number> = {};
    for (const r of groupRows) {
      if (r.unit) unitCounts[r.unit] = (unitCounts[r.unit] ?? 0) + 1;
    }
    const top = Object.entries(unitCounts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : "pcs";
  }, [groupRows]);

  const isLitreGroup =
    predominantUnit === "L" || predominantUnit.toUpperCase() === "LTR" ||
    predominantUnit.toUpperCase() === "LITRE" || predominantUnit.toUpperCase() === "LTR";

  const unitLabel = isLitreGroup ? "Litres" : predominantUnit || "Pcs";

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
            Group: <strong>{activeGroup}</strong> — unit: <strong>{unitLabel}</strong>
            {range && ` — ${range} comparison`}
          </p>
          <div className="rounded-lg border border-border overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Customer</th>
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Qty {fy} ({unitLabel})</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Qty {priorFy} ({unitLabel})</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount {fy}</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount {priorFy}</th>
                </tr>
              </thead>
              <tbody>
                {display.map((r, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="py-1.5 px-3 max-w-[160px] truncate">{r.customer || "—"}</td>
                    <td className="py-1.5 px-3 max-w-[120px] truncate text-muted-foreground">{r.state || "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{r.qtyThisFy > 0 ? r.qtyThisFy.toLocaleString("en-IN") : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{r.qtyLastFy > 0 ? r.qtyLastFy.toLocaleString("en-IN") : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{r.amountThisFy > 0 ? fmtCr(r.amountThisFy) : "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{r.amountLastFy > 0 ? fmtCr(r.amountLastFy) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 border-t border-border font-semibold">
                  <td className="py-1.5 px-3" colSpan={2}>Total amount</td>
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

// ── Report 3 (with sub-tabs 3A / 3B / 3C) ────────────────────────────────────

function Report3({
  data,
  fy,
  priorFy,
  likeMonths,
}: {
  data: Payload;
  fy: string;
  priorFy: string;
  likeMonths: string[];
}) {
  const [sub, setSub] = useState<"overall" | "3a" | "3b" | "3c">("overall");
  const [stateFilter, setStateFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");

  const SUBS = [
    { id: "overall", label: "3 — Overall" },
    { id: "3a", label: "3A — State × Group" },
    { id: "3b", label: "3B — Party × Group" },
    { id: "3c", label: "3C — Group (Full Prior Year)" },
  ] as const;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {SUBS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              sub === s.id
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sub === "overall" && (
        <CompareTable
          rows={data.r3_byGroup}
          fyLabel={`FY ${fy} (like months)`}
          priorFyLabel={`FY ${priorFy} (same months)`}
        />
      )}

      {sub === "3a" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              placeholder="Filter by state..."
              className="flex-1 text-xs rounded border border-border/50 bg-background px-2 py-1"
            />
            <input
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              placeholder="Filter by group..."
              className="flex-1 text-xs rounded border border-border/50 bg-background px-2 py-1"
            />
          </div>
          <Report3ATable
            rows={data.r3a_byStateGroup}
            fy={fy}
            priorFy={priorFy}
            stateFilter={stateFilter}
            groupFilter={groupFilter}
          />
        </div>
      )}

      {sub === "3b" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              placeholder="Filter by party..."
              className="flex-1 text-xs rounded border border-border/50 bg-background px-2 py-1"
            />
            <input
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              placeholder="Filter by group..."
              className="flex-1 text-xs rounded border border-border/50 bg-background px-2 py-1"
            />
          </div>
          <Report3BTable
            rows={data.r3b_byPartyGroup}
            fy={fy}
            priorFy={priorFy}
            partyFilter={stateFilter}
            groupFilter={groupFilter}
          />
        </div>
      )}

      {sub === "3c" && (
        <GroupFullTable rows={data.r3c_byGroupFull} fy={fy} priorFy={priorFy} />
      )}
    </div>
  );
}

function Report3ATable({
  rows,
  fy,
  priorFy,
  stateFilter,
  groupFilter,
}: {
  rows: Array<{ state: string; group: string; thisFy: number; lastFy: number }>;
  fy: string;
  priorFy: string;
  stateFilter: string;
  groupFilter: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 50;
  const filtered = rows
    .filter(
      (r) =>
        (!stateFilter || r.state.toLowerCase().includes(stateFilter.toLowerCase())) &&
        (!groupFilter || r.group.toLowerCase().includes(groupFilter.toLowerCase())),
    )
    .sort((a, b) => b.thisFy - a.thisFy);
  const display = expanded ? filtered : filtered.slice(0, LIMIT);

  return (
    <div className="rounded-lg border border-border overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Group</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">FY {fy}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">FY {priorFy}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Diff</th>
          </tr>
        </thead>
        <tbody>
          {display.map((r, i) => {
            const diff = r.thisFy - r.lastFy;
            return (
              <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                <td className="py-1.5 px-3 max-w-[140px] truncate">{r.state}</td>
                <td className="py-1.5 px-3 max-w-[120px] truncate text-muted-foreground">{r.group}</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.thisFy)}</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFy)}</td>
                <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", diff >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                  {diff >= 0 ? "+" : ""}{fmtCr(diff)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length > LIMIT && !expanded && (
        <button className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30" onClick={() => setExpanded(true)}>
          Show all {filtered.length} rows
        </button>
      )}
    </div>
  );
}

function Report3BTable({
  rows,
  fy,
  priorFy,
  partyFilter,
  groupFilter,
}: {
  rows: Array<{ customer: string; state: string; group: string; thisFy: number; lastFy: number }>;
  fy: string;
  priorFy: string;
  partyFilter: string;
  groupFilter: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 50;
  const filtered = rows
    .filter(
      (r) =>
        (!partyFilter || r.customer.toLowerCase().includes(partyFilter.toLowerCase())) &&
        (!groupFilter || r.group.toLowerCase().includes(groupFilter.toLowerCase())),
    )
    .sort((a, b) => b.thisFy - a.thisFy);
  const display = expanded ? filtered : filtered.slice(0, LIMIT);

  return (
    <div className="rounded-lg border border-border overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Party</th>
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Group</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">FY {fy}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">FY {priorFy}</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Diff</th>
          </tr>
        </thead>
        <tbody>
          {display.map((r, i) => {
            const diff = r.thisFy - r.lastFy;
            return (
              <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                <td className="py-1.5 px-3 max-w-[160px] truncate">{r.customer || "—"}</td>
                <td className="py-1.5 px-3 max-w-[100px] truncate text-muted-foreground">{r.state}</td>
                <td className="py-1.5 px-3 max-w-[100px] truncate text-muted-foreground">{r.group}</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.thisFy)}</td>
                <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFy)}</td>
                <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", diff >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                  {diff >= 0 ? "+" : ""}{fmtCr(diff)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length > LIMIT && !expanded && (
        <button className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30" onClick={() => setExpanded(true)}>
          Show all {filtered.length} rows
        </button>
      )}
    </div>
  );
}

function GroupFullTable({ rows, fy, priorFy }: { rows: GroupFullRow[]; fy: string; priorFy: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground py-4">No data.</p>;
  return (
    <div className="rounded-lg border border-border overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Group</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">{fy} (like months)</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">{priorFy} (same months)</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">{priorFy} (full year)</th>
            <th className="text-right py-2 px-3 font-medium text-muted-foreground">Growth (like months)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
              <td className="py-1.5 px-3">{r.group}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.thisFyLike)}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFyLike)}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFyFull)}</td>
              <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", growthColor(r.growthLike))}>
                {fmtPct(r.growthLike)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-muted/30 border-t border-border font-semibold">
            <td className="py-1.5 px-3">Total</td>
            <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(rows.reduce((s, r) => s + r.thisFyLike, 0))}</td>
            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(rows.reduce((s, r) => s + r.lastFyLike, 0))}</td>
            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(rows.reduce((s, r) => s + r.lastFyFull, 0))}</td>
            <td className="py-1.5 px-3" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Report 5 ──────────────────────────────────────────────────────────────────

function Report5({ rows, collectionNote, fy, priorFy }: { rows: SaleCustomerRow[]; collectionNote: string; fy: string; priorFy: string }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 50;
  const display = expanded ? rows : rows.slice(0, LIMIT);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span><strong>Collection column:</strong> {collectionNote}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/30 border-b border-border">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Customer</th>
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">State Head</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Sale FY {fy}</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Sale FY {priorFy}</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Diff</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground text-amber-600">Collection</th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => (
                <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                  <td className="py-1.5 px-3 max-w-[160px] truncate">{r.customer || "—"}</td>
                  <td className="py-1.5 px-3 max-w-[100px] truncate text-muted-foreground">{r.state}</td>
                  <td className="py-1.5 px-3 max-w-[100px] truncate text-muted-foreground">{r.head}</td>
                  <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.thisFy)}</td>
                  <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">{fmtCr(r.lastFy)}</td>
                  <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", r.diff >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                    {r.diff >= 0 ? "+" : ""}{fmtCr(r.diff)}
                  </td>
                  <td className="py-1.5 px-3 text-right text-muted-foreground italic text-[10px]">—</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > LIMIT && !expanded && (
            <button className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30" onClick={() => setExpanded(true)}>
              Show all {rows.length} customers
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Report 7 ──────────────────────────────────────────────────────────────────

function Report7({ asOf, fy }: { asOf: Payload["r7_asOf"]; fy: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="text-xs text-muted-foreground">As-of date: <strong className="text-foreground">{asOf.date}</strong></div>
        <div className="text-xs text-muted-foreground">{asOf.note}</div>
      </div>
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Total Sale", value: fmtCr(asOf.total) },
          { label: "Invoice Count", value: asOf.invoiceCount.toLocaleString("en-IN") },
          { label: "Customers", value: asOf.customerCount.toLocaleString("en-IN") },
        ].map((tile) => (
          <div key={tile.label} className="flex-1 min-w-[130px] rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className="text-xl font-semibold font-mono mt-0.5">{tile.value}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">By Group</p>
          <div className="rounded-lg border border-border overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Group</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount</th>
                </tr>
              </thead>
              <tbody>
                {asOf.byGroup.map((r, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="py-1.5 px-3">{r.group}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">By State</p>
          <div className="rounded-lg border border-border overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">State</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount</th>
                </tr>
              </thead>
              <tbody>
                {asOf.byState.map((r, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="py-1.5 px-3">{r.state}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums">{fmtCr(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab navigation ────────────────────────────────────────────────────────────

type ReportId = "1" | "2" | "3" | "4" | "5" | "6" | "7";

const TABS: { id: ReportId; label: string; description: string }[] = [
  { id: "1", label: "Report 1", description: "Sale by state — last year vs this year" },
  { id: "2", label: "Report 2", description: "Growth by state — sorted by growth %" },
  { id: "3", label: "Report 3", description: "Segment-wise (+ 3A state-wise, 3B party-wise, 3C full prior year)" },
  { id: "4", label: "Report 4", description: "Quantity by group — qty per party per state (one group at a time)" },
  { id: "5", label: "Report 5", description: "Sale and collection by customer (daily)" },
  { id: "6", label: "Report 6", description: "Total purchase by group — like months vs full prior year" },
  { id: "7", label: "Report 7", description: "As-of date snapshot" },
];

const FYS = ["2026-27", "2025-26", "2024-25"] as const;

// ── Main component ────────────────────────────────────────────────────────────

export default function CompanyReports() {
  const [fy, setFy] = useState<string>("2026-27");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<ReportId>("1");

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/company-reports?fy=${encodeURIComponent(fy)}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<Payload>;
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fy]);

  // Report 2: same data as Report 1 but sorted by growth
  const report2Rows = useMemo((): ReportRow[] => {
    if (!data) return [];
    return [...data.r1r2_byState]
      .sort((a, b) => {
        if (a.growthPct == null && b.growthPct == null) return 0;
        if (a.growthPct == null) return 1;
        if (b.growthPct == null) return -1;
        return b.growthPct - a.growthPct;
      });
  }, [data]);

  const likeMonthsLabel = useMemo(() => {
    if (!data || data.likeMonths.length === 0) return "";
    const first = data.likeMonths[0].slice(0, 3);
    const last = data.likeMonths[data.likeMonths.length - 1].slice(0, 3);
    return first === last ? first : `${first}–${last}`;
  }, [data]);

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Company Reports 1–7</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Primary sales (Prayag to Distributors) — from live invoice register.
            {data && likeMonthsLabel ? ` Comparing ${likeMonthsLabel} FY ${fy} vs FY ${data.priorFy}.` : ""}
          </p>
        </div>
        <select
          value={fy}
          onChange={(e) => setFy(e.target.value)}
          className="text-xs border border-border rounded-md px-2 py-1.5 bg-background"
        >
          {FYS.map((f) => <option key={f} value={f}>FY {f}</option>)}
        </select>
      </div>

      {/* Loading / error */}
      {loading && <div className="py-12 text-center text-sm text-muted-foreground">Loading reports...</div>}
      {error && <div className="py-6 text-center text-sm text-destructive">{error}</div>}

      {!loading && data && (
        <>
          {/* Like-months notice */}
          <LikeMonthsBadge
            months={data.likeMonths}
            priorMonths={data.likeMonthsPrior}
            fy={data.fy}
            priorFy={data.priorFy}
          />

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

          {/* Report description */}
          <p className="text-xs text-muted-foreground">
            {TABS.find((t) => t.id === activeReport)?.description}
          </p>

          {/* Report content */}
          {activeReport === "1" && (
            <CompareTable
              rows={data.r1r2_byState}
              fyLabel={`FY ${fy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`}
              priorFyLabel={`FY ${data.priorFy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`}
            />
          )}

          {activeReport === "2" && (
            <CompareTable
              rows={report2Rows}
              fyLabel={`FY ${fy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`}
              priorFyLabel={`FY ${data.priorFy}${likeMonthsLabel ? ` (${likeMonthsLabel})` : ""}`}
              showGrowth
            />
          )}

          {activeReport === "3" && (
            <Report3
              data={data}
              fy={fy}
              priorFy={data.priorFy}
              likeMonths={data.likeMonths}
            />
          )}

          {activeReport === "4" && (
            <Report4
              rows={data.r4_byGroupQty}
              fy={fy}
              priorFy={data.priorFy}
              likeMonths={data.likeMonths}
            />
          )}

          {activeReport === "5" && (
            <Report5
              rows={data.r5_byCustomer}
              collectionNote={data.r5_collectionNote}
              fy={fy}
              priorFy={data.priorFy}
            />
          )}

          {activeReport === "6" && (
            <GroupFullTable
              rows={data.r6_byGroupFull}
              fy={fy}
              priorFy={data.priorFy}
            />
          )}

          {activeReport === "7" && (
            <Report7 asOf={data.r7_asOf} fy={fy} />
          )}

          {/* Verification anchors */}
          {fy === "2026-27" && data.likeMonths.length > 0 && (
            <div className="rounded-md bg-muted/30 border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Verification anchors — FY 2026-27 like months</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>Report 1: Sunil Patel (Gujarat) = ₹79,78,394.92</span>
                <span>Report 3 PTMT like months: check per-party filter</span>
                <span>Report 4 Universal Pipe PTMT: 5,006 → 7,107 pcs (reference)</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
