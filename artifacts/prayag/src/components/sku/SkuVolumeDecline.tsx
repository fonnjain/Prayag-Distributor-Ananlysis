// SKU Deep Dive — Volume Decline tab (K5a).
//
// Shows SKUs whose absolute piece count has fallen in the selected like-month
// period vs the prior fiscal year.  Grouped by segment, sorted worst-first.
// "Stopped" codes (zero purchases this period, non-zero last year) are included.
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Download, ChevronDown, ChevronUp } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types (mirror backend) ────────────────────────────────────────────────────

type VolumeDeclineRow = {
  code: string;
  segment: string;
  itemName: string | null;
  qtyNow: number;
  qtyPrior: number;
  qtyChange: number;
  qtyChangePct: number | null;
  netNow: number;
  netPrior: number;
  netChange: number;
  customersNow: number;
  customersPrior: number;
  stopped: boolean;
  contributionPerUnit: number | null;
};

type VolumeDeclineSegment = {
  segment: string;
  qtyDeclineTotal: number;
  netChangeTotal: number;
  rows: VolumeDeclineRow[];
};

type VolumeDeclineResult = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  floor: number;
  segments: VolumeDeclineSegment[];
  totalCodes: number;
  stoppedCodes: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n: number, dec = 0): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number | null, dec = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dec)}%`;
}

function fmtLakh(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const lakh = n / 1e5;
  if (Math.abs(lakh) >= 100) return `₹${(n / 1e7).toFixed(2)} Cr`;
  return `₹${lakh.toFixed(2)} L`;
}

function periodLabel(months: string[]): string {
  if (months.length === 0) return "—";
  return `${months[0]} – ${months[months.length - 1]}`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  fy: string;
  level: string;
  monthFrom: number;
  monthTo: number;
  scopeHead: string;
  filterQuery: string;
  periodLabel: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function SkuVolumeDecline({
  fy, level, monthFrom, monthTo, scopeHead, filterQuery, periodLabel: periodLabelProp,
}: Props) {
  const [data, setData] = useState<VolumeDeclineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedSegs, setCollapsedSegs] = useState<Set<string>>(new Set());

  // Normalize level: these tabs are territory-only
  const effectiveLevel = (level === "distributor" || level === "direct_dealer") ? level : "distributor";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const params = new URLSearchParams({
      fy,
      level: effectiveLevel,
      scope: scopeHead ? "head" : "company",
      monthFrom: String(monthFrom),
      monthTo:   String(monthTo),
    });
    if (scopeHead) params.set("scopeId", scopeHead);

    fetch(`${BASE}/api/sku/volume-decline?${params}${filterQuery}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<VolumeDeclineResult>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [fy, effectiveLevel, monthFrom, monthTo, scopeHead, filterQuery]);

  function toggleSeg(seg: string) {
    setCollapsedSegs((prev) => {
      const next = new Set(prev);
      if (next.has(seg)) next.delete(seg);
      else next.add(seg);
      return next;
    });
  }

  // Export link
  const exportParams = new URLSearchParams({
    fy,
    level: effectiveLevel,
    scope: scopeHead ? "head" : "company",
    monthFrom: String(monthFrom),
    monthTo:   String(monthTo),
  });
  if (scopeHead) exportParams.set("scopeId", scopeHead);
  const exportHref = `${BASE}/api/sku/volume-decline/export?${exportParams}${filterQuery}`;

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        Failed to load volume decline data: {error}
      </div>
    );
  }

  if (!data) return null;

  const priorPeriod = periodLabel(data.priorMonths);
  const currPeriod  = periodLabel(data.currMonths);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-sm">Volume Decline</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Comparing{" "}
            <span className="font-medium text-foreground">{currPeriod} FY {data.fy}</span>
            {" "}vs{" "}
            <span className="font-medium text-foreground">{priorPeriod} FY {data.priorFy}</span>
            {" · "}Territory channel · Materiality floor ₹{fmtNum(data.floor)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data.totalCodes > 0 && (
            <span className="text-xs text-muted-foreground">
              {data.totalCodes} codes ·{" "}
              {data.stoppedCodes > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {data.stoppedCodes} stopped
                </span>
              )}
            </span>
          )}
          <a
            href={exportHref}
            download
            className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted/40"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </a>
        </div>
      </div>

      {data.segments.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          No codes with a piece decline in the selected period.
        </div>
      ) : (
        <div className="space-y-6">
          {data.segments.map((seg) => {
            const collapsed = collapsedSegs.has(seg.segment);
            return (
              <div key={seg.segment} className="rounded-md border border-border overflow-hidden">
                {/* Segment header */}
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
                  onClick={() => toggleSeg(seg.segment)}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-sm">{seg.segment}</span>
                    <span className="text-xs text-muted-foreground">
                      {seg.rows.length} code{seg.rows.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-xs font-medium text-red-700 dark:text-red-400">
                      {fmtNum(seg.qtyDeclineTotal)} pcs
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {fmtLakh(seg.netChangeTotal)} net
                    </span>
                  </div>
                  {collapsed
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronUp   className="h-4 w-4 text-muted-foreground" />
                  }
                </button>

                {!collapsed && (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="text-[11px]">
                          <TableHead className="w-[90px]">Code</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead className="text-right">Qty now</TableHead>
                          <TableHead className="text-right">Qty prior</TableHead>
                          <TableHead className="text-right">Piece Δ</TableHead>
                          <TableHead className="text-right">% Δ</TableHead>
                          <TableHead className="text-right">Net now</TableHead>
                          <TableHead className="text-right">Net prior</TableHead>
                          <TableHead className="text-right">Net Δ</TableHead>
                          <TableHead className="text-right">Cust now</TableHead>
                          <TableHead className="text-right">Cust prior</TableHead>
                          <TableHead className="text-right">GP/pc</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {/* Segment subtotal row */}
                        <TableRow className="bg-muted/20 font-medium text-[11px]">
                          <TableCell colSpan={2} className="text-muted-foreground italic">
                            Subtotal — {seg.segment}
                          </TableCell>
                          <TableCell className="text-right">
                            {fmtNum(seg.rows.reduce((s, r) => s + r.qtyNow,   0))}
                          </TableCell>
                          <TableCell className="text-right">
                            {fmtNum(seg.rows.reduce((s, r) => s + r.qtyPrior, 0))}
                          </TableCell>
                          <TableCell className="text-right text-red-700 dark:text-red-400">
                            {fmtNum(seg.qtyDeclineTotal)}
                          </TableCell>
                          <TableCell />
                          <TableCell className="text-right">
                            {fmtLakh(seg.rows.reduce((s, r) => s + r.netNow,   0))}
                          </TableCell>
                          <TableCell className="text-right">
                            {fmtLakh(seg.rows.reduce((s, r) => s + r.netPrior, 0))}
                          </TableCell>
                          <TableCell className={cn("text-right", seg.netChangeTotal < 0 && "text-red-700 dark:text-red-400")}>
                            {fmtLakh(seg.netChangeTotal)}
                          </TableCell>
                          <TableCell colSpan={3} />
                        </TableRow>

                        {/* Code rows */}
                        {seg.rows.map((row) => (
                          <TableRow key={`${row.segment}|${row.code}`} className="text-xs">
                            <TableCell className="font-mono text-[11px]">
                              <div className="flex items-center gap-1">
                                {row.code}
                                {row.stopped && (
                                  <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                    stopped
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[180px] truncate text-muted-foreground">
                              {row.itemName ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtNum(row.qtyNow)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtNum(row.qtyPrior)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-red-700 dark:text-red-400">
                              {fmtNum(row.qtyChange)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {fmtPct(row.qtyChangePct)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtLakh(row.netNow)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtLakh(row.netPrior)}
                            </TableCell>
                            <TableCell className={cn(
                              "text-right tabular-nums",
                              row.netChange < 0 && "text-red-700 dark:text-red-400",
                            )}>
                              {fmtLakh(row.netChange)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.customersNow}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {row.customersPrior}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {row.contributionPerUnit != null
                                ? `₹${row.contributionPerUnit.toFixed(2)}`
                                : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Territory channel only — project, govt, and export excluded.
        Materiality floor: prior-period net ≥ ₹{fmtNum(data.floor)}.
        GP/pc = gross contribution per unit (factory cost only) from trailing 12-month cost data; — = no data.
      </p>
    </div>
  );
}
