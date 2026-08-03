import { trunc2 } from "@/lib/trunc";
import { useState, useEffect, useCallback, useRef } from "react";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";
import { SnapshotBanner, useSnapshotRefresh } from "./snapshotRefresh";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  TrendingUp,
  Minus,
  Users,
  Store,
  ShieldAlert,
  Info,
  Loader2,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirror backend WarningsResponse) ───────────────────────────────────

type WarningSeverity = "RED" | "ORANGE" | "YELLOW" | "NOT_AVAILABLE";
type WarningTrend = "IMPROVING" | "WORSENING" | "STABLE";

interface WarningCard {
  code: string;
  family: string;
  title: string;
  severity: WarningSeverity;
  baseSeverity: WarningSeverity;
  trend: WarningTrend | null;
  metric: { value: number | null; label: string; formatted: string };
  threshold: { red?: number; orange?: number; yellow?: number; direction: "above" | "below" };
  source: string;
  suggestedAction: string;
  notAvailableReason?: string;
  suppressedBy?: string;
  suppresses: string[];
}

interface MemberWarnings {
  memberKey: string;
  name: string;
  stateHead: string;
  hasMappedSheet: boolean;
  isPartialTenure: boolean;
  workingDaysActual: number | null;
  retailersTotal: number | null;
  unassignedCount: number | null;
  visitsToUnassigned: number | null;
  rootWarnings: WarningCard[];
  suppressedWarnings: WarningCard[];
  jFlags: WarningCard[];
  suppressedCount: number;
}

interface WarningsResponse {
  fy: string;
  stateHead: string;
  availableStateHeads: string[];
  elapsedFraction: number;
  members: MemberWarnings[];
  teamSummary: {
    totalRetailers: number;
    unassignedRetailers: number;
    visitsToUnassigned: number;
    membersWithSheet: number;
    membersWithoutSheet: number;
    activeRetailers: number;
    /** Partial-tenure norm actually applied (working days). */
    normWorkingDays?: number;
    /** "team-median" for teams of 5+, else "company-fallback". */
    normBasis?: "team-median" | "company-fallback";
    partialTenureCutoffDays?: number;
  };
  /** Cold-start snapshot freshness — see snapshotRefresh.tsx. */
  meta?: { snapshotSavedAt?: number; refreshing?: boolean };
}

// ── W2: distributor warnings types (mirror backend DistributorWarningsResponse) ──

interface DistributorWarnings {
  normKey: string;
  name: string;
  retailerCount: number;
  activeCount: number;
  orderBooking: number;
  obSharePct: number | null;
  hasFlows: boolean;
  insufficientHistory: boolean;
  daysSinceLastOrder: number | null;
  rootWarnings: WarningCard[];
  suppressedWarnings: WarningCard[];
  suppressedCount: number;
}

interface DistributorWarningsResponse {
  fy: string;
  stateHead: string;
  availableStateHeads: string[];
  period: string;
  channelNote: string;
  distributors: DistributorWarnings[];
  directDealer: { retailerCount: number; dashboardOb: number | null } | null;
  summary: {
    distributorCount: number;
    withWarnings: number;
    largestShare: { name: string; sharePct: number } | null;
    totalRetailers: number;
    assignmentGapRetailers: number;
    indexBasis: string;
  };
  membersFailed: number;
  stale?: boolean;
  meta?: { snapshotSavedAt?: number; refreshing?: boolean };
}

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_CONFIG: Record<
  WarningSeverity,
  { label: string; badge: string; card: string; dot: string }
> = {
  RED: {
    label: "RED",
    badge: "bg-red-100 text-red-800 border-red-200",
    card: "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-800",
    dot: "bg-red-500",
  },
  ORANGE: {
    label: "ORANGE",
    badge: "bg-orange-100 text-orange-800 border-orange-200",
    card: "border-orange-200 bg-orange-50/50 dark:bg-orange-950/20 dark:border-orange-800",
    dot: "bg-orange-500",
  },
  YELLOW: {
    label: "YELLOW",
    badge: "bg-yellow-100 text-yellow-800 border-yellow-200",
    card: "border-yellow-200 bg-yellow-50/50 dark:bg-yellow-950/20 dark:border-yellow-800",
    dot: "bg-yellow-500",
  },
  NOT_AVAILABLE: {
    label: "N/A",
    badge: "bg-muted text-muted-foreground border-border",
    card: "border-border bg-muted/30",
    dot: "bg-muted-foreground",
  },
};

