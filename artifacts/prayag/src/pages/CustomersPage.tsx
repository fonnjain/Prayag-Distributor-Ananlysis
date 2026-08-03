import { trunc2 } from "@/lib/trunc";
// Customer Performance — distributor, dealer, retailer analytics.
//
// Rule Zero: UNITS FIRST, VALUE SECOND. Every view leads with qty (pcs).
// Price effect = value growth% - qty growth% shows how much "growth" is price, not volume.
// Primary (distributor/dealer) and secondary (retailer) figures are never blended.
//
// Navigation: this page is content-only — AppShell provides the sidebar and
// routes to /customers, /customers/shrinkers, /customers/churn, /customers/schemes.
import { LoadingState } from "@/components/ui/loading-state";
import { useState, useEffect, lazy, Suspense } from "react";
import { useLocation } from "wouter";
import PeriodPicker, { defaultPeriodValue, type PeriodValue } from "@/components/ui/PeriodPicker";
import StateFilter from "@/components/ui/StateFilter";
import CustomerRanking, { type CustomerRow } from "@/components/customers/CustomerRanking";
import CustomerDetail from "@/components/customers/CustomerDetail";
import CustomerAtRisk from "@/components/customers/CustomerChurn";
import PriceShrinkers from "@/components/customers/PriceShrinkers";
import CustomerMasterPage from "@/components/customers/CustomerMasterPage";
import { cn } from "@/lib/utils";

const SchemeNudgeEngine = lazy(
  () => import("@/components/customers/SchemeNudgeEngine"),
);

