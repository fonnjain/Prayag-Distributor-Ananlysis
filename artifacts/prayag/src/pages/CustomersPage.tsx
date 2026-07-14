// Customer Performance — distributor, dealer, retailer analytics.
//
// Rule Zero: UNITS FIRST, VALUE SECOND. Every view leads with qty (pcs).
// Price effect = value growth% - qty growth% shows how much "growth" is price, not volume.
// Primary (distributor/dealer) and secondary (retailer) figures are never blended.
import { useState, useEffect, lazy, Suspense } from "react";
import { useLocation } from "wouter";
import { useTheme } from "next-themes";
import {
  Sun,
  Moon,
  Menu,
  X,
  ChevronLeft,
  BarChart2,
  AlertTriangle,
  UserMinus,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import PeriodPicker, { defaultPeriodValue, type PeriodValue } from "@/components/ui/PeriodPicker";
import CustomerRanking, { type CustomerRow } from "@/components/customers/CustomerRanking";
import CustomerDetail from "@/components/customers/CustomerDetail";
import CustomerAtRisk from "@/components/customers/CustomerChurn";
import PriceShrinkers from "@/components/customers/PriceShrinkers";

const SchemeDashboard = lazy(
  () => import("@/components/customers/SchemeDashboard"),
);
const SchemeNudgeEngine = lazy(
  () => import("@/components/customers/SchemeNudgeEngine"),
);

// ── Section registry ──────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "rankings", label: "Rankings", icon: BarChart2 },
  { id: "shrinkers", label: "Price Shrinkers", icon: AlertTriangle },
  { id: "churn", label: "At Risk & New", icon: UserMinus },
  { id: "schemes", label: "Schemes", icon: Settings },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Convert CY month label to the corresponding LY label (same month, year −1). */
function toLyMonth(m: string): string {
  return `${m.slice(0, 4)}${parseInt(m.slice(4), 10) - 1}`;
}

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  const [, navigate] = useLocation();
  const { theme, setTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>("rankings");

  // Filter state
  const [fyCy, setFyCy] = useState("2026-27");
  const [fyLy, setFyLy] = useState("2025-26");
  const [periodValue, setPeriodValue] = useState<PeriodValue>(defaultPeriodValue());
  const [entityType, setEntityType] = useState("all");

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
          // Keep polling while the server is still loading from Sheets.
          if (d.syncing) {
            timer = setTimeout(load, 15_000);
          }
        })
        .catch(() => {
          if (!cancelled) setSyncing(false);
        });
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

  // Partial months: months present in the DB but not yet complete (in-progress).
  const partialMonths = availableMonths.filter((m) => !completeMonths.includes(m));

  // When the FY changes, reset the period picker to Q1 preset so stale
  // custom/monthly selections from the previous FY don't carry over.
  // Also re-derive monthsCy/monthsLy when completeMonths or periodValue change
  // (handles the initial load when completeMonths first arrives from the API).
  useEffect(() => {
    setPeriodValue(defaultPeriodValue());
    setMonthsCy([]);
    setMonthsLy([]);
  }, [fyCy]);

  useEffect(() => {
    if (!completeMonths.length) return;
    // Re-resolve the current picker value against the newly loaded months.
    // Import the resolve logic inline (mirrors PeriodPicker internals).
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
      cy = periodValue.singleMonth ? [periodValue.singleMonth] : (completeMonths.length ? [completeMonths[completeMonths.length - 1]] : []);
    } else {
      // custom
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

  // Load rankings when filters change
  useEffect(() => {
    if (!monthsCy.length) return;
    setRankLoading(true);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      entityType,
    });
    fetch(`${BASE}/api/customers/performance?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setRankData(d.data ?? []);
        if (d.seasonalProjection) {
          setSeasonalProjection({
            pctElapsed: d.seasonalProjection.pctElapsed ?? 0,
            projectFactor: d.seasonalProjection.projectFactor ?? null,
          });
        }
      })
      .catch(() => {})
      .finally(() => setRankLoading(false));
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), entityType]);

  function navigate2(section: SectionId) {
    setActiveSection(section);
    setSidebarOpen(false);
    setSelectedCustomer(null);
  }

  const periodLabel = monthsCy.length
    ? `${monthsCy[0]} – ${monthsCy[monthsCy.length - 1]}`
    : "No data";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-56 flex-col border-r bg-background transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm">Customers</span>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => navigate2(s.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-colors",
                  activeSection === s.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t px-4 py-3">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3 w-3" />
            Dashboard
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b px-4 py-2.5 flex-shrink-0">
          <button className="lg:hidden" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="font-semibold text-sm">
            Customer Performance
            <span className="ml-2 text-xs text-muted-foreground font-normal">
              {SECTIONS.find((s) => s.id === activeSection)?.label}
            </span>
          </h1>

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
                <option key={fy} value={fy}>
                  FY {fy}
                </option>
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

            <span className="text-xs text-muted-foreground hidden sm:block">
              {periodLabel}
            </span>

            {lastSyncedAt && (
              <span className="text-xs text-muted-foreground hidden md:block">
                synced {new Date(lastSyncedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}

            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="ml-1 rounded-md p-1.5 hover:bg-muted"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4">
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
              represents {seasonalProjection.pctElapsed.toFixed(1)}% of the annual total (seasonal weights).
              {seasonalProjection.projectFactor != null && (
                <span>
                  {" "}A distributor running at last year&apos;s Q1 pace could finish the year at a different level once the heavier back-half months arrive.
                  Full-year projection = period total &times; {seasonalProjection.projectFactor.toFixed(1)}.
                  Comparisons above are like-period (same months vs prior year) and are not annual verdicts.
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
                  onSelectCustomer={(c) =>
                    setSelectedCustomer((prev) => (prev === c ? null : c))
                  }
                  selectedCustomer={selectedCustomer}
                  fyCy={fyCy}
                  fyLy={fyLy}
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
              fallback={
                <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                  Loading...
                </div>
              }
            >
              <SchemeNudgeEngine />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
