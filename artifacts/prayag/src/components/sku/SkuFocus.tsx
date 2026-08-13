import { trunc2 } from "@/lib/trunc";
// SKU Deep Dive — Review section (K3 company-wide gap review).
//
// Company-wide review list: for each segment, the codes that NO distributor
// in the territory ordered this period, ranked by their historical net in
// the same fiscal months.  This answers "what has the whole territory
// stopped buying?" — not what one specific distributor should push.
//
// For per-distributor peer-cohort recommendations, see the Push tab.
//
// Rule-based — no AI, no forecast. Priority = gapNet descending.
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// ── Types (mirror backend SkuRecommendationsResult) ───────────────────────────

export type GapCode = {
  code: string;
  itemName: string | null;
  priorNet: number;
  lastFy: string;
  /**
   * GROSS CONTRIBUTION — factory cost only. Not profit.
   * null = no cost data; code sorts last.
   */
  contributionPerUnit: number | null;
  contributionPct: number | null;
};

export type SegmentRecommendation = {
  rank: number;
  segment: string;
  gapNet: number;
  gapCodeCount: number;
  codesBought: number;
  codesEverSold: number;
  breadthPct: number;
  topGapCodes: GapCode[];
};

export type FocusData = {
  recommendations: SegmentRecommendation[];
  fiscalMonths: string[];
  totalGapNet: number;
  totalGapContribution?: number | null;
  noCostData?: { codeCount: number; sharePct: number };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${trunc2(cr)} Cr`;
  return `₹${trunc2((n / 1e5))} L`;
}

function fmtNet(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${trunc2(cr)} Cr`;
  const l = n / 1e5;
  if (l >= 1) return `₹${trunc2(l)} L`;
  return `₹${Math.round(n / 1000)}k`;
}

function breadthColour(pct: number): string {
  if (pct >= 70) return "text-emerald-700 dark:text-emerald-400";
  if (pct >= 50) return "text-amber-700 dark:text-amber-400";
  if (pct >= 30) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  data: FocusData | null;
  loading: boolean;
  error: string | null;
  onDrill: (segment: string) => void;
  periodLabel: string;
}

export default function SkuFocus({ data, loading, error, onDrill, periodLabel }: Props) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-36 rounded-lg border bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        Failed to load recommendations: {error}
      </div>
    );
  }

  if (!data || data.recommendations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No gap recommendations for the selected period and level.
      </p>
    );
  }

  const { recommendations, fiscalMonths, totalGapNet } = data;
  const monthRange = fiscalMonths.length > 0
    ? `${fiscalMonths[0]}–${fiscalMonths[fiscalMonths.length - 1]}`
    : "same fiscal months";

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-4 text-sm">
        <span>
          <span className="font-medium">{recommendations.length}</span>
          <span className="text-muted-foreground ml-1">segments with gaps</span>
        </span>
        <span>
          <span className="font-medium">{fmtCr(totalGapNet)}</span>
          <span className="text-muted-foreground ml-1">total gap codes' net</span>
        </span>
        <span className="text-muted-foreground hidden sm:inline">
          Comparison: {monthRange} across all loaded FYs · {periodLabel}
        </span>
      </div>

      {/* Segment cards */}
      {recommendations.map((rec) => (
        <RecommendationCard
          key={rec.segment}
          rec={rec}
          monthRange={monthRange}
          onDrill={onDrill}
        />
      ))}

      <p className="text-xs text-muted-foreground pt-1">
        <span className="font-medium">Prior net</span> = realised net in {monthRange} across all loaded FYs.
        Gap codes are codes not ordered this period. No forecast or extrapolation.
      </p>
    </div>
  );
}

// ── Recommendation Card ───────────────────────────────────────────────────────

function RecommendationCard({
  rec,
  monthRange,
  onDrill,
}: {
  rec: SegmentRecommendation;
  monthRange: string;
  onDrill: (segment: string) => void;
}) {
  const gapCr = rec.gapNet / 1e7;
  const gapLabel = gapCr >= 1
    ? `₹${trunc2(gapCr)} Cr gap`
    : `₹${trunc2((rec.gapNet / 1e5))} L gap`;

  return (
    <div className="rounded-lg border bg-card">
      {/* Card header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Rank badge */}
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary
                           text-xs font-semibold flex items-center justify-center tabular-nums">
            {rec.rank}
          </span>

          {/* Segment + summary */}
          <div className="min-w-0">
            <span className="font-semibold text-sm">{rec.segment}</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{gapLabel}</span>
              <span>{rec.gapCodeCount.toLocaleString()} gap codes</span>
              <span className={cn("font-medium", breadthColour(rec.breadthPct))}>
                {trunc2(rec.breadthPct)}% breadth
              </span>
              <span>({rec.codesBought} bought · {rec.codesEverSold} ever sold)</span>
            </div>
          </div>
        </div>

        {/* Drill button */}
        <button
          type="button"
          onClick={() => onDrill(rec.segment)}
          className="flex-shrink-0 flex items-center gap-1 text-xs text-primary
                     hover:underline whitespace-nowrap mt-0.5"
        >
          Full drill
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {/* Top gap codes table */}
      <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium px-1 py-1 bg-amber-50/60 dark:bg-amber-900/10 rounded mb-1">
        Contribution figures are being recalculated — do not use for prioritisation.
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead className="py-1.5 pl-4 w-8">#</TableHead>
              <TableHead className="py-1.5">Code</TableHead>
              <TableHead className="py-1.5 hidden sm:table-cell">Item Name</TableHead>
              <TableHead className="py-1.5 text-right">Prior net ({monthRange})</TableHead>
              <TableHead
                className="py-1.5 text-right hidden lg:table-cell"
                title="GROSS CONTRIBUTION — factory cost only. Not profit."
              >
                Gross contrib
              </TableHead>
              <TableHead className="py-1.5 text-right hidden md:table-cell">Last FY</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rec.topGapCodes.map((code, idx) => (
              <TableRow key={code.code} className={cn(idx === 0 && "font-medium")}>
                <TableCell className="py-1.5 pl-4 text-xs text-muted-foreground tabular-nums w-8">
                  {idx + 1}
                </TableCell>
                <TableCell className="py-1.5 font-mono text-xs whitespace-nowrap">
                  {code.code}
                </TableCell>
                <TableCell className="py-1.5 text-xs hidden sm:table-cell max-w-[220px] truncate">
                  {code.itemName ?? (
                    <span className="text-muted-foreground italic">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-right tabular-nums text-xs whitespace-nowrap">
                  {fmtNet(code.priorNet)}
                </TableCell>
                <TableCell className="py-1.5 text-right tabular-nums text-xs whitespace-nowrap hidden lg:table-cell">
                  <span className="text-muted-foreground italic text-[10px]">under review</span>
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs text-muted-foreground
                                     hidden md:table-cell whitespace-nowrap">
                  {code.lastFy}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Footer: how many more codes */}
      {rec.gapCodeCount > rec.topGapCodes.length && (
        <div className="px-4 py-1.5 border-t">
          <button
            type="button"
            onClick={() => onDrill(rec.segment)}
            className="text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            + {(rec.gapCodeCount - rec.topGapCodes.length).toLocaleString()} more gap codes — drill in to see all
          </button>
        </div>
      )}
    </div>
  );
}
