// SKU Deep Dive — Phase K2 + K3 + K4.
//
// Four sections driven by internal state (not URL sub-routes):
//   Overview  — all canonical segments sorted by net; click → drill.
//   Drill     — code-level breakdown for one segment.
//   Focus     — ranked push list: top gap codes per segment (K3).
//   Trends    — breadth % time-series and FY-over-FY comparisons.
//
// Filters: FY | Level (distributor/direct_dealer/retailer/project) | Period preset
// Scope defaults to company-wide. scopeId is omitted.
//
// Breadth denominator: codesEverSold (territory-channel-filtered, no project inflation).
// Always ∈ [0,100] — never exceeds 100%.
import { useState, useEffect, useCallback } from "react";
import SkuOverview, { type SegmentRow } from "@/components/sku/SkuOverview";
import SkuDrill, { type CodeRow } from "@/components/sku/SkuDrill";
import SkuTrends, { type TrendData } from "@/components/sku/SkuTrends";
import SkuFocus, { type FocusData } from "@/components/sku/SkuFocus";
import { cn } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Period presets ─────────────────────────────────────────────────────────────
// FY-relative months: April = 1, March = 12.

const PERIOD_PRESETS = [
  { id: "q1",   label: "Q1 (Apr–Jun)",  monthFrom: 1,  monthTo: 3  },
  { id: "q2",   label: "Q2 (Jul–Sep)",  monthFrom: 4,  monthTo: 6  },
  { id: "q3",   label: "Q3 (Oct–Dec)",  monthFrom: 7,  monthTo: 9  },
  { id: "q4",   label: "Q4 (Jan–Mar)",  monthFrom: 10, monthTo: 12 },
  { id: "h1",   label: "H1 (Apr–Sep)",  monthFrom: 1,  monthTo: 6  },
  { id: "h2",   label: "H2 (Oct–Mar)",  monthFrom: 7,  monthTo: 12 },
  { id: "full", label: "Full Year",     monthFrom: 1,  monthTo: 12 },
] as const;

type PeriodPresetId = (typeof PERIOD_PRESETS)[number]["id"];

const FYS = ["2026-27", "2025-26", "2024-25", "2023-24", "2022-23"];

// ── Response shapes ────────────────────────────────────────────────────────────

type CapabilityEntry = { available: boolean; reason?: string };
type Capability = {
  distributor: CapabilityEntry;
  direct_dealer: CapabilityEntry;
  retailer: CapabilityEntry;
};

type FactsResponse = {
  capability: Capability;
  facts: {
    bySegment: SegmentRow[];
    byCode: CodeRow[];
    truncated: boolean;
    unmapped: { codeCount: number; value: number; valueShare: number };
    summary: { totalCodes: number; totalQty: number; totalNet: number; segmentsBought: number };
  } | null;
};

// ── Page ───────────────────────────────────────────────────────────────────────

type Section = "overview" | "drill" | "focus" | "trends";
type Level = "distributor" | "direct_dealer" | "retailer" | "project";

