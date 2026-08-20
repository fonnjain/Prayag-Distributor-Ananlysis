import { trunc2 } from "@/lib/trunc";
// SKU Deep Dive — Segment drill-down section.
//
// Shows code-level breakdown for a single canonical segment.
// Columns: Rank | Code | Item Name | Net ₹ | Net% | Qty (pcs) | Months Active
//
// monthDistribution is a Record<month_label, net>; monthsActive = Object.keys().length.
import { useState } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type CodeRow = {
  code: string;
  segment: string;
  itemName: string | null;
  qty: number;
  net: number;
  netShare: number;   // 0–1
  monthDistribution: Record<string, number>;
};

type SortKey = "rank" | "net" | "qty" | "months";

interface Props {
  segment: string;
  rows: CodeRow[];
  loading: boolean;
  truncated: boolean;
  onBack: () => void;
  /** SkuSegmentFact summary for this segment */
  segmentFact?: {
    net: number;
    qty: number;
    codesBought: number;
    codesEverSold: number;
    breadthPct: number;
    codesInCatalogue: number;
  } | null;
}

function fmtCr(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${trunc2(cr)} Cr`;
  return `₹${trunc2((n / 1e5))} L`;
}

function breadthLabel(pct: number): string {
  if (pct >= 70) return "text-emerald-700 dark:text-emerald-400";
  if (pct >= 50) return "text-amber-700 dark:text-amber-400";
  if (pct >= 30) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

export default function SkuDrill({ segment, rows, loading, truncated, onBack, segmentFact }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortAsc, setSortAsc] = useState(true);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === "rank"); }
  }

  const sorted = [...rows].sort((a, b) => {
    const aMonths = Object.keys(a.monthDistribution).length;
    const bMonths = Object.keys(b.monthDistribution).length;
    let diff = 0;
    if (sortKey === "rank" || sortKey === "net") diff = a.net - b.net;
    else if (sortKey === "qty") diff = a.qty - b.qty;
    else if (sortKey === "months") diff = aMonths - bMonths;
    // rank is always desc by net; others respect sortAsc
    return (sortKey === "rank" ? !sortAsc : sortAsc) ? diff : -diff;
  });

  // Actually for "rank" default is highest net first, so flip:
  if (sortKey === "rank") sorted.reverse();

  function SortHead({ label, k, align = "left" }: { label: string; k: SortKey; align?: "left" | "right" }) {
    const active = sortKey === k;
    return (
      <TableHead
        className={cn("cursor-pointer select-none whitespace-nowrap", align === "right" && "text-right")}
        onClick={() => toggleSort(k)}
      >
        <span className={cn("inline-flex items-center gap-0.5", active && "text-primary font-semibold")}>
          {label}
          {active && <span className="text-[10px]">{sortAsc ? "↑" : "↓"}</span>}
        </span>
      </TableHead>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-7 rounded bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Segment summary strip */}
      {segmentFact && (
        <div className="flex flex-wrap gap-4 text-sm">
          <span>
            <span className="font-medium">{fmtCr(segmentFact.net)}</span>
            <span className="text-muted-foreground ml-1">net</span>
          </span>
          <span>
            <span className="font-medium">{segmentFact.qty.toLocaleString()}</span>
            <span className="text-muted-foreground ml-1">pcs</span>
          </span>
          <span>
            <span className={cn("font-medium", breadthLabel(segmentFact.breadthPct))}>
              {trunc2(segmentFact.breadthPct)}% breadth
            </span>
            <span className="text-muted-foreground ml-1">
              ({segmentFact.codesBought} of {segmentFact.codesEverSold} ever-sold codes)
            </span>
          </span>
          {segmentFact.codesInCatalogue > 0 && (
            <span className="text-muted-foreground">
              {segmentFact.codesInCatalogue} in current catalogue
            </span>
          )}
        </div>
      )}

      {/* Truncation notice */}
      {truncated && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Showing top 500 codes by net. Some lower-volume codes are omitted.
        </div>
      )}

      {!rows.length && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No code data found for {segment} in the selected period.
        </p>
      )}

      {rows.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead label="#" k="rank" />
                <TableHead>Code</TableHead>
                <TableHead className="hidden sm:table-cell">Item Name</TableHead>
                <SortHead label="Net" k="net" align="right" />
                <TableHead className="text-right hidden sm:table-cell">Net %</TableHead>
                <SortHead label="Qty (pcs)" k="qty" align="right" />
                <SortHead label="Months" k="months" align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row, idx) => {
                const monthsActive = Object.keys(row.monthDistribution).length;
                const netPct = trunc2((row.netShare * 100));
                return (
                  <TableRow key={row.code}>
                    <TableCell className="text-muted-foreground text-xs tabular-nums w-8">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-medium whitespace-nowrap">
                      {row.code}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-sm max-w-[240px] truncate">
                      {row.itemName ?? (
                        <span className="text-muted-foreground italic text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                      {fmtCr(row.net)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground hidden sm:table-cell">
                      {netPct}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                      {row.qty.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      <Badge variant={monthsActive >= 4 ? "default" : monthsActive >= 2 ? "secondary" : "outline"}
                        className="text-xs px-1.5 py-0">
                        {monthsActive}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Months = number of distinct months with sales. Sorted by net (highest first) by default.
      </p>
    </div>
  );
}
