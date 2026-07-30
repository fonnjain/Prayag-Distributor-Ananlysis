// SKU Deep Dive — Push section (K3b peer-cohort recommendations).
//
// Per-distributor push list.  The user selects one distributor; we find their
// peer cohort (same state, FY2025-26 quintile ±1) and surface gap codes that
// ≥ 3 peers are buying right now that the target is not.
//
// Every card carries the exact cohort sentence:
//   "X of Y peers in [state] buy this code and you do not."
//
// Cohort basis ("state" or "national") is shown when the state is too small.
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ArrowRight, Users, AlertTriangle } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// ── Types (mirror skuPushList.ts) ──────────────────────────────────────────────

export type DistributorListItem = {
  customer: string;
  headCanon: string | null;
  cohortFyNet: number;
  quintile: number | null;
  cohortBasis: "state" | "national" | null;
};

export type PushCode = {
  code: string;
  itemName: string | null;
  peerCount: number;
  peerNet: number;
  lastFy: string;
};

export type SegmentPushCard = {
  rank: number;
  segment: string;
  totalGapCodes: number;
  segmentPeerCount: number;
  cohortBasis: "state" | "national";
  topCodes: PushCode[];
};

export type PushListResult = {
  distributorKey: string;
  stateName: string | null;
  quintile: number | null;
  cohortSize: number;
  cohortBasis: "state" | "national";
  suppressed: boolean;
  suppressReason?: string;
  /** True when no FY2025-26 cohort data: recommendations use the tiered state-typical pool. */
  isFallback: boolean;
  /** Which tier resolved the pool when isFallback=true. */
  fallbackTier?: "state" | "territory" | "national";
  /** Human-readable pool scope for display when isFallback=true. */
  fallbackScopeName?: string;
  segments: SegmentPushCard[];
  fiscalMonths: string[];
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtNet(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(2)} Cr`;
  const l = n / 1e5;
  if (l >= 1) return `₹${l.toFixed(1)} L`;
  return `₹${Math.round(n / 1000)}k`;
}

function fmtCohortFyNet(n: number): string {
  const cr = n / 1e7;
  if (cr >= 0.1) return `₹${cr.toFixed(1)} Cr`;
  const l = n / 1e5;
  if (l >= 1) return `₹${l.toFixed(0)} L`;
  return "< ₹1 L";
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  distributorList: DistributorListItem[];
  distributorListLoading: boolean;
  selectedDistributor: string | null;
  onSelect: (customer: string | null) => void;
  pushData: PushListResult | null;
  pushLoading: boolean;
  pushError: string | null;
  periodLabel: string;
  onDrill: (segment: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SkuPushList({
  distributorList,
  distributorListLoading,
  selectedDistributor,
  onSelect,
  pushData,
  pushLoading,
  pushError,
  periodLabel,
  onDrill,
}: Props) {
  const [search, setSearch] = useState("");

  // Group by state for <optgroup>
  const byState = useMemo(() => {
    const map = new Map<string, DistributorListItem[]>();
    for (const d of distributorList) {
      const key = d.headCanon ?? "Unknown State";
      const arr = map.get(key) ?? [];
      arr.push(d);
      map.set(key, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [distributorList]);

  // Filtered list for search
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return byState;
    return byState
      .map(([state, dists]) => [
        state,
        dists.filter(
          (d) =>
            d.customer.toLowerCase().includes(q) ||
            (d.headCanon ?? "").toLowerCase().includes(q),
        ),
      ] as [string, DistributorListItem[]])
      .filter(([, dists]) => dists.length > 0);
  }, [byState, search]);

  // Selected distributor info (for the header strip)
  const selectedInfo = selectedDistributor
    ? distributorList.find((d) => d.customer === selectedDistributor) ?? null
    : null;

  return (
    <div className="space-y-4">
      {/* ── Distributor selector ─────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Select distributor
            </label>
            {/* Search input */}
            <input
              type="text"
              placeholder="Type to filter…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground sr-only">
              Pick
            </label>
            <select
              value={selectedDistributor ?? ""}
              onChange={(e) => {
                onSelect(e.target.value || null);
                setSearch("");
              }}
              className="w-full rounded border bg-background px-2 py-1 text-xs"
              disabled={distributorListLoading}
              size={1}
            >
              <option value="">
                {distributorListLoading ? "Loading…" : "— select a distributor —"}
              </option>
              {filtered.map(([state, dists]) => (
                <optgroup key={state} label={state}>
                  {dists.map((d) => (
                    <option key={d.customer} value={d.customer}>
                      {d.customer}
                      {d.quintile != null
                        ? ` · Q${d.quintile}/5 · ${fmtCohortFyNet(d.cohortFyNet)} FY25-26`
                        : " · new distributor"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        {/* Selected distributor strip */}
        {selectedInfo && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs pt-1 border-t">
            <span className="font-medium">{selectedInfo.customer}</span>
            <span className="text-muted-foreground">
              {selectedInfo.headCanon ?? "Unknown state"}
            </span>
            {selectedInfo.quintile != null ? (
              <>
                <span className="text-muted-foreground">
                  Quintile <span className="font-medium text-foreground">{selectedInfo.quintile}</span> of 5
                  {selectedInfo.cohortBasis === "national" ? " (national)" : " (state)"}
                </span>
                <span className="text-muted-foreground">
                  FY25-26 net {fmtCohortFyNet(selectedInfo.cohortFyNet)}
                </span>
              </>
            ) : (
              <span className="text-amber-700 dark:text-amber-400 font-medium">
                New distributor — no cohort FY data
              </span>
            )}
            <span className="text-muted-foreground hidden lg:inline">{periodLabel}</span>
          </div>
        )}
      </div>

      {/* ── No distributor selected ─────────────────────────────────────── */}
      {!selectedDistributor && !pushLoading && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Select a distributor above to see their personalised push list.
        </p>
      )}

      {/* ── Loading ─────────────────────────────────────────────────────── */}
      {pushLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-40 rounded-lg border bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {pushError && !pushLoading && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          Failed to load push list: {pushError}
        </div>
      )}

      {/* ── Cohort metadata + suppression ───────────────────────────────── */}
      {pushData && !pushLoading && (
        <>
          <CohortBanner data={pushData} />

          {/* Weak-evidence callout for state-typical fallback */}
          {!pushData.suppressed && pushData.isFallback && (
            <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-4 py-3 flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  {pushData.fallbackTier === "state" && "Geographic-state pool · weaker evidence than peer cohort"}
                  {pushData.fallbackTier === "territory" && "Territory pool · state too small, widened to territory"}
                  {pushData.fallbackTier === "national" && "National size-band pool · territory too small, widened nationally"}
                  {!pushData.fallbackTier && "State-typical recommendation · weaker evidence"}
                </p>
                <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                  {pushData.fallbackTier === "state" && (
                    <>No FY2025-26 history for size-matched peer selection. Codes shown are stocked
                    by ≥ 3 distributors in <strong>{pushData.fallbackScopeName}</strong> that this
                    distributor has not ordered. Useful signal, but not a like-for-like size comparison.</>
                  )}
                  {pushData.fallbackTier === "territory" && (
                    <>The geographic state had too few active distributors for a state-level pool,
                    so the reference was widened to the full{" "}
                    <strong>{pushData.fallbackScopeName}</strong> ({pushData.cohortSize} distributors).
                    Codes shown are stocked by ≥ 3 in that territory.</>
                  )}
                  {pushData.fallbackTier === "national" && (
                    <>Neither state nor territory had enough distributors, so the pool was widened to
                    national distributors in the same YTD size band (<strong>{pushData.fallbackScopeName}</strong>,{" "}
                    {pushData.cohortSize} distributors). Evidence is thinner — treat as a broad catalogue prompt.</>
                  )}
                  {!pushData.fallbackTier && (
                    <>No FY2025-26 history found. Codes are stocked by ≥ 3 nearby distributors
                    that this distributor has not ordered — a useful starting point but not a
                    like-for-like comparison.</>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Suppressed */}
          {pushData.suppressed ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-4 py-3 flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  Recommendations suppressed
                </p>
                <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                  {pushData.suppressReason}
                </p>
              </div>
            </div>
          ) : pushData.segments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No gap codes meet the minimum threshold for this distributor and period.
            </p>
          ) : (
            <>
              {pushData.segments.map((seg) => (
                <PushSegmentCard
                  key={seg.segment}
                  seg={seg}
                  stateName={pushData.stateName}
                  cohortSize={pushData.cohortSize}
                  isFallback={pushData.isFallback}
                  fallbackTier={pushData.fallbackTier}
                  fallbackScopeName={pushData.fallbackScopeName}
                  onDrill={onDrill}
                />
              ))}
              <p className="text-xs text-muted-foreground pt-1">
                {pushData.isFallback ? (
                  <>
                    Showing codes stocked by ≥ 3 distributors in the same{" "}
                    {pushData.cohortBasis === "national" ? "national pool" : "state"} in this
                    period that this distributor did not order.{" "}
                    <span className="font-medium">Pool net</span> = sum of those distributors'
                    net for this code in the period. Based on state-typical stocking patterns,
                    not a size-matched peer cohort.
                  </>
                ) : (
                  <>
                    Showing codes bought by ≥ 3 segment-active peers in the same period that
                    this distributor did not order.{" "}
                    <span className="font-medium">Peer net</span> = sum of those peers' net for
                    this code in the period. Cohort basis: FY2025-26.
                  </>
                )}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Cohort banner ──────────────────────────────────────────────────────────────

function CohortBanner({ data }: { data: PushListResult }) {
  if (data.suppressed) return null;

  if (data.isFallback) {
    const tierLabel = {
      state:     "geographic state",
      territory: "territory",
      national:  "national · size band",
    }[data.fallbackTier ?? "state"] ?? "state-typical";

    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
        <Users className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span>
          <span className="font-medium">{data.cohortSize}</span> distributors ·{" "}
          {tierLabel} · <span className="font-medium">{data.fallbackScopeName}</span>
          {" "}· no FY25-26 cohort
        </span>
        {data.segments.length > 0 && (
          <span className="text-muted-foreground">
            {data.segments.reduce((s, seg) => s + seg.totalGapCodes, 0)} gap codes
            across {data.segments.length} segment{data.segments.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
    );
  }

  const basis =
    data.cohortBasis === "national"
      ? `national cohort — state has too few distributors`
      : `${data.stateName ?? "state"} cohort`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
      <Users className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
      <span>
        <span className="font-medium">{data.cohortSize}</span> peers in quintile{" "}
        {data.quintile !== null ? `${data.quintile}±1` : "?"} of 5 · {basis}
      </span>
      {data.segments.length > 0 && (
        <span className="text-muted-foreground">
          {data.segments.reduce((s, seg) => s + seg.totalGapCodes, 0)} qualifying gap codes
          across {data.segments.length} segment{data.segments.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

// ── Segment card ───────────────────────────────────────────────────────────────

function PushSegmentCard({
  seg,
  stateName,
  cohortSize,
  isFallback,
  fallbackTier,
  fallbackScopeName,
  onDrill,
}: {
  seg: SegmentPushCard;
  stateName: string | null;
  cohortSize: number;
  isFallback: boolean;
  fallbackTier?: "state" | "territory" | "national";
  fallbackScopeName?: string;
  onDrill: (segment: string) => void;
}) {
  // Row annotation: "X of Y [label]"
  //   Peer-cohort  → "in [state]" or "nationally"
  //   Fallback T1  → "in [WEST BENGAL]"
  //   Fallback T2  → "in [Head]'s territory"
  //   Fallback T3  → "nationally (size band Qn)"
  const stateLabel = isFallback
    ? (fallbackTier === "national"
        ? (fallbackScopeName ?? "nationally")
        : `in ${fallbackScopeName ?? "this area"}`)
    : (seg.cohortBasis === "national" ? "nationally" : `in ${stateName ?? "this state"}`);

  // Label differs: peer-cohort uses "peers", state-typical uses "distributors"
  const countLabel = isFallback ? "distributors" : "peers";
  const netLabel = isFallback ? "Pool net" : "Peer net";

  return (
    <div className="rounded-lg border bg-card">
      {/* Card header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Rank badge */}
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary
                           text-xs font-semibold flex items-center justify-center tabular-nums">
            {seg.rank}
          </span>
          <div className="min-w-0">
            <span className="font-semibold text-sm">{seg.segment}</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {seg.totalGapCodes} gap code{seg.totalGapCodes === 1 ? "" : "s"}
              </span>
              <span>
                {seg.segmentPeerCount} of {cohortSize} {countLabel} active in this segment
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDrill(seg.segment)}
          className="flex-shrink-0 flex items-center gap-1 text-xs text-primary
                     hover:underline whitespace-nowrap mt-0.5"
        >
          Full drill
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {/* Gap codes table */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead className="py-1.5 pl-4 w-8">#</TableHead>
              <TableHead className="py-1.5">Code</TableHead>
              <TableHead className="py-1.5 hidden sm:table-cell">Item Name</TableHead>
              <TableHead className="py-1.5 text-right">
                {isFallback ? "Stocking" : "Peers buying"}
              </TableHead>
              <TableHead className="py-1.5 text-right">{netLabel}</TableHead>
              <TableHead className="py-1.5 text-right hidden md:table-cell">Last FY</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {seg.topCodes.map((code, idx) => (
              <TableRow key={code.code} className={cn(idx === 0 && "font-medium")}>
                <TableCell className="py-1.5 pl-4 text-xs text-muted-foreground tabular-nums w-8">
                  {idx + 1}
                </TableCell>
                <TableCell className="py-1.5 font-mono text-xs whitespace-nowrap">
                  {code.code}
                </TableCell>
                <TableCell className="py-1.5 text-xs hidden sm:table-cell max-w-[200px] truncate">
                  {code.itemName ?? (
                    <span className="text-muted-foreground italic">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs whitespace-nowrap">
                  <span className="font-medium text-primary tabular-nums">
                    {code.peerCount}
                  </span>
                  <span className="text-muted-foreground ml-1">
                    of {seg.segmentPeerCount} {stateLabel}
                  </span>
                </TableCell>
                <TableCell className="py-1.5 text-right tabular-nums text-xs whitespace-nowrap">
                  {fmtNet(code.peerNet)}
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

      {/* Footer */}
      {seg.totalGapCodes > seg.topCodes.length && (
        <div className="px-4 py-1.5 border-t">
          <button
            type="button"
            onClick={() => onDrill(seg.segment)}
            className="text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            + {(seg.totalGapCodes - seg.topCodes.length).toLocaleString()} more gap codes — drill
            in to see all
          </button>
        </div>
      )}
    </div>
  );
}
