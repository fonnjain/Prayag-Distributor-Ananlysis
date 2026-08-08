// SKU Deep Dive — Phase K2 + K3 + K3b + K4.
//
// Five sections driven by internal state (not URL sub-routes):
//   Overview  — all canonical segments sorted by net; click → drill.
//   Drill     — code-level breakdown for one segment.
//   Review    — company-wide gap codes (no distributor is buying these).
//   Push      — per-distributor peer-cohort push list (K3b).
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
import SkuPushList, { type DistributorListItem, type PushListResult } from "@/components/sku/SkuPushList";
import SkuDiscounts from "@/components/sku/SkuDiscounts";
import SkuSeasonality from "@/components/sku/SkuSeasonality";
import SkuMovement from "@/components/sku/SkuMovement";
import { cn } from "@/lib/utils";
import { ChevronLeft, Download } from "lucide-react";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  entityFilterQuery,
  hasEntityFilter,
  type EntityFilterValue,
} from "@/components/dashboard/CompanyReportFilters";

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
  project: CapabilityEntry;
};

type MemberResolution = {
  head: string;
  membersTotal: number;
  membersMatched: number;
  matchedKeys: string[];
  unmatchedMembers: string[];
};

type FactsResponse = {
  capability: Capability;
  /** retailer + head scope only: how the state head resolved to register member names. */
  memberResolution?: MemberResolution | null;
  facts: {
    bySegment: SegmentRow[];
    byCode: CodeRow[];
    truncated: boolean;
    unmapped: { codeCount: number; value: number; valueShare: number };
    summary: { totalCodes: number; totalQty: number; totalNet: number; segmentsBought: number };
  } | null;
};

// ── Page ───────────────────────────────────────────────────────────────────────

type Section = "overview" | "drill" | "focus" | "push" | "trends" | "discounts" | "timing" | "movement";
type Level = "distributor" | "direct_dealer" | "retailer" | "project";

