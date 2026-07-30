// SKU Deep Dive — Overview section.
//
// Shows all 17 canonical segments in a sortable table.
// Clicking a row fires onDrill(segment).
//
// Columns: Segment | Net ₹Cr | Net% bar | Qty (pcs) | Codes Bought | Breadth%
// Breadth% = codesBought / codesEverSold (cross-FY denominator, always ∈ [0,100]).
import { useState } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SegmentRow = {
  segment: string;
  qty: number;
  net: number;
  netShare: number;   // 0–1
  codesBought: number;
  codesEverSold: number;
  breadthPct: number;
  codesInCatalogue: number;
};

type SortKey = "segment" | "net" | "qty" | "breadthPct" | "codesBought";

interface Props {
  rows: SegmentRow[];
  loading: boolean;
  onDrill: (segment: string) => void;
  unmapped?: { codeCount: number; value: number; valueShare: number } | null;
  summary?: { totalCodes: number; totalQty: number; totalNet: number; segmentsBought: number } | null;
}

function breadthColor(pct: number): string {
  if (pct >= 70) return "bg-emerald-500";
  if (pct >= 50) return "bg-amber-400";
  if (pct >= 30) return "bg-orange-400";
  return "bg-red-400";
}

function breadthLabel(pct: number): string {
  if (pct >= 70) return "text-emerald-700 dark:text-emerald-400";
  if (pct >= 50) return "text-amber-700 dark:text-amber-400";
  if (pct >= 30) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function fmtCr(n: number): string {
  return `₹${(n / 1e7).toFixed(2)} Cr`;
}

export default function SkuOverview({ rows, loading, onDrill, unmapped, summary }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("net");
  const [sortAsc, setSortAsc] = useState(false);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === "segment"); }
  }

  const sorted = [...rows].sort((a, b) => {
    let diff = 0;
    if (sortKey === "segment") diff = a.segment.localeCompare(b.segment);
    else if (sortKey === "net") diff = a.net - b.net;
    else if (sortKey === "qty") diff = a.qty - b.qty;
    else if (sortKey === "breadthPct") diff = a.breadthPct - b.breadthPct;
    else if (sortKey === "codesBought") diff = a.codesBought - b.codesBought;
    return sortAsc ? diff : -diff;
  });

  const maxNet = rows.length ? Math.max(...rows.map((r) => r.net)) : 1;

  function SortHead({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <TableHead
        className="cursor-pointer select-none whitespace-nowrap"
        onClick={() => toggleSort(k)}
      >
        <span className={cn("flex items-center gap-0.5", active && "text-primary font-semibold")}>
          {label}
          {active && <span className="text-[10px]">{sortAsc ? "↑" : "↓"}</span>}
        </span>
      </TableHead>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No segment data for the selected period and level.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      {summary && (
        <div className="flex flex-wrap gap-4 text-sm">
          <span>
            <span className="font-medium">{fmtCr(summary.totalNet)}</span>
            <span className="text-muted-foreground ml-1">total net</span>
          </span>
          <span>
            <span className="font-medium">{summary.totalCodes.toLocaleString()}</span>
            <span className="text-muted-foreground ml-1">codes</span>
          </span>
          <span>
            <span className="font-medium">{summary.segmentsBought}</span>
            <span className="text-muted-foreground ml-1">segments</span>
          </span>
          <span>
            <span className="font-medium">{summary.totalQty.toLocaleString()}</span>
            <span className="text-muted-foreground ml-1">pcs</span>
          </span>
          {unmapped && unmapped.codeCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {unmapped.codeCount} unmapped codes ({(unmapped.valueShare * 100).toFixed(1)}% of net)
            </span>
          )}
        </div>
      )}

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Segment" k="segment" />
              <SortHead label="Net" k="net" />
              <TableHead className="w-28 hidden sm:table-cell">Net %</TableHead>
              <SortHead label="Qty (pcs)" k="qty" />
              <SortHead label="Codes" k="codesBought" />
              <SortHead label="Breadth %" k="breadthPct" />
              <TableHead className="w-32 hidden md:table-cell">vs Catalogue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow
                key={row.segment}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onDrill(row.segment)}
              >
                {/* Segment */}
                <TableCell className="font-medium text-sm whitespace-nowrap">
                  {row.segment}
                </TableCell>

                {/* Net value */}
                <TableCell className="text-right whitespace-nowrap text-sm tabular-nums">
                  {fmtCr(row.net)}
                </TableCell>

                {/* Net % bar */}
                <TableCell className="hidden sm:table-cell w-28">
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded"
                        style={{ width: `${maxNet > 0 ? (row.net / maxNet) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
                      {(row.netShare * 100).toFixed(1)}%
                    </span>
                  </div>
                </TableCell>

                {/* Qty */}
                <TableCell className="text-right text-sm tabular-nums whitespace-nowrap">
                  {row.qty.toLocaleString()}
                </TableCell>

                {/* Codes bought */}
                <TableCell className="text-right text-sm tabular-nums">
                  {row.codesBought}
                </TableCell>

                {/* Breadth % bar */}
                <TableCell>
                  <div className="flex items-center gap-1.5 min-w-[100px]">
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                      <div
                        className={cn("h-full rounded", breadthColor(row.breadthPct))}
                        style={{ width: `${row.breadthPct}%` }}
                      />
                    </div>
                    <span className={cn("text-xs tabular-nums font-medium w-10 text-right", breadthLabel(row.breadthPct))}>
                      {row.breadthPct.toFixed(1)}%
                    </span>
                  </div>
                </TableCell>

                {/* vs Catalogue */}
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground whitespace-nowrap">
                  {row.codesInCatalogue > 0
                    ? `${row.codesBought} / ${row.codesInCatalogue} cat`
                    : <span className="italic">no catalogue</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Click a row to drill into individual codes.
        Breadth % = codes bought this period ÷ codes ever sold (all loaded FYs).
      </p>
    </div>
  );
}
