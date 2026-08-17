// SKU Deep Dive — Price Shrinkers tab (K5b).
//
// SKUs where pieces grew but real value fell because the MRP rise outpaced value
// growth.  Uses the Laspeyres MRP index (matching Red Alert B1).
//
// realGrowth% = valueGrowth% − mrpIncrease%
// Qualifying: qtyGrowth% > 0  AND  realGrowth% < 0
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Download, ChevronDown, ChevronRight } from "lucide-react";
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

type PriceShrinkersRow = {
  code: string;
  segment: string;
  itemName: string | null;
  qtyNow: number;
  qtyPrior: number;
  qtyGrowthPct: number;
  netNow: number;
  netPrior: number;
  valueGrowthPct: number;
  mrpThen: number;
  mrpNow: number;
  mrpIncreasePct: number;
  realGrowthPct: number;
  realisedPriceNow: number;
  realisedPricePrior: number;
  realisedPriceChangePct: number;
};

type PriceShrinkersResult = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  floor: number;
  rows: PriceShrinkersRow[];
  excludedNoMrp: {
    count: number;
    topByNet: Array<{ code: string; segment: string; itemName: string | null; netPrior: number }>;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number, dec = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dec)}%`;
}

function fmtLakh(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtRs(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function periodStr(months: string[]): string {
  if (!months.length) return "—";
  return `${months[0]} – ${months[months.length - 1]}`;
}

// Classify the cause of real decline for a row
function declineCause(row: PriceShrinkersRow): string {
  const mrpBasis      = row.realGrowthPct < 0;
  const realisedBasis = row.realisedPriceChangePct < row.mrpIncreasePct - 0.1;
  if (mrpBasis && realisedBasis) return "Genuine — value lost on both bases";
  if (mrpBasis && !realisedBasis) return "Discount leakage — realised price held, MRP gave way";
  return "—";
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

export default function SkuPriceShrinkers({
  fy, level, monthFrom, monthTo, scopeHead, filterQuery,
}: Props) {
  const [data, setData] = useState<PriceShrinkersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

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

    fetch(`${BASE}/api/sku/price-shrinkers?${params}${filterQuery}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PriceShrinkersResult>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [fy, effectiveLevel, monthFrom, monthTo, scopeHead, filterQuery]);

  const exportParams = new URLSearchParams({
    fy,
    level: effectiveLevel,
    scope: scopeHead ? "head" : "company",
    monthFrom: String(monthFrom),
    monthTo:   String(monthTo),
  });
  if (scopeHead) exportParams.set("scopeId", scopeHead);
  const exportHref = `${BASE}/api/sku/price-shrinkers/export?${exportParams}${filterQuery}`;

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
        Failed to load price shrinkers: {error}
      </div>
    );
  }

  if (!data) return null;

  const currPeriod  = periodStr(data.currMonths);
  const priorPeriod = periodStr(data.priorMonths);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-sm">Price Shrinkers</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Volume up, real value down ·{" "}
            <span className="font-medium text-foreground">{currPeriod} FY {data.fy}</span>
            {" "}vs{" "}
            <span className="font-medium text-foreground">{priorPeriod} FY {data.priorFy}</span>
            {" · "}Territory channel
          </p>
        </div>
        <a
          href={exportHref}
          download
          className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted/40"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </a>
      </div>

      {/* Excluded codes banner */}
      {data.excludedNoMrp.count > 0 && (
        <div className="rounded-md border border-amber-300/50 bg-amber-500/5 px-3 py-2 text-xs">
          <button
            type="button"
            className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300 w-full text-left"
            onClick={() => setShowExcluded((v) => !v)}
          >
            {showExcluded
              ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
              : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
            }
            <span>
              <span className="font-medium">{data.excludedNoMrp.count} code{data.excludedNoMrp.count !== 1 ? "s" : ""} excluded</span>
              {" — "}no MRP on record. These codes cannot be analysed for price shrinker status.
            </span>
          </button>

          {showExcluded && data.excludedNoMrp.topByNet.length > 0 && (
            <div className="mt-2 ml-5 space-y-0.5">
              <div className="text-[10px] text-muted-foreground mb-1">Top excluded codes by prior-period net:</div>
              {data.excludedNoMrp.topByNet.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono w-[80px] flex-shrink-0">{e.code}</span>
                  <span className="text-muted-foreground w-[50px] flex-shrink-0">{e.segment}</span>
                  <span className="text-muted-foreground flex-1 truncate">{e.itemName ?? "—"}</span>
                  <span className="tabular-nums flex-shrink-0">{fmtLakh(e.netPrior)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          No codes qualify — no SKU with volume growth had negative real value growth in this period.
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px]">
                  <TableHead className="w-[60px]">Seg</TableHead>
                  <TableHead className="w-[80px]">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Qty now</TableHead>
                  <TableHead className="text-right">Qty prior</TableHead>
                  <TableHead className="text-right">Qty +%</TableHead>
                  <TableHead className="text-right">Net now</TableHead>
                  <TableHead className="text-right">Net prior</TableHead>
                  <TableHead className="text-right">Value +%</TableHead>
                  <TableHead className="text-right">MRP prior</TableHead>
                  <TableHead className="text-right">MRP now</TableHead>
                  <TableHead className="text-right">MRP +%</TableHead>
                  <TableHead className="text-right font-semibold text-red-700 dark:text-red-400">
                    Real %
                  </TableHead>
                  <TableHead className="text-right">Realised prior</TableHead>
                  <TableHead className="text-right">Realised now</TableHead>
                  <TableHead className="text-right">Realised +%</TableHead>
                  <TableHead>Cause</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row, idx) => (
                  <TableRow key={`${row.segment}|${row.code}`} className={cn(
                    "text-xs",
                    idx % 2 === 0 ? "" : "bg-muted/10",
                  )}>
                    <TableCell className="text-muted-foreground text-[10px]">
                      {row.segment}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{row.code}</TableCell>
                    <TableCell className="max-w-[160px] truncate text-muted-foreground">
                      {row.itemName ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.qtyNow)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtNum(row.qtyPrior)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                      {pct(row.qtyGrowthPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtLakh(row.netNow)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtLakh(row.netPrior)}
                    </TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      row.valueGrowthPct < 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
                    )}>
                      {pct(row.valueGrowthPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtRs(row.mrpThen)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRs(row.mrpNow)}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      row.mrpIncreasePct > 0 ? "text-amber-700 dark:text-amber-400" : "",
                    )}>
                      {pct(row.mrpIncreasePct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-red-700 dark:text-red-400">
                      {pct(row.realGrowthPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtRs(row.realisedPricePrior)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRs(row.realisedPriceNow)}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      row.realisedPriceChangePct < 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
                    )}>
                      {pct(row.realisedPriceChangePct)}
                    </TableCell>
                    <TableCell className="text-[10px] text-muted-foreground max-w-[160px]">
                      {declineCause(row)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <p>
          Real % = value growth % − MRP increase % (Laspeyres basket, prior-period quantities).
          Qualifying condition: volume up AND real growth negative.
          Sorted worst-first (most negative Real %).
        </p>
        <p>
          MRP then = effective price at end of prior period from mrp_history.
          Ambiguous codes resolved on (code, segment) — different prices in different segments.
          Codes with no MRP record are excluded and counted above.
        </p>
        <p>
          Realised price = net / qty per period.
          Genuine decline: real negative on both MRP and realised basis.
          Discount leakage: realised price held but MRP rose faster than value.
        </p>
      </div>
    </div>
  );
}
