// SKU Deep Dive — Overview section.
//
// Shows all 17 canonical segments in a sortable table.
// Clicking a row fires onDrill(segment).
//
// Columns:
//   Segment | Net ₹Cr | Net% bar | Qty (pcs) | Codes Bought | Unbought | Gap codes' net | Breadth%
//
// "Gap codes' net" = unboughtValue from the API:
//   SUM(sale_line.amount) for codes NOT bought in the query period,
//   applying the same level/scope filters, across all loaded fiscal years.
//   This is a factual bottom-up sum — no extrapolation or mean assumption.
//   Assumption labelled on column: "historical net of gap codes, all loaded FYs".
//
// Breadth% bar is shown without colour — the percentage is structural
// (small segments hit 100% trivially) so colouring it is misleading.
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
  /** Bottom-up historical net of codes not bought this period (all loaded FYs). */
  unboughtValue: number;
};

type SortKey = "segment" | "net" | "qty" | "breadthPct" | "codesBought" | "unbought" | "gapNet";

interface Props {
  rows: SegmentRow[];
  loading: boolean;
  onDrill: (segment: string) => void;
  unmapped?: { codeCount: number; value: number; valueShare: number } | null;
  summary?: { totalCodes: number; totalQty: number; totalNet: number; segmentsBought: number } | null;
}

function fmtCr(n: number): string {
  return `₹${(n / 1e7).toFixed(2)} Cr`;
}

function fmtGapNet(n: number): string {
  if (n === 0) return "—";
  const cr = n / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(1)} Cr`;
  return `₹${(n / 1e5).toFixed(1)} L`;
}

export default function SkuOverview({ rows, loading, onDrill, unmapped, summary }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("gapNet");
  const [sortAsc, setSortAsc] = useState(false);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === "segment"); }
  }

  const enriched = rows.map((r) => ({
    ...r,
    unbought: r.codesEverSold - r.codesBought,
  }));

  const sorted = [...enriched].sort((a, b) => {
    let diff = 0;
    if (sortKey === "segment")     diff = a.segment.localeCompare(b.segment);
    else if (sortKey === "net")        diff = a.net - b.net;
    else if (sortKey === "qty")        diff = a.qty - b.qty;
    else if (sortKey === "breadthPct") diff = a.breadthPct - b.breadthPct;
    else if (sortKey === "codesBought")diff = a.codesBought - b.codesBought;
    else if (sortKey === "unbought")   diff = a.unbought - b.unbought;
    else if (sortKey === "gapNet")     diff = a.unboughtValue - b.unboughtValue;
    return sortAsc ? diff : -diff;
  });

  const maxNet = rows.length ? Math.max(...rows.map((r) => r.net)) : 1;
  const maxGapNet = enriched.length ? Math.max(...enriched.map((r) => r.unboughtValue)) : 1;

  function SortHead({
    label,
    k,
    align = "left",
    className,
  }: {
    label: string;
    k: SortKey;
    align?: "left" | "right";
    className?: string;
  }) {
    const active = sortKey === k;
    return (
      <TableHead
        className={cn("cursor-pointer select-none whitespace-nowrap", align === "right" && "text-right", className)}
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
            <span className="text-muted-foreground ml-1">codes bought</span>
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
              <SortHead label="Net" k="net" align="right" />
              <TableHead className="w-28 hidden sm:table-cell">Net %</TableHead>
              <SortHead label="Qty (pcs)" k="qty" align="right" className="hidden md:table-cell" />
              <SortHead label="Bought" k="codesBought" align="right" />
              <SortHead label="Unbought" k="unbought" align="right" />
              <SortHead label="Gap codes' net" k="gapNet" align="right" />
              <SortHead label="Breadth %" k="breadthPct" align="right" className="hidden lg:table-cell" />
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
                        className="h-full bg-primary/50 rounded"
                        style={{ width: `${maxNet > 0 ? (row.net / maxNet) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
                      {(row.netShare * 100).toFixed(1)}%
                    </span>
                  </div>
                </TableCell>

                {/* Qty */}
                <TableCell className="text-right text-sm tabular-nums whitespace-nowrap hidden md:table-cell">
                  {row.qty.toLocaleString()}
                </TableCell>

                {/* Codes bought */}
                <TableCell className="text-right text-sm tabular-nums">
                  {row.codesBought}
                </TableCell>

                {/* Unbought codes */}
                <TableCell className="text-right text-sm tabular-nums font-medium">
                  {row.unbought > 0
                    ? <span className="text-foreground">{row.unbought}</span>
                    : <span className="text-muted-foreground">0</span>}
                </TableCell>

                {/* Gap codes' net — bottom-up historical sum, no extrapolation */}
                <TableCell className="text-right text-sm tabular-nums whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 rounded bg-muted overflow-hidden hidden sm:block">
                      <div
                        className="h-full bg-primary rounded"
                        style={{ width: `${maxGapNet > 0 ? (row.unboughtValue / maxGapNet) * 100 : 0}%` }}
                      />
                    </div>
                    <span className={cn("font-medium", row.unboughtValue > 0 ? "text-foreground" : "text-muted-foreground")}>
                      {fmtGapNet(row.unboughtValue)}
                    </span>
                  </div>
                </TableCell>

                {/* Breadth % — neutral bar, no health colouring */}
                <TableCell className="hidden lg:table-cell">
                  <div className="flex items-center gap-1.5 min-w-[100px]">
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-muted-foreground/40 rounded"
                        style={{ width: `${row.breadthPct}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">
                      {row.breadthPct.toFixed(1)}%
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Gap codes' net</span> = historical sales of codes not ordered this period, across all loaded fiscal years (same level — no forecast, no extrapolation).
        Click a row to drill into individual codes.
      </p>
    </div>
  );
}
