// Price Shrinkers — "Revenue up, volume down" flag list.
// These are the hidden shrinkers: price rises masking real demand decline.
// The single most valuable output: every entry here is a customer being
// over-reported as "growing" when they are actually shrinking in units.
import { LoadingState } from "@/components/ui/loading-state";
import { useState, useEffect } from "react";
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
import { AlertTriangle } from "lucide-react";
import { fmtQty, fmtVal, fmtPct, fmtPrice, fmtPp, pctColor } from "./formatters";

type ShrinkerRow = {
  customer: string;
  category: string | null;
  code: string | null;
  itemName: string | null;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  qtyGrowthPct: number;
  valGrowthPct: number;
  priceChangePct: number | null;
  priceEffectPp: number | null;
};

type Grain = "customer" | "category" | "product";

const GRAIN_LABELS: Record<Grain, string> = {
  customer: "By Customer",
  category: "By Category",
  product: "By Product",
};

export default function PriceShrinkers({
  fyCy,
  fyLy,
  monthsCy,
  monthsLy,
  entityType,
  filterQuery = "",
}: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType: string;
  /** Shared entity-filter query fragment ("&heads=[...]…") from CustomersPage. */
  filterQuery?: string;
}) {
  const [grain, setGrain] = useState<Grain>("customer");
  const [data, setData] = useState<ShrinkerRow[]>([]);
  const [loading, setLoading] = useState(false);

  const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

  useEffect(() => {
    if (!monthsCy.length) return;
    setLoading(true);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      grain,
      entityType,
    });
    fetch(`${BASE}/api/customers/shrinkers?${params}${filterQuery}`)
      .then((r) => r.json())
      .then((d) => setData(d.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), grain, entityType, filterQuery]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950">
        <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800 dark:text-amber-200">
          <p className="font-medium mb-0.5">Revenue up, volume down — hidden shrinkers</p>
          <p className="text-xs">
            Each entry below shows a customer (or product) where value grew but units fell.
            The apparent "growth" is entirely price — the real business with that customer
            is contracting. Realized price = Value / Qty; never from the rate list.
          </p>
          {monthsCy.length > 0 && (
            <p className="text-xs mt-1 font-medium">
              Comparing {monthsCy[0]} – {monthsCy[monthsCy.length - 1]} vs the same months in {fyLy}.
              Complete months only — partial months are excluded.
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        {(["customer", "category", "product"] as Grain[]).map((g) => (
          <Button
            key={g}
            size="sm"
            variant={grain === g ? "default" : "outline"}
            onClick={() => setGrain(g)}
          >
            {GRAIN_LABELS[g]}
          </Button>
        ))}
      </div>

      {loading ? (
        <LoadingState className="h-32" />
      ) : !data.length ? (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
          No hidden shrinkers found for this period. Good.
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {data.length} {grain}-level case{data.length !== 1 ? "s" : ""} found.
            Sorted by value gain (largest gain in value despite volume loss = most misleading).
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  {grain !== "customer" && <TableHead>Category</TableHead>}
                  {grain === "product" && <TableHead>Code</TableHead>}
                  {grain === "product" && <TableHead>Product</TableHead>}
                  {/* QTY first */}
                  <TableHead className="text-right">Qty {fyCy}</TableHead>
                  <TableHead className="text-right">Qty {fyLy}</TableHead>
                  <TableHead className="text-right">Qty %</TableHead>
                  <TableHead className="text-right">Value {fyCy}</TableHead>
                  <TableHead className="text-right">Value {fyLy}</TableHead>
                  <TableHead className="text-right">Value %</TableHead>
                  <TableHead className="text-right">Price %</TableHead>
                  <TableHead className="text-right">Price effect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row, i) => (
                  <TableRow key={i} className="bg-red-50/40 dark:bg-red-950/20">
                    <TableCell className="font-medium">{row.customer}</TableCell>
                    {grain !== "customer" && (
                      <TableCell className="text-sm text-muted-foreground">
                        {row.category ?? "—"}
                      </TableCell>
                    )}
                    {grain === "product" && (
                      <TableCell className="font-mono text-xs">{row.code ?? "—"}</TableCell>
                    )}
                    {grain === "product" && (
                      <TableCell className="text-sm">{row.itemName ?? "—"}</TableCell>
                    )}
                    <TableCell className={`text-right font-mono text-sm ${pctColor(row.qtyGrowthPct)}`}>
                      {fmtQty(row.qtyCy)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtQty(row.qtyLy)}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-sm ${pctColor(row.qtyGrowthPct)}`}>
                      {fmtPct(row.qtyGrowthPct)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-emerald-700 dark:text-emerald-400">
                      {fmtVal(row.valCy)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtVal(row.valLy)}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-sm ${pctColor(row.valGrowthPct)}`}>
                      {fmtPct(row.valGrowthPct)}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-sm ${pctColor(row.priceChangePct)}`}>
                      {fmtPct(row.priceChangePct)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-red-600 dark:text-red-400">
                      {fmtPp(row.priceEffectPp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
