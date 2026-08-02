// SKU Deep Dive — Timing / Seasonality section (K4).
//
// GET /api/sku/seasonality  (FY-independent — spans all loaded FYs)
//
// One card per segment: 12-bar month sparkline (Apr..Mar), peak-quarter badge,
// peak month and 3-year consistency.  Sorted by totalNet desc (already sorted
// by the API).
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types (mirror backend skuSeasonality.ts) ───────────────────────────────────

export type SeasonalitySegment = {
  segment: string;
  totalNet: number;
  monthShare: number[];   // length 12, Apr..Mar, 0-1
  quarterShare: number[]; // [q1,q2,q3,q4], 0-1
  peakQuarter: 1 | 2 | 3 | 4;
  peakQuarterLabel: string;
  peakMonth: string;
  yearsConsistent: number; // 0-3
};

export type SeasonalityResult = {
  basis: string;
  fys: string[];
  segments: SeasonalitySegment[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

// Quarter each month index (0-11) belongs to — for tinting the sparkline.
const MONTH_QUARTER = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];

const QUARTER_STYLES: Record<number, string> = {
  1: "bg-blue-500/70",
  2: "bg-emerald-500/70",
  3: "bg-amber-500/70",
  4: "bg-violet-500/70",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(2)} Cr`;
  return `₹${(n / 1e5).toFixed(1)} L`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function consistencyColour(n: number): string {
  if (n >= 3) return "text-emerald-700 dark:text-emerald-400";
  if (n === 2) return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SkuSeasonality({ head = null }: { head?: string | null }) {
  const [data, setData] = useState<SeasonalityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // Head scope always bands on territory-only curves (the all-channel view
    // once put HDPE top of a push list on a 100%-project Q1 peak).
    const params = new URLSearchParams();
    if (head) {
      params.set("channel", "territory");
      params.set("head", head);
    }
    const qs = params.toString();
    fetch(`${BASE}/api/sku/seasonality${qs ? `?${qs}` : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SeasonalityResult>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [head]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg border bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        Failed to load seasonality: {error}
      </div>
    );
  }

  if (!data || data.segments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No seasonality data available.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 text-sm">
        <span>
          <span className="font-medium">{data.segments.length}</span>
          <span className="text-muted-foreground ml-1">segments</span>
        </span>
        <span className="text-muted-foreground">
          Across FY {data.fys.join(", ")}
        </span>
        {head && (
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {head} · territory-only curves
          </span>
        )}
      </div>

      {head && (
        <p className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Head-scoped curves use only the closed years where sale_line carries head
          attribution (FY2023-24) — single-year evidence, weaker than the pooled
          company-wide pattern. Compare each segment&apos;s peak against the
          company-wide view before acting on a divergence.
        </p>
      )}

      {data.segments.map((seg) => (
        <SeasonalityCard key={seg.segment} seg={seg} />
      ))}

      <p className="text-xs text-muted-foreground pt-1">{data.basis}</p>
    </div>
  );
}

// ── Segment card ───────────────────────────────────────────────────────────────

function SeasonalityCard({ seg }: { seg: SeasonalitySegment }) {
  const maxShare = Math.max(...seg.monthShare, 0.0001);
  const peakShare = seg.quarterShare[seg.peakQuarter - 1] ?? 0;

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        {/* Left: identity + badges */}
        <div className="min-w-0 sm:w-64 flex-shrink-0">
          <div className="font-semibold text-sm truncate">{seg.segment}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
            <span
              className="inline-flex items-center px-1.5 py-0 rounded border text-[10px] font-medium leading-4 select-none
                         bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20"
              title={`share of annual revenue in peak quarter: ${pct(peakShare)}`}
            >
              Peak {seg.peakQuarterLabel} · {pct(peakShare)}
            </span>
            <span>
              Peak month <span className="font-medium text-foreground">{seg.peakMonth}</span>
            </span>
            <span className={cn("font-medium", consistencyColour(seg.yearsConsistent))}>
              {seg.yearsConsistent}/3 yrs
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            {fmtCr(seg.totalNet)} total net
          </div>
        </div>

        {/* Right: 12-bar month sparkline */}
        <div className="flex-1 min-w-0">
          <div className="flex items-end gap-[3px] h-12">
            {seg.monthShare.map((share, i) => {
              const isPeakQ = MONTH_QUARTER[i] === seg.peakQuarter;
              const h = Math.max(2, Math.round((share / maxShare) * 100));
              return (
                <div
                  key={i}
                  className="flex-1 flex flex-col justify-end"
                  title={`${MONTH_LABELS[i]}: ${pct(share)}`}
                >
                  <div
                    className={cn(
                      "w-full rounded-sm transition-all",
                      QUARTER_STYLES[MONTH_QUARTER[i]],
                      !isPeakQ && "opacity-45",
                    )}
                    style={{ height: `${h}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex gap-[3px] mt-1">
            {MONTH_LABELS.map((m, i) => (
              <div
                key={i}
                className="flex-1 text-center text-[9px] text-muted-foreground/70 leading-tight"
              >
                {m[0]}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