export default function SkuPage() {
  // Filters
  const [fy, setFy] = useState("2026-27");
  const [level, setLevel] = useState<Level>("distributor");
  const [periodId, setPeriodId] = useState<PeriodPresetId>("q1");

  // Section state
  const [section, setSection] = useState<Section>("overview");
  const [drillSegment, setDrillSegment] = useState<string | null>(null);

  // Fetch state — overview
  const [overviewData, setOverviewData] = useState<FactsResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Fetch state — drill
  const [drillData, setDrillData] = useState<FactsResponse | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  // Fetch state — focus (K3 recommendations)
  const [focusData, setFocusData] = useState<FocusData | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  // Fetch state — trends
  const [trendData, setTrendData] = useState<TrendData | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);

  const period = PERIOD_PRESETS.find((p) => p.id === periodId) ?? PERIOD_PRESETS[0];

  // ── Fetch overview (all segments, no segment filter) ─────────────────────────

  const fetchOverview = useCallback(() => {
    setOverviewLoading(true);
    setOverviewError(null);
    const params = new URLSearchParams({
      fy,
      level,
      scope: "company",
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
    });
    fetch(`${BASE}/api/sku/facts?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FactsResponse>;
      })
      .then(setOverviewData)
      .catch((e: Error) => setOverviewError(e.message))
      .finally(() => setOverviewLoading(false));
  }, [fy, level, period.monthFrom, period.monthTo]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  // ── Fetch drill (single segment) ─────────────────────────────────────────────

  useEffect(() => {
    if (section !== "drill" || !drillSegment) return;
    setDrillLoading(true);
    setDrillError(null);
    const params = new URLSearchParams({
      fy,
      level,
      scope: "company",
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
      segment: drillSegment,
    });
    fetch(`${BASE}/api/sku/facts?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FactsResponse>;
      })
      .then(setDrillData)
      .catch((e: Error) => setDrillError(e.message))
      .finally(() => setDrillLoading(false));
  }, [section, drillSegment, fy, level, period.monthFrom, period.monthTo]);

  // ── Fetch focus (K3 recommendations) ─────────────────────────────────────────

  useEffect(() => {
    if (section !== "focus") return;
    setFocusLoading(true);
    setFocusError(null);
    const params = new URLSearchParams({
      fy,
      level,
      scope: "company",
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
    });
    fetch(`${BASE}/api/sku/recommendations?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FocusData>;
      })
      .then(setFocusData)
      .catch((e: Error) => setFocusError(e.message))
      .finally(() => setFocusLoading(false));
  }, [section, fy, level, period.monthFrom, period.monthTo]);

  // ── Fetch trend (all FYs) ─────────────────────────────────────────────────────

  useEffect(() => {
    if (section !== "trends") return;
    setTrendLoading(true);
    setTrendError(null);
    setTrendData(null);
    const params = new URLSearchParams({ level, scope: "company" });
    fetch(`${BASE}/api/sku/trend?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TrendData>;
      })
      .then(setTrendData)
      .catch((e: Error) => setTrendError(e.message))
      .finally(() => setTrendLoading(false));
  }, [section, level]);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleDrill(seg: string) {
    setDrillSegment(seg);
    setDrillData(null);
    setSection("drill");
  }

  function handleBack() {
    setSection("overview");
  }

  function handleFocusDrill(seg: string) {
    setDrillSegment(seg);
    setDrillData(null);
    setSection("drill");
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const activeCap = overviewData?.capability?.[level];
  const notAvailable = activeCap && !activeCap.available;

  const overviewRows = overviewData?.facts?.bySegment ?? [];
  const drillRows = drillData?.facts?.byCode ?? [];
  const drillTruncated = drillData?.facts?.truncated ?? false;

  // Segment fact from the overview response (for drill header stats)
  const drillSegmentFact = overviewData?.facts?.bySegment.find(
    (r) => r.segment === drillSegment,
  ) ?? null;

  const periodLabel = `${period.label}  FY ${fy}`;

  // Level display name
  const levelLabel: Record<Level, string> = {
    distributor: "Distributor",
    direct_dealer: "Direct Dealer",
    retailer: "Retailer",
    project: "Project / Govt",
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-2 border-b px-4 py-2.5 flex-shrink-0 flex-wrap">
        {/* Title + breadcrumb */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {section === "drill" && drillSegment ? (
            <>
              <button
                type="button"
                onClick={handleBack}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Back to overview"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="font-semibold text-sm">SKU Deep Dive</span>
              <span className="text-muted-foreground text-sm">/</span>
              <span className="text-sm font-medium">{drillSegment}</span>
            </>
          ) : (
            <span className="font-semibold text-sm">SKU Deep Dive</span>
          )}
        </div>

        {/* Section tabs */}
        <div className="hidden sm:flex items-center gap-1 ml-1">
          {/* Overview — always visible */}
          <button
            type="button"
            onClick={handleBack}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "overview"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Overview
          </button>

          {/* Drill — only when a segment is selected */}
          {drillSegment && (
            <button
              type="button"
              onClick={() => setSection("drill")}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
                section === "drill"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {drillSegment}
            </button>
          )}

          {/* Focus (K3) — always visible */}
          <button
            type="button"
            onClick={() => setSection("focus")}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "focus"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Focus
          </button>

          {/* Trends — always visible */}
          <button
            type="button"
            onClick={() => setSection("trends")}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "trends"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Trends
          </button>
        </div>

        {/* Filters */}
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* Level */}
          <select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as Level);
              setOverviewData(null);
              setDrillData(null);
              setFocusData(null);
              setTrendData(null);
            }}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="distributor">Distributor</option>
            <option value="direct_dealer">Direct Dealer</option>
            <option value="project">Project / Govt</option>
            <option value="retailer">Retailer</option>
          </select>

          {/* FY + Period — hidden on Trends (spans all FYs) */}
          {section !== "trends" && (
            <>
              <select
                value={fy}
                onChange={(e) => {
                  setFy(e.target.value);
                  setOverviewData(null);
                  setDrillData(null);
                  setFocusData(null);
                }}
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                {FYS.map((f) => (
                  <option key={f} value={f}>FY {f}</option>
                ))}
              </select>

              <select
                value={periodId}
                onChange={(e) => {
                  setPeriodId(e.target.value as PeriodPresetId);
                  setOverviewData(null);
                  setDrillData(null);
                  setFocusData(null);
                }}
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                {PERIOD_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>

              <span className="text-xs text-muted-foreground hidden lg:block">
                {levelLabel[level]} · {periodLabel}
              </span>
            </>
          )}

          {section === "trends" && (
            <span className="text-xs text-muted-foreground hidden lg:block">
              {levelLabel[level]} · All FYs
            </span>
          )}
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Not available notice (overview/drill only) */}
        {notAvailable && section !== "trends" && (
          <div className="mb-4 rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <span className="font-medium">{levelLabel[level]}</span>{" "}
            data is not available for FY {fy}.
            {activeCap?.reason && <span className="ml-1 text-xs">({activeCap.reason})</span>}
          </div>
        )}

        {/* Fetch errors */}
        {overviewError && section === "overview" && (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Failed to load SKU facts: {overviewError}
          </div>
        )}
        {drillError && section === "drill" && (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Failed to load code data: {drillError}
          </div>
        )}
        {trendError && section === "trends" && (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Failed to load trend data: {trendError}
          </div>
        )}

        {section === "overview" && (
          <SkuOverview
            rows={overviewRows}
            loading={overviewLoading}
            onDrill={handleDrill}
            unmapped={overviewData?.facts?.unmapped ?? null}
            summary={overviewData?.facts?.summary ?? null}
          />
        )}

        {section === "drill" && drillSegment && (
          <SkuDrill
            segment={drillSegment}
            rows={drillRows}
            loading={drillLoading}
            truncated={drillTruncated}
            onBack={handleBack}
            segmentFact={drillSegmentFact}
          />
        )}

        {section === "focus" && (
          <SkuFocus
            data={focusData}
            loading={focusLoading}
            error={focusError}
            onDrill={handleFocusDrill}
            periodLabel={periodLabel}
          />
        )}

        {section === "trends" && (
          trendLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-muted animate-pulse" />
              ))}
              <div className="h-64 rounded bg-muted animate-pulse" />
            </div>
          ) : trendData ? (
            <SkuTrends data={trendData} />
          ) : null
        )}
      </div>
    </div>
  );
}