export default function SkuPage() {
  // Filters
  const [fy, setFy] = useState("2026-27");
  const [level, setLevel] = useState<Level>("distributor");
  const [periodId, setPeriodId] = useState<PeriodPresetId>("q1");
  // State-head scope — "" = company-wide. Applies to Overview/Drill facts and Timing.
  const [scopeHead, setScopeHead] = useState<string>("");
  // Shared State Head / State / Distributor filter (same bar as Products/Growth).
  // Primary channels only — the secondary register has no state/distributor
  // columns, so the bar is hidden (and the filter dropped) for retailer level.
  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);
  const filterQuery = level === "retailer" ? "" : entityFilterQuery(entityFilter);

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

  // Fetch state — focus / review (K3 company-wide gap review)
  const [focusData, setFocusData] = useState<FocusData | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  // Distributor list — pre-fetched for the Push selector
  const [distributorList, setDistributorList] = useState<DistributorListItem[]>([]);
  const [distributorListLoading, setDistributorListLoading] = useState(false);

  // Push state — per-distributor peer push list (K3b)
  const [selectedDistributor, setSelectedDistributor] = useState<string | null>(null);
  const [pushData, setPushData] = useState<PushListResult | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // Fetch state — trends
  const [trendData, setTrendData] = useState<TrendData | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);

  const period = PERIOD_PRESETS.find((p) => p.id === periodId) ?? PERIOD_PRESETS[0];

  // State-head options for the scope selector (distinct headCanon from the
  // distributor list — the same vocabulary sale_line carries).
  const headOptions = [...new Set(
    distributorList.map((d) => d.headCanon).filter((h): h is string => !!h),
  )].sort();

  // ── Fetch overview (all segments, no segment filter) ─────────────────────────

  const fetchOverview = useCallback(() => {
    setOverviewLoading(true);
    setOverviewError(null);
    const params = new URLSearchParams({
      fy,
      level,
      scope: scopeHead ? "head" : "company",
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
    });
    if (scopeHead) params.set("scopeId", scopeHead);
    fetch(`${BASE}/api/sku/facts?${params}${filterQuery}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FactsResponse>;
      })
      .then(setOverviewData)
      .catch((e: Error) => setOverviewError(e.message))
      .finally(() => setOverviewLoading(false));
  }, [fy, level, period.monthFrom, period.monthTo, scopeHead, filterQuery]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  // ── Fetch drill (single segment) ─────────────────────────────────────────────

  useEffect(() => {
    if (section !== "drill" || !drillSegment) return;
    setDrillLoading(true);
    setDrillError(null);
    const params = new URLSearchParams({
      fy,
      level,
      scope: scopeHead ? "head" : "company",
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
      segment: drillSegment,
    });
    if (scopeHead) params.set("scopeId", scopeHead);
    fetch(`${BASE}/api/sku/facts?${params}${filterQuery}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FactsResponse>;
      })
      .then(setDrillData)
      .catch((e: Error) => setDrillError(e.message))
      .finally(() => setDrillLoading(false));
  }, [section, drillSegment, fy, level, period.monthFrom, period.monthTo, scopeHead, filterQuery]);

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
    fetch(`${BASE}/api/sku/recommendations?${params}${filterQuery}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FocusData>;
      })
      .then(setFocusData)
      .catch((e: Error) => setFocusError(e.message))
      .finally(() => setFocusLoading(false));
  }, [section, fy, level, period.monthFrom, period.monthTo, filterQuery]);

  // ── Fetch distributor list (eager — pre-load when level or FY changes) ────────

  useEffect(() => {
    // Distributor level list also feeds the state-head scope selector, so it is
    // fetched for every level (retailer/project fall back to distributor heads).
    setDistributorListLoading(true);
    const listLevel = level === "retailer" || level === "project" ? "distributor" : level;
    const params = new URLSearchParams({ fy, level: listLevel });
    fetch(`${BASE}/api/sku/distributors?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ distributors: DistributorListItem[] }>;
      })
      .then((d) => setDistributorList(d.distributors))
      .catch(() => setDistributorList([]))
      .finally(() => setDistributorListLoading(false));
  }, [fy, level]);

  // ── Fetch push list (fires when section = push AND a distributor is selected) ─

  useEffect(() => {
    if (section !== "push" || !selectedDistributor) return;
    setPushLoading(true);
    setPushError(null);
    const params = new URLSearchParams({
      fy,
      level,
      monthFrom: String(period.monthFrom),
      monthTo: String(period.monthTo),
      distributorKey: selectedDistributor,
    });
    fetch(`${BASE}/api/sku/push-list?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PushListResult>;
      })
      .then(setPushData)
      .catch((e: Error) => setPushError(e.message))
      .finally(() => setPushLoading(false));
  }, [section, fy, level, period.monthFrom, period.monthTo, selectedDistributor]);

  // ── Fetch trend (all FYs) ─────────────────────────────────────────────────────

  useEffect(() => {
    if (section !== "trends") return;
    setTrendLoading(true);
    setTrendError(null);
    setTrendData(null);
    const params = new URLSearchParams(
      scopeHead
        ? { level, scope: "head", scopeId: scopeHead }
        : { level, scope: "company" },
    );
    fetch(`${BASE}/api/sku/trend?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TrendData>;
      })
      .then(setTrendData)
      .catch((e: Error) => setTrendError(e.message))
      .finally(() => setTrendLoading(false));
  }, [section, level, scopeHead]);

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

  function handleSelectDistributor(customer: string | null) {
    setSelectedDistributor(customer);
    setPushData(null);
    setPushError(null);
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

          {/* Review (K3 company-wide gap list) — always visible */}
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
            Review
          </button>

          {/* Push (K3b per-distributor) — visible for distributor/direct_dealer only */}
          {level !== "retailer" && level !== "project" && (
            <button
              type="button"
              onClick={() => setSection("push")}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
                section === "push"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              Push
            </button>
          )}

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

          {/* Discounts (K4) — reacts to fy */}
          <button
            type="button"
            onClick={() => setSection("discounts")}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "discounts"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Discounts
          </button>

          {/* Timing (K4 seasonality) — fy-independent */}
          <button
            type="button"
            onClick={() => setSection("timing")}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "timing"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Timing
          </button>

          {/* Movement (K4) — reacts to fy */}
          <button
            type="button"
            onClick={() => setSection("movement")}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              section === "movement"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Movement
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
              setPushData(null);
              setSelectedDistributor(null);
            }}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="distributor">Distributor</option>
            <option value="direct_dealer">Direct Dealer</option>
            <option value="project">Project / Govt</option>
            <option value="retailer">Retailer</option>
          </select>

          {/* State-head scope — applies to Overview / Drill / Trends / Timing */}
          {level !== "project" && (
            <select
              value={scopeHead}
              onChange={(e) => {
                setScopeHead(e.target.value);
                setOverviewData(null);
                setDrillData(null);
                setTrendData(null);
              }}
              className="rounded border bg-background px-2 py-1 text-xs"
              title="Scope figures to one State Head's territory"
            >
              <option value="">All heads (company)</option>
              {headOptions.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          )}

          {/* Shared State Head / State / Distributor filter — primary channels only.
              Hidden on Trends and Timing: getSkuTrend/getSkuTiming do not accept
              entityFilter, so showing the bar would make it appear functional when
              it isn't. Use the scope dropdown above instead. */}
          {level !== "retailer" && section !== "trends" && section !== "timing" && (
            <CompanyReportFilterBar fy={fy} value={entityFilter} onChange={setEntityFilter} />
          )}

          {/* Excel export — Segments + Codes for the current level/period/filters */}
          <a
            href={`${BASE}/api/sku/export?fy=${fy}&level=${level}&monthFrom=${period.monthFrom}&monthTo=${period.monthTo}${scopeHead ? `&scope=head&scopeId=${encodeURIComponent(scopeHead)}` : ""}${filterQuery}`}
            download
            className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted/40"
            data-testid="button-export-excel-sku"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </a>

          {/* FY + Period — hidden on Trends / Timing (span all FYs) */}
          {section !== "trends" && section !== "timing" && (
            <>
              <select
                value={fy}
                onChange={(e) => {
                  setFy(e.target.value);
                  setOverviewData(null);
                  setDrillData(null);
                  setFocusData(null);
                  setPushData(null);
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
                  setPushData(null);
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
              {scopeHead
                ? `${levelLabel[level]} · ${scopeHead} · All FYs`
                : `${levelLabel[level]} · All heads · All FYs`}
            </span>
          )}

          {section === "timing" && (
            <span className="text-xs text-muted-foreground hidden lg:block">
              Seasonality · All FYs
            </span>
          )}
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {level !== "retailer" && hasEntityFilter(entityFilter) && section !== "trends" && section !== "timing" && (
          <p className="mb-3 text-[11px] text-amber-700 dark:text-amber-400">
            Filters active — figures below are a subset and will not match the unfiltered totals.
            Breadth denominators (codes ever sold) stay company-wide.
          </p>
        )}
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

        {/* Retailer + head scope: member resolution (PS-code vocabulary mismatch) */}
        {section === "overview" && level === "retailer" && scopeHead &&
          overviewData?.memberResolution && (
          <div className="mb-4 rounded-md border border-blue-300/50 bg-blue-500/5 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
            <span className="font-medium">{overviewData.memberResolution.head}:</span>{" "}
            {overviewData.memberResolution.membersMatched} of{" "}
            {overviewData.memberResolution.membersTotal} roster members matched in the
            secondary register (it uses a separate PS-code name vocabulary).
            {overviewData.memberResolution.unmatchedMembers.length > 0 && (
              <span className="ml-1 text-muted-foreground">
                No register match: {overviewData.memberResolution.unmatchedMembers.join(", ")}.
              </span>
            )}
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

        {section === "push" && (
          <SkuPushList
            distributorList={distributorList}
            distributorListLoading={distributorListLoading}
            selectedDistributor={selectedDistributor}
            onSelect={handleSelectDistributor}
            pushData={pushData}
            pushLoading={pushLoading}
            pushError={pushError}
            periodLabel={periodLabel}
            onDrill={handleFocusDrill}
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

        {section === "discounts" && (
          <SkuDiscounts
            fy={fy}
            channel={level === "project" ? "project" : "territory"}
            monthFrom={period.monthFrom}
            monthTo={period.monthTo}
            periodLabel={periodLabel}
          />
        )}

        {section === "timing" && <SkuSeasonality head={scopeHead || null} />}

        {section === "movement" && (
          <SkuMovement fy={fy} periodLabel={periodLabel} />
        )}
      </div>
    </div>
  );
}
