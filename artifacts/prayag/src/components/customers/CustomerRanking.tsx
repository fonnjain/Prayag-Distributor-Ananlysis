// Customer Ranking — units-first leaderboard.
//
// RULE ZERO: Leads with QUANTITY. Value shown alongside, never instead.
// Price effect = value growth % − qty growth %, shows how much "growth" was
// just price, not volume.
// "Revenue up, volume down" rows are the hidden shrinkers — flagged in red.
import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowUp, ArrowDown, ArrowUpDown, AlertTriangle } from "lucide-react";
import { fmtQty, fmtVal, fmtPct, fmtPrice, fmtPp, pctColor } from "./formatters";

export type CustomerRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  state: string | null;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  priceCy: number | null;
  priceLy: number | null;
  qtyGrowthPct: number | null;
  valGrowthPct: number | null;
  priceChangePct: number | null;
  priceEffectPp: number | null;
  revenueUpVolumeDown: boolean;
};

type SortKey = keyof CustomerRow;
type SortDir = "asc" | "desc";

const ENTITY_LABELS: Record<string, string> = {
  distributor: "Distributor",
  direct_dealer: "Dealer",
  retailer: "Retailer",
  unknown: "—",
};

function SortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
}) {
  if (col !== sortKey) return <ArrowUpDown className="inline ml-1 h-3 w-3 opacity-40" />;
  return sortDir === "asc" ? (
    <ArrowUp className="inline ml-1 h-3 w-3" />
  ) : (
    <ArrowDown className="inline ml-1 h-3 w-3" />
  );
}

function SortTh({
  col,
  label,
  sortKey,
  sortDir,
  onSort,
  align = "right",
}: {
  col: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  return (
    <TableHead
      className={`cursor-pointer select-none whitespace-nowrap ${align === "right" ? "text-right" : ""}`}
      onClick={() => onSort(col)}
    >
      {label}
      <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
    </TableHead>
  );
}

export default function CustomerRanking({
  data,
  loading,
  onSelectCustomer,
  selectedCustomer,
  fyCy,
  fyLy,
  headYoySplit,
}: {
  data: CustomerRow[];
  loading: boolean;
  onSelectCustomer: (c: string) => void;
  selectedCustomer: string | null;
  fyCy: string;
  fyLy: string;
  /** When set, the active head filter has a cross-FY key split — LY columns are suppressed. */
  headYoySplit?: { priorCanon: string; splitFromFy: string } | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("qtyCy");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [data, sortKey, sortDir]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No data for this period.
      </div>
    );
  }

  const shrinkerCount = data.filter((r) => r.revenueUpVolumeDown).length;
  // When a cross-FY key split is active, prior-year LY columns are meaningless
  // (they would show zero because the old head_canon is different).  Suppress
  // them entirely rather than mislead with a false 100%-loss signal.
  const showLy = !headYoySplit;

  return (
    <div>
      {headYoySplit && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>
            Prior-year comparison suppressed.{" "}
            This head was recorded as <strong>{headYoySplit.priorCanon}</strong> in {fyLy} — a different{" "}
            <code className="font-mono text-xs">head_canon</code> key. LY columns are hidden until the alias is confirmed
            and applied.
          </span>
        </div>
      )}
      {shrinkerCount > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>
            {shrinkerCount} customer{shrinkerCount > 1 ? "s" : ""} show revenue
            up but volume down — price is masking real decline.
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortTh col="customer" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="left" />
              <TableHead>Type</TableHead>
              <SortTh col="state" label="State" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="left" />
              {/* UNITS FIRST */}
              <SortTh col="qtyCy" label={`Qty ${fyCy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              {showLy && <SortTh col="qtyLy" label={`Qty ${fyLy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {showLy && <SortTh col="qtyGrowthPct" label="Qty %" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {/* VALUE */}
              <SortTh col="valCy" label={`Value ${fyCy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              {showLy && <SortTh col="valLy" label={`Value ${fyLy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {showLy && <SortTh col="valGrowthPct" label="Value %" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {/* PRICE */}
              <SortTh col="priceCy" label={`Price ${fyCy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              {showLy && <SortTh col="priceLy" label={`Price ${fyLy}`} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {showLy && <SortTh col="priceChangePct" label="Price %" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              {showLy && <SortTh col="priceEffectPp" label="Price effect" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow
                key={row.customer}
                className={[
                  "cursor-pointer",
                  row.revenueUpVolumeDown
                    ? "bg-red-50/60 dark:bg-red-950/20"
                    : "",
                  selectedCustomer === row.customer
                    ? "bg-blue-50 dark:bg-blue-950/30"
                    : "hover:bg-muted/50",
                ].join(" ")}
                onClick={() => onSelectCustomer(row.customer)}
              >
                <TableCell className="font-medium max-w-[200px] truncate">
                  {row.customer}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs font-normal">
                    {ENTITY_LABELS[row.entityType] ?? row.entityType}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
                  {row.state ?? "—"}
                </TableCell>
                {/* QTY — primary signal */}
                <TableCell className="text-right font-mono">
                  {fmtQty(row.qtyCy)}
                </TableCell>
                {showLy && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmtQty(row.qtyLy)}
                  </TableCell>
                )}
                {showLy && (
                  <TableCell className={`text-right font-mono ${pctColor(row.qtyGrowthPct)}`}>
                    {fmtPct(row.qtyGrowthPct)}
                  </TableCell>
                )}
                {/* VALUE */}
                <TableCell className="text-right font-mono">
                  {fmtVal(row.valCy)}
                </TableCell>
                {showLy && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmtVal(row.valLy)}
                  </TableCell>
                )}
                {showLy && (
                  <TableCell className={`text-right font-mono ${pctColor(row.valGrowthPct)}`}>
                    {fmtPct(row.valGrowthPct)}
                  </TableCell>
                )}
                {/* PRICE */}
                <TableCell className="text-right font-mono">
                  {fmtPrice(row.priceCy)}
                </TableCell>
                {showLy && (
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmtPrice(row.priceLy)}
                  </TableCell>
                )}
                {showLy && (
                  <TableCell className={`text-right font-mono ${pctColor(row.priceChangePct)}`}>
                    {fmtPct(row.priceChangePct)}
                  </TableCell>
                )}
                {/* PRICE EFFECT — how much of value growth was price, not volume */}
                {showLy && (
                  <TableCell className={`text-right font-mono ${pctColor(row.priceEffectPp, true)}`}>
                    {fmtPp(row.priceEffectPp)}
                  </TableCell>
                )}
                <TableCell>
                  {row.revenueUpVolumeDown && (
                    <Badge className="text-xs bg-red-100 text-red-700 border border-red-300 dark:bg-red-950 dark:text-red-300">
                      Shrinking
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {sorted.length} customers. Click a row to drill into categories and products.
        Realized price = Value / Qty (never MRP). Price effect = value growth% minus qty growth%.
      </p>
    </div>
  );
}