// ── Section registry ──────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "rankings",  label: "Rankings" },
  { id: "shrinkers", label: "Price Shrinkers" },
  { id: "churn",     label: "At Risk & New" },
  { id: "schemes",   label: "Schemes" },
  { id: "master",    label: "Customer Data" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function sectionFromLocation(loc: string): SectionId {
  if (loc.includes("/shrinkers")) return "shrinkers";
  if (loc.includes("/churn"))     return "churn";
  if (loc.includes("/schemes"))   return "schemes";
  if (loc.includes("/master"))    return "master";
  return "rankings";
}

/** Convert CY month label to the corresponding LY label (same month, year −1). */
function toLyMonth(m: string): string {
  return `${m.slice(0, 4)}${parseInt(m.slice(4), 10) - 1}`;
}

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  const [location, navigate] = useLocation();

  // Section is URL-driven — AppShell handles the section nav.
  const activeSection = sectionFromLocation(location);

  // CustomerMasterPage owns its own full-height layout — render it standalone.
  if (activeSection === "master") {
    return <CustomerMasterPage />;
  }

  function navigate2(section: SectionId) {
    navigate(section === "rankings" ? "/customers" : `/customers/${section}`);
    if (section !== "master") setSelectedCustomer(null);
  }

  // Filter state
  const [fyCy, setFyCy] = useState("2026-27");
  const [fyLy, setFyLy] = useState("2025-26");
  const [periodValue, setPeriodValue] = useState<PeriodValue>(defaultPeriodValue());
  const [entityType, setEntityType] = useState("all");
  const [selectedStates, setSelectedStates] = useState<string[]>([]);

  // Available months from DB
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [completeMonths, setCompleteMonths] = useState<string[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Derived months
  const [monthsCy, setMonthsCy] = useState<string[]>([]);
  const [monthsLy, setMonthsLy] = useState<string[]>([]);

  // Rankings data
  const [rankData, setRankData] = useState<CustomerRow[]>([]);
  const [rankLoading, setRankLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  // Set when the active head filter has a cross-FY key split; LY columns are suppressed.
  const [headYoySplit, setHeadYoySplit] = useState<{ priorCanon: string; splitFromFy: string } | null>(null);

  // Seasonal projection for the current period
  const [seasonalProjection, setSeasonalProjection] = useState<{
    pctElapsed: number;
    projectFactor: number | null;
  } | null>(null);

  // Load available months on FY change, then poll while a sync is in progress.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      fetch(`${BASE}/api/customers/months?fy=${fyCy}`)
        .then((r) => r.json())
        .then((d: {
          months?: string[];
          completeMonths?: string[];
          lastSyncedAt?: string | null;
          syncing?: boolean;
          syncError?: string;
        }) => {
          if (cancelled) return;
          setAvailableMonths(d.months ?? []);
          setCompleteMonths(d.completeMonths ?? []);
          setLastSyncedAt(d.lastSyncedAt ?? null);
          setSyncing(d.syncing ?? false);
          setSyncError(d.syncError ?? null);
          if (d.syncing) timer = setTimeout(load, 15_000);
        })
        .catch(() => { if (!cancelled) setSyncing(false); });
    };

    setSyncing(false);
    setSyncError(null);
    setAvailableMonths([]);
    setCompleteMonths([]);
    setLastSyncedAt(null);
    load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fyCy]);

  const partialMonths = availableMonths.filter((m) => !completeMonths.includes(m));

  // Reset period picker on FY change
  useEffect(() => {
    setPeriodValue(defaultPeriodValue());
    setMonthsCy([]);
    setMonthsLy([]);
  }, [fyCy]);

  // Re-resolve period → months whenever complete months or picker value changes
  useEffect(() => {
    if (!completeMonths.length) return;
    let cy: string[];
    if (periodValue.mode === "preset") {
      if (periodValue.preset === "full") {
        cy = completeMonths;
      } else {
        const year = parseInt(fyCy.split("-")[0], 10);
        const yy = String(year).slice(-2);
        const nyy = String(year + 1).slice(-2);
        const slices: Record<string, [number, number]> = {
          Q1: [0, 3], Q2: [3, 6], Q3: [6, 9], Q4: [9, 12],
          H1: [0, 6], H2: [6, 12],
        };
        const allFy = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"].map(
          (m) => (["Jan","Feb","Mar"].includes(m) ? `${m}-${nyy}` : `${m}-${yy}`)
        );
        const [s, e] = slices[periodValue.preset] ?? [0, 3];
        cy = allFy.slice(s, e).filter((m) => completeMonths.includes(m));
      }
    } else if (periodValue.mode === "monthly") {
      cy = periodValue.singleMonth
        ? [periodValue.singleMonth]
        : (completeMonths.length ? [completeMonths[completeMonths.length - 1]] : []);
    } else {
      const from = periodValue.fromMonth || availableMonths[0] || "";
      const to   = periodValue.toMonth   || availableMonths[availableMonths.length - 1] || "";
      const fi = availableMonths.indexOf(from);
      const ti = availableMonths.indexOf(to);
      cy = fi !== -1 && ti !== -1 && fi <= ti ? availableMonths.slice(fi, ti + 1) : [];
    }
    setMonthsCy(cy);
    setMonthsLy(cy.map(toLyMonth));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeMonths, periodValue.mode, periodValue.preset, periodValue.singleMonth, periodValue.fromMonth, periodValue.toMonth, fyCy]);

  // Load rankings when filters change (including state filter)
  useEffect(() => {
    if (!monthsCy.length) return;
    setRankLoading(true);
    // Clear previous-period figures immediately — never show stale numbers
    // while the newly selected FY/period is still loading.
    setRankData([]);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      entityType,
    });
    if (selectedStates.length) params.set("states", selectedStates.join(","));
    fetch(`${BASE}/api/customers/performance?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setRankData(d.data ?? []);
        setHeadYoySplit(d.headYoySplit ?? null);
        if (d.seasonalProjection) {
          setSeasonalProjection({
            pctElapsed: d.seasonalProjection.pctElapsed ?? 0,
            projectFactor: d.seasonalProjection.projectFactor ?? null,
          });
        }
      })
      .catch(() => {})
      .finally(() => setRankLoading(false));
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), entityType, selectedStates.join(",")]);

  const periodLabel = monthsCy.length
    ? `${monthsCy[0]} – ${monthsCy[monthsCy.length - 1]}`
    : "No data";

  const sectionLabel = SECTIONS.find((s) => s.id === activeSection)?.label ?? "Rankings";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center gap-2 border-b px-4 py-2.5 flex-shrink-0 flex-wrap">
        <h1 className="font-semibold text-sm whitespace-nowrap">
          Customer Performance
          <span className="ml-2 text-xs text-muted-foreground font-normal">{sectionLabel}</span>
        </h1>

        {/* Section tabs (hidden on very small screens, AppShell handles nav) */}
        <div className="hidden sm:flex items-center gap-1 ml-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => navigate2(s.id)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
                activeSection === s.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* Entity type */}
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            <option value="distributor">Distributor</option>
            <option value="direct_dealer">Direct Dealer</option>
          </select>

          {/* FY */}
          <select
            value={fyCy}
            onChange={(e) => {
              const fy = e.target.value;
              const year = parseInt(fy.split("-")[0], 10);
              setFyCy(fy);
              setFyLy(`${year - 1}-${String(year).slice(-2)}`);
            }}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            {["2026-27", "2025-26", "2024-25", "2023-24", "2022-23"].map((fy) => (
              <option key={fy} value={fy}>FY {fy}</option>
            ))}
          </select>

          {/* Period */}
          <PeriodPicker
            availableMonths={availableMonths}
            completeMonths={completeMonths}
            fy={fyCy}
            value={periodValue}
            onChange={(next) => setPeriodValue(next)}
          />

          {/* State filter */}
          <StateFilter selected={selectedStates} onChange={setSelectedStates} />

          <span className="text-xs text-muted-foreground hidden md:block">
            {periodLabel}
          </span>

          {lastSyncedAt && (
            <span className="text-xs text-muted-foreground hidden lg:block">
              synced {new Date(lastSyncedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {monthsCy.length === 0 && availableMonths.length === 0 && syncing && (
          <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
            Loading register data from Sheets for {fyCy} — this takes a minute or two on first load. The page will refresh automatically.
          </div>
        )}
        {monthsCy.length === 0 && availableMonths.length === 0 && !syncing && syncError && (
          <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Register sync failed for {fyCy}: {syncError}
          </div>
        )}
        {partialMonths.length > 0 && (
          <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            {partialMonths.join(", ")} {partialMonths.length === 1 ? "is" : "are"} in progress and excluded from all comparisons. Data through the last complete month ({completeMonths[completeMonths.length - 1] ?? "none"}) is used.
          </div>
        )}

        {activeSection === "rankings" && seasonalProjection && seasonalProjection.pctElapsed > 0 && seasonalProjection.pctElapsed < 95 && completeMonths.length < 12 && (
          <div className="mb-3 rounded-md border border-blue-200/60 bg-blue-50/50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800/40 dark:bg-blue-950/30 dark:text-blue-300">
            <span className="font-medium">Seasonal context:</span>{" "}
            {monthsCy.length === 1 ? monthsCy[0] : `${monthsCy[0]}–${monthsCy[monthsCy.length - 1]}`}{" "}
            represents {trunc2(seasonalProjection.pctElapsed)}% of the annual total (seasonal weights).
            {seasonalProjection.projectFactor != null && (
              <span>
                {" "}Full-year projection = period total &times; {trunc2(seasonalProjection.projectFactor)}.
                Comparisons are like-period (same months vs prior year), not annual verdicts.
              </span>
            )}
          </div>
        )}

        {activeSection === "rankings" && (
          <div className={cn("flex gap-4", selectedCustomer ? "flex-row" : "flex-col")}>
            <div className={selectedCustomer ? "flex-1 min-w-0" : "w-full"}>
              <CustomerRanking
                data={rankData}
                loading={rankLoading}
                onSelectCustomer={(c) => setSelectedCustomer((prev) => (prev === c ? null : c))}
                selectedCustomer={selectedCustomer}
                fyCy={fyCy}
                fyLy={fyLy}
                headYoySplit={headYoySplit}
              />
            </div>
            {selectedCustomer && (
              <div className="w-full lg:w-[520px] flex-shrink-0 rounded-md border p-4">
                <CustomerDetail
                  customer={selectedCustomer}
                  fyCy={fyCy}
                  fyLy={fyLy}
                  monthsCy={monthsCy}
                  monthsLy={monthsLy}
                  onClose={() => setSelectedCustomer(null)}
                />
              </div>
            )}
          </div>
        )}

        {activeSection === "shrinkers" && (
          <PriceShrinkers
            fyCy={fyCy}
            fyLy={fyLy}
            monthsCy={monthsCy}
            monthsLy={monthsLy}
            entityType={entityType}
          />
        )}

        {activeSection === "churn" && (
          <CustomerAtRisk
            fyCy={fyCy}
            fyLy={fyLy}
            monthsCy={monthsCy}
            monthsLy={monthsLy}
            entityType={entityType}
          />
        )}

        {activeSection === "schemes" && (
          <Suspense
            fallback={<LoadingState className="h-32" />}
          >
            <SchemeNudgeEngine />
          </Suspense>
        )}
      </div>
    </div>
  );
}