function SevBadge({ severity, code }: { severity: WarningSeverity; code: string }) {
  const cfg = SEV_CONFIG[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border",
        cfg.badge,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full inline-block", cfg.dot)} />
      {code}
    </span>
  );
}

function TrendIcon({ trend }: { trend: WarningTrend | null }) {
  if (trend === "WORSENING")
    return <TrendingDown className="w-3 h-3 text-red-500 inline" aria-label="Worsening" />;
  if (trend === "IMPROVING")
    return <TrendingUp className="w-3 h-3 text-green-500 inline" aria-label="Improving" />;
  if (trend === "STABLE") return <Minus className="w-3 h-3 text-muted-foreground inline" />;
  return null;
}

// ── Single warning card ───────────────────────────────────────────────────────

function WarningCardRow({
  w,
  dimmed = false,
}: {
  w: WarningCard;
  dimmed?: boolean;
}) {
  const cfg = SEV_CONFIG[w.severity];
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm",
        cfg.card,
        dimmed && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <SevBadge severity={w.severity} code={w.code} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-foreground">{w.title}</span>
            <TrendIcon trend={w.trend} />
            {w.suppressedBy && (
              <span className="text-[10px] text-muted-foreground italic">
                (suppressed by {w.suppressedBy})
              </span>
            )}
          </div>
          <p className="text-xs text-foreground/80 mt-0.5 font-mono">{w.metric.formatted}</p>
          {w.notAvailableReason ? (
            <p className="text-xs text-muted-foreground mt-0.5 italic">{w.notAvailableReason}</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">{w.suggestedAction}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Member warning panel ──────────────────────────────────────────────────────

function MemberPanel({ member }: { member: MemberWarnings }) {
  const [showSuppressed, setShowSuppressed] = useState(false);

  const reds = member.rootWarnings.filter((w) => w.severity === "RED").length;
  const oranges = member.rootWarnings.filter((w) => w.severity === "ORANGE").length;
  const yellows = member.rootWarnings.filter((w) => w.severity === "YELLOW").length;
  const hasWarnings = member.rootWarnings.length > 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="px-4 py-3 bg-muted/20 border-b">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Users className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{member.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {member.retailersTotal != null ? `${member.retailersTotal} retailers` : "No sheet"}
                {member.unassignedCount != null && member.unassignedCount > 0
                  ? ` · ${member.unassignedCount} unassigned`
                  : ""}
                {member.isPartialTenure
                  ? ` · ${member.workingDaysActual ?? "?"} working days`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {reds > 0 && (
              <span className="text-[11px] font-bold text-red-600 bg-red-100 rounded px-1.5 py-0.5">
                {reds} RED
              </span>
            )}
            {oranges > 0 && (
              <span className="text-[11px] font-bold text-orange-600 bg-orange-100 rounded px-1.5 py-0.5">
                {oranges} ORG
              </span>
            )}
            {yellows > 0 && (
              <span className="text-[11px] font-bold text-yellow-700 bg-yellow-100 rounded px-1.5 py-0.5">
                {yellows} YLW
              </span>
            )}
            {!hasWarnings && member.jFlags.length === 0 && member.hasMappedSheet && (
              <span className="text-[11px] font-medium text-green-600 bg-green-100 rounded px-1.5 py-0.5">
                All clear
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 space-y-2">
        {/* Root warnings */}
        {member.rootWarnings.length > 0 && (
          <div className="space-y-1.5">
            {member.rootWarnings.map((w) => (
              <WarningCardRow key={w.code} w={w} />
            ))}
          </div>
        )}

        {/* J-flags — always visible, styled as muted info */}
        {member.jFlags.length > 0 && (
          <div className="space-y-1">
            {member.jFlags.map((w) => (
              <div
                key={w.code}
                className="flex items-start gap-2 px-3 py-2 rounded-lg border border-border bg-muted/30 text-xs"
              >
                <Info className="w-3.5 h-3.5 shrink-0 text-muted-foreground mt-0.5" />
                <div>
                  <span className="font-semibold text-foreground/70 mr-1">{w.code}</span>
                  <span className="text-muted-foreground">{w.title}</span>
                  {w.notAvailableReason && (
                    <p className="text-muted-foreground/80 italic mt-0.5">{w.notAvailableReason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Suppressed warnings — collapsed by default */}
        {member.suppressedCount > 0 && (
          <div>
            <button
              onClick={() => setShowSuppressed((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
            >
              {showSuppressed ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {member.suppressedCount} downstream warning
              {member.suppressedCount !== 1 ? "s" : ""} suppressed by root cause
              {showSuppressed ? " (hide)" : " (show)"}
            </button>
            {showSuppressed && (
              <div className="mt-1.5 space-y-1.5 pl-4 border-l-2 border-muted">
                {member.suppressedWarnings.map((w) => (
                  <WarningCardRow key={w.code} w={w} dimmed />
                ))}
              </div>
            )}
          </div>
        )}

        {/* No warnings and has a mapped sheet — brief note */}
        {!hasWarnings && member.jFlags.length === 0 && member.hasMappedSheet && (
          <p className="text-xs text-muted-foreground text-center py-2">
            No warnings above threshold for this member.
          </p>
        )}

        {/* No sheet — only show J1 (already in jFlags) */}
        {!member.hasMappedSheet && member.jFlags.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">
            No working sheet mapped — detail is absent, not zero.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Team summary bar ──────────────────────────────────────────────────────────

function TeamSummary({
  summary,
  stateHead,
  elapsedFraction,
}: {
  summary: WarningsResponse["teamSummary"];
  stateHead: string;
  elapsedFraction: number;
}) {
  return (
    <Card className="mb-4">
      <CardHeader className="px-4 py-3 border-b">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-muted-foreground" />
          {stateHead} — Team Overview
          <span className="text-xs font-normal text-muted-foreground ml-1">
            YTD {trunc2((elapsedFraction * 100))}% elapsed
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <Stat label="Total retailers" value={summary.totalRetailers.toLocaleString()} />
          <Stat
            label="Unassigned retailers"
            value={summary.unassignedRetailers.toLocaleString()}
            highlight={summary.unassignedRetailers > 200}
            note={
              summary.totalRetailers > 0
                ? `${trunc2(((summary.unassignedRetailers / summary.totalRetailers) * 100))}% of total`
                : undefined
            }
          />
          <Stat
            label="Visits to unassigned"
            value={summary.visitsToUnassigned.toLocaleString()}
            note="visits that cannot convert"
          />
          <Stat label="Members with sheet" value={String(summary.membersWithSheet)} />
          <Stat
            label="Members no sheet"
            value={String(summary.membersWithoutSheet)}
            highlight={summary.membersWithoutSheet > 0}
          />
        </div>
        {summary.unassignedRetailers > 0 && (
          <p className="text-[11px] text-muted-foreground mt-3 border-t pt-2">
            <strong>Supply-route note:</strong> Retailers WITH an assigned distributor are ~19× more likely to
            be active. The {summary.unassignedRetailers.toLocaleString()} unassigned retailers absorbed{" "}
            {summary.visitsToUnassigned.toLocaleString()} visits. Causation note: '{"{--}"}' may be
            written when a retailer goes dormant, which would reverse the direction — the two are
            indistinguishable in this data.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className={cn("text-lg font-bold", highlight ? "text-orange-600" : "text-foreground")}>
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {note && <p className="text-[10px] text-muted-foreground/70">{note}</p>}
    </div>
  );
}

// ── W2: Distributor panel ─────────────────────────────────────────────────────

function DistributorPanel({ dist }: { dist: DistributorWarnings }) {
  const [showSuppressed, setShowSuppressed] = useState(false);
  const reds = dist.rootWarnings.filter((w) => w.severity === "RED").length;
  const oranges = dist.rootWarnings.filter((w) => w.severity === "ORANGE").length;
  const yellows = dist.rootWarnings.filter((w) => w.severity === "YELLOW").length;
  const realWarnings = dist.rootWarnings.filter((w) => w.severity !== "NOT_AVAILABLE");

  return (
    <Card className="overflow-hidden" data-testid={`card-distributor-${dist.normKey}`}>
      <CardHeader className="px-4 py-3 bg-muted/20 border-b">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Store className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{dist.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {dist.retailerCount} retailers · {dist.activeCount} active
                {dist.obSharePct != null ? ` · ${trunc2(dist.obSharePct)}% of party OB` : ""}
                {dist.daysSinceLastOrder != null
                  ? ` · last order ${dist.daysSinceLastOrder}d ago`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {reds > 0 && (
              <span className="text-[11px] font-bold text-red-600 bg-red-100 rounded px-1.5 py-0.5">
                {reds} RED
              </span>
            )}
            {oranges > 0 && (
              <span className="text-[11px] font-bold text-orange-600 bg-orange-100 rounded px-1.5 py-0.5">
                {oranges} ORG
              </span>
            )}
            {yellows > 0 && (
              <span className="text-[11px] font-bold text-yellow-700 bg-yellow-100 rounded px-1.5 py-0.5">
                {yellows} YLW
              </span>
            )}
            {realWarnings.length === 0 && !dist.insufficientHistory && (
              <span className="text-[11px] font-medium text-green-600 bg-green-100 rounded px-1.5 py-0.5">
                All clear
              </span>
            )}
            {dist.insufficientHistory && (
              <span className="text-[11px] font-medium text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                Insufficient history
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      {(dist.rootWarnings.length > 0 || dist.suppressedWarnings.length > 0) && (
        <CardContent className="px-4 py-3 space-y-2">
          {dist.rootWarnings.map((w) => (
            <WarningCardRow key={w.code} w={w} />
          ))}
          {dist.suppressedWarnings.length > 0 && (
            <>
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowSuppressed((s) => !s)}
                data-testid={`button-suppressed-${dist.normKey}`}
              >
                {showSuppressed ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
                {dist.suppressedCount} suppressed — a root cause hides its symptoms
              </button>
              {showSuppressed &&
                dist.suppressedWarnings.map((w) => <WarningCardRow key={w.code} w={w} dimmed />)}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
const DEFAULT_FY = "2026-27";
const DEFAULT_HEAD = "Anant Singh";

export default function WarningSystem() {
  const fy = DEFAULT_FY; // Warnings are always for the current FY only
  const [stateHead, setStateHead] = useState(DEFAULT_HEAD);
  const [data, setData] = useState<WarningsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while Google Sheets is briefly rate-limiting reads (503 quota);
  // a retry is scheduled automatically after the server's retryAfter hint.
  const [quotaWait, setQuotaWait] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Request generation counter: each user-initiated load bumps it, so a stale
  // quota retry (or late response) from an earlier selection never commits.
  const reqSeq = useRef(0);

  // Cold-start snapshot: while meta.refreshing is true the server is rebuilding
  // in the background — poll silently and swap the fresh figures in.
  const dataUrl = data
    ? `${API}/warnings?fy=${encodeURIComponent(fy)}&stateHead=${encodeURIComponent(data.stateHead)}`
    : null;
  useSnapshotRefresh(data?.meta, dataUrl, (fresh) =>
    setData(fresh as WarningsResponse),
  );

  const load = useCallback(
    async (sh: string) => {
      const seq = ++reqSeq.current;
      // A new load supersedes any pending quota retry.
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
      setQuotaWait(false);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${API}/warnings?fy=${encodeURIComponent(fy)}&stateHead=${encodeURIComponent(sh)}`,
        );
        if (seq !== reqSeq.current) return; // superseded by a newer load
        const q = await quotaOrThrow(res);
        if (q) {
          setQuotaWait(true);
          retryTimer.current = setTimeout(() => load(sh), quotaDelayMs(q.retryAfter));
          return;
        }
        const json = (await res.json()) as WarningsResponse;
        if (seq !== reqSeq.current) return;
        setData(json);
        setStateHead(json.stateHead);
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError((e as Error).message);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [fy],
  );

  useEffect(() => {
    load(stateHead);
    return () => {
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── W2: distributor warnings — fetched lazily when the tab is opened ───────
  const [tab, setTab] = useState("state-heads");
  const [distData, setDistData] = useState<DistributorWarningsResponse | null>(null);
  // The head we last successfully fetched for — compared against the SELECTED
  // head (server may canonicalise casing, so never compare response.stateHead).
  const [distHead, setDistHead] = useState<string | null>(null);
  const [distLoading, setDistLoading] = useState(false);
  const [distError, setDistError] = useState<string | null>(null);
  const distSeq = useRef(0);

  const loadDist = useCallback(
    async (sh: string) => {
      const seq = ++distSeq.current;
      setDistLoading(true);
      setDistError(null);
      try {
        const res = await fetch(
          `${API}/warnings/distributors?fy=${encodeURIComponent(fy)}&stateHead=${encodeURIComponent(sh)}`,
        );
        if (seq !== distSeq.current) return;
        if (!res.ok) throw new Error(`Distributor warnings failed (${res.status})`);
        const json = (await res.json()) as DistributorWarningsResponse;
        if (seq !== distSeq.current) return;
        setDistData(json);
        setDistHead(sh);
      } catch (e) {
        if (seq !== distSeq.current) return;
        setDistError((e as Error).message);
      } finally {
        if (seq === distSeq.current) setDistLoading(false);
      }
    },
    [fy],
  );

  // Fetch when the Distributors tab is first opened or the state head changes.
  useEffect(() => {
    if (tab === "distributors" && (!distData || distHead !== stateHead)) {
      loadDist(stateHead);
    }
  }, [tab, stateHead]); // eslint-disable-line react-hooks/exhaustive-deps

  const distDataUrl = distData
    ? `${API}/warnings/distributors?fy=${encodeURIComponent(fy)}&stateHead=${encodeURIComponent(distData.stateHead)}`
    : null;
  useSnapshotRefresh(distData?.meta, distDataUrl, (fresh) => {
    // Only commit a background refresh that still matches the active head.
    const f = fresh as DistributorWarningsResponse;
    setDistData((prev) => (prev && prev.stateHead === f.stateHead ? f : prev));
  });

  // Never render the PREVIOUS head's distributor cards under a new selection —
  // show the loading state until the matching payload arrives.
  const distCurrent = distData && distHead === stateHead ? distData : null;

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground shrink-0">State Head</label>
          <Select
            value={stateHead}
            onValueChange={(v) => {
              setStateHead(v);
              load(v);
            }}
          >
            <SelectTrigger className="w-52 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(data?.availableStateHeads ?? [DEFAULT_HEAD]).map((sh) => (
                <SelectItem key={sh} value={sh}>
                  {sh}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">FY {fy}</span>
        <a
          href={`${API}/warnings/export?fy=${encodeURIComponent(fy)}&stateHead=${encodeURIComponent(stateHead)}`}
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-warnings"
        >
          <Download className="w-3.5 h-3.5" />
          Export Excel
        </a>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load(stateHead)}
          disabled={loading}
          className="h-8"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {/* Cold-start snapshot freshness */}
      <SnapshotBanner meta={data?.meta} />

      {/* Quota wait */}
      {quotaWait && <QuotaWaitBanner testId="banner-quota-wait-warnings" />}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {/* Tabs */}
      {data && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="state-heads" className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              State Heads
            </TabsTrigger>
            <TabsTrigger value="distributors" className="flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5" />
              Distributors
            </TabsTrigger>
          </TabsList>

          {/* ── State Heads tab ────────────────────────────────────────── */}
          <TabsContent value="state-heads" className="mt-0 space-y-4">
            <TeamSummary
              summary={data.teamSummary}
              stateHead={data.stateHead}
              elapsedFraction={data.elapsedFraction}
            />

            {/* Severity legend */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span className="font-medium">Severity:</span>
              {(["RED", "ORANGE", "YELLOW"] as WarningSeverity[]).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={cn("w-2 h-2 rounded-full", SEV_CONFIG[s].dot)} />
                  {s === "RED"
                    ? "RED — escalate"
                    : s === "ORANGE"
                      ? "ORANGE — act"
                      : "YELLOW — watch"}
                </span>
              ))}
              <span className="text-muted-foreground/70 ml-1">
                · Arrows show trend (↓ worsening shifts severity up)
              </span>
            </div>

            {/* Member cards */}
            <div className="space-y-3">
              {data.members.map((m) => (
                <MemberPanel key={m.memberKey} member={m} />
              ))}
              {data.members.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No members found for {data.stateHead}.
                </p>
              )}
            </div>
          </TabsContent>

          {/* ── Distributors tab (W2) ─────────────────────────────────── */}
          <TabsContent value="distributors" className="mt-0 space-y-4">
            {distError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {distError}
              </div>
            )}
            {distLoading && !distCurrent && (
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Reading member sheets and registers for {stateHead}'s distributors — the first load
                  can take a minute or two.
                </div>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
                ))}
              </div>
            )}
            {distCurrent && (
              <>
                <SnapshotBanner meta={distCurrent.meta} />
                {/* Channel + period note */}
                <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-1">
                  <p className="flex items-start gap-1.5">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>{distCurrent.channelNote}</span>
                  </p>
                  <p className="pl-5">
                    {distCurrent.period} · {distCurrent.summary.indexBasis}
                  </p>
                  {distCurrent.membersFailed > 0 && (
                    <p className="pl-5 text-orange-600">
                      {distCurrent.membersFailed} member sheet(s) failed to load this pass — figures may
                      be incomplete.
                    </p>
                  )}
                </div>

                {/* Summary strip */}
                <Card>
                  <CardContent className="grid grid-cols-2 sm:grid-cols-5 gap-4 px-4 py-3">
                    <Stat
                      label="Distributors"
                      value={String(distCurrent.summary.distributorCount)}
                    />
                    <Stat
                      label="With warnings"
                      value={String(distCurrent.summary.withWarnings)}
                      highlight={distCurrent.summary.withWarnings > 0}
                    />
                    <Stat
                      label="Total Retailers beneath them"
                      value={distCurrent.summary.totalRetailers.toLocaleString("en-IN")}
                      note="retail outlets — formerly 'Total Dealer'"
                    />
                    <Stat
                      label="Largest share of party OB"
                      value={
                        distCurrent.summary.largestShare
                          ? `${trunc2(distCurrent.summary.largestShare.sharePct)}%`
                          : "—"
                      }
                      note={distCurrent.summary.largestShare?.name}
                      highlight={(distCurrent.summary.largestShare?.sharePct ?? 0) >= 40}
                    />
                    <Stat
                      label="Unassigned retailers (E2)"
                      value={String(distCurrent.summary.assignmentGapRetailers)}
                      note="administrative fix — see Distributor Deep Dive"
                      highlight={distCurrent.summary.assignmentGapRetailers > 0}
                    />
                  </CardContent>
                </Card>

                {/* Direct dealer parallel branch */}
                {distCurrent.directDealer && (
                  <div className="rounded-lg border border-border bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">
                      Direct Dealers — parallel branch:
                    </span>{" "}
                    {distCurrent.directDealer.retailerCount} buying straight from Prayag with no
                    distributor above them
                    {distCurrent.directDealer.dashboardOb != null
                      ? ` · OB ₹${trunc2(distCurrent.directDealer.dashboardOb / 1e5)} L (Data tab)`
                      : ""}
                    . Not covered by these warnings — they have no distributor relationship to
                    assess.
                  </div>
                )}

                {/* Distributor cards */}
                <div className="space-y-3">
                  {distCurrent.distributors.map((d) => (
                    <DistributorPanel key={d.normKey} dist={d} />
                  ))}
                  {distCurrent.distributors.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No distributors found for {distCurrent.stateHead}.
                    </p>
                  )}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
