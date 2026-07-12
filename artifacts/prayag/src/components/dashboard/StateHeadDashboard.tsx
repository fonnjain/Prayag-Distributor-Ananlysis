import { useState, useEffect, useMemo } from "react";
import {
  Download,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  AlertTriangle,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

// ── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  normKey: string;
  name: string;
  stateHead: string;
  state: string;
  hq: string;
  dojLabel: string | null;
  workingState: string;
  channel: string;
  oldNew: string;
  activeLeft: string;
  targetSecondary: number | null;
  targetPrimary: number | null;
  targetBusinessPlan: number | null;
  orderBooking: number | null;
  saleAmount: number | null;
  priorOrderBooking: number | null;
  totalRetailers: number | null;
  oldRetailers: number | null;
  newRetailers: number | null;
  distributorCount: number | null;
  directDealerCount: number | null;
  orderCount: number | null;
  achievementPct: number | null;
  band: string;
  visitedParties: number | null;
  workingDays: number | null;
  ctcMonthly: number | null;
  costRatioPct: number | null;
  designation: string | null;
};

type DashboardMeta = {
  fy: string;
  monthFrom: number;
  monthTo: number;
  ordersAvailable: boolean;
  targetsAvailable: boolean;
  orderBookingNote: string | null;
  rosterSource: string;
  /** Head-level Sale (primary dispatch, Taxable Value). Null when no sheet configured for FY. */
  headSales?: Record<string, number>;
  /** Source label for the Sale tile (e.g. "State Head Sale 2025-26") */
  saleSource?: string | null;
  /** Source label for Order Booking tile (e.g. "Secondary Order Booking 2025-26") */
  orderBookingSource?: string | null;
};

type DashboardData = { rows: Member[]; meta: DashboardMeta };

type View = "data" | "lowPerf" | "summary" | "secondary" | "primary";

type SortState = { key: string; dir: "asc" | "desc" };

// ── Constants ─────────────────────────────────────────────────────────────────

type Period = { label: string; from: number; to: number };

const PERIODS: Period[] = [
  { label: "Q1 (Apr-Jun)", from: 1, to: 3 },
  { label: "Q2 (Jul-Sep)", from: 4, to: 6 },
  { label: "Q3 (Oct-Dec)", from: 7, to: 9 },
  { label: "Q4 (Jan-Mar)", from: 10, to: 12 },
  { label: "Full Year", from: 1, to: 12 },
];

const BAND_LABEL: Record<string, string> = {
  below25: "<25%",
  below50: "25-50%",
  "50to70": "50-70%",
  "70to90": "70-90%",
  "90to100": "90-100%",
  above100: ">100%",
  noTarget: "No Target",
};

const BAND_BG: Record<string, string> = {
  below25: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  below50: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "50to70": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "70to90": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  "90to100": "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  above100: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  noTarget: "bg-muted text-muted-foreground",
};

const VIEWS: { id: View; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "lowPerf", label: "Low Performers" },
  { id: "summary", label: "Summary by Head" },
  { id: "secondary", label: "Secondary" },
  { id: "primary", label: "Primary" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCr(n: number | null, digits = 2): string {
  if (n == null) return "—";
  return `\u20b9${(n / 1e7).toFixed(digits)} Cr`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtN(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function sortedRows<T extends Record<string, unknown>>(
  rows: T[],
  { key, dir }: SortState,
): T[] {
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp =
      typeof av === "string"
        ? (av as string).localeCompare(bv as string)
        : (av as number) - (bv as number);
    return dir === "asc" ? cmp : -cmp;
  });
}

function isLowPerf(band: string, threshold: number): boolean {
  if (band === "noTarget") return false;
  if (threshold <= 25) return band === "below25";
  return band === "below25" || band === "below50";
}

function isPrimary(m: Member): boolean {
  return m.channel.toLowerCase().includes("primary");
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BandChip({ band }: { band: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${BAND_BG[band] ?? BAND_BG.noTarget}`}
    >
      {BAND_LABEL[band] ?? band}
    </span>
  );
}

function KpiTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-0.5 min-w-[120px]">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <p className="text-lg font-bold leading-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </th>
  );
}

function Th({ label, className = "" }: { label: string; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap ${className}`}>
      {label}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 text-sm whitespace-nowrap ${className}`}>
      {children}
    </td>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StateHeadDashboard() {
  const [fy, setFy] = useState("2025-26");
  const [period, setPeriod] = useState<Period>(PERIODS[4]);
  const [stateHeadFilter, setStateHeadFilter] = useState("");
  const [search, setSearch] = useState("");
  const [activeView, setActiveView] = useState<View>("data");
  const [lowPerfThreshold, setLowPerfThreshold] = useState(50);
  const [sort, setSort] = useState<SortState>({ key: "achievementPct", dir: "asc" });

  const [fys, setFys] = useState<string[]>(["2026-27", "2025-26", "2024-25"]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Load FY options once
  useEffect(() => {
    fetch("/api/mgmt/options")
      .then((r) => r.json())
      .then((d: { fys?: string[] }) => {
        if (Array.isArray(d.fys) && d.fys.length > 0) setFys(d.fys);
      })
      .catch(() => {});
  }, []);

  // Reset period to default when FY changes
  useEffect(() => {
    setPeriod(fy === "2026-27" ? PERIODS[0] : PERIODS[4]);
  }, [fy]);

  // Fetch dashboard data when FY or period changes
  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      fy,
      monthFrom: String(period.from),
      monthTo: String(period.to),
    });
    fetch(`/api/mgmt/data?${params}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json();
      })
      .then((d: DashboardData) => {
        setData(d);
        setLoading(false);
        setStateHeadFilter("");
        setSearch("");
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, [fy, period]);

  function toggleSort(key: string) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  async function downloadExcel() {
    setDownloading(true);
    try {
      const res = await fetch("/api/mgmt/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fy,
          monthFrom: period.from,
          monthTo: period.to,
          lowPerfPct: lowPerfThreshold,
          states: stateHeadFilter ? [stateHeadFilter] : [],
          regions: [],
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(e.error ?? "Excel generation failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `StateHeadDashboard_${fy}_${period.label.replace(/[^A-Za-z0-9]+/g, "_")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  // Derived data
  const allHeads = useMemo(
    () =>
      data
        ? [...new Set(data.rows.map((r) => r.stateHead).filter(Boolean))].sort()
        : [],
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (stateHeadFilter && r.stateHead !== stateHeadFilter) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.stateHead.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [data, stateHeadFilter, search]);

  const lowPerfRows = useMemo(
    () => filteredRows.filter((r) => isLowPerf(r.band, lowPerfThreshold)),
    [filteredRows, lowPerfThreshold],
  );

  const summaryByHead = useMemo(() => {
    const map = new Map<
      string,
      {
        head: string;
        count: number;
        target: number;
        booking: number;
        sale: number;
        retailers: number;
        lowPerf: number;
        noTarget: number;
      }
    >();
    for (const r of filteredRows) {
      const head = r.stateHead || "Unknown";
      let s = map.get(head);
      if (!s) {
        s = { head, count: 0, target: 0, booking: 0, sale: 0, retailers: 0, lowPerf: 0, noTarget: 0 };
        map.set(head, s);
      }
      s.count++;
      s.target += r.targetSecondary ?? 0;
      s.booking += r.orderBooking ?? 0;
      s.sale += r.saleAmount ?? 0;
      s.retailers += r.totalRetailers ?? 0;
      if (r.band === "noTarget") s.noTarget++;
      else if (isLowPerf(r.band, lowPerfThreshold)) s.lowPerf++;
    }
    // Override per-head Sale with authoritative head-level data from the primary
    // dispatch sheet (meta.headSales). Member saleAmount is null when the Sale
    // source is head-level only, so the member-sum above would be 0 for those heads.
    const headSales = data?.meta.headSales;
    if (headSales) {
      for (const [, s] of map) {
        const fromMeta = headSales[s.head];
        if (fromMeta != null) s.sale = fromMeta;
      }
    }
    return [...map.values()].sort((a, b) => b.booking - a.booking);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, lowPerfThreshold, data?.meta.headSales]);

  // KPI aggregates over all filtered rows (regardless of active view)
  const kpi = useMemo(() => {
    const target = filteredRows.reduce((s, r) => s + (r.targetSecondary ?? 0), 0);
    const booking = filteredRows.reduce((s, r) => s + (r.orderBooking ?? 0), 0);
    // Sale: use the post-processed summaryByHead totals when head-level data is
    // available from meta (so stateHeadFilter is respected correctly).
    const sale = data?.meta.headSales
      ? summaryByHead.reduce((s, h) => s + h.sale, 0)
      : filteredRows.reduce((s, r) => s + (r.saleAmount ?? 0), 0);
    const lowPerf = filteredRows.filter((r) => isLowPerf(r.band, lowPerfThreshold)).length;
    const noTarget = filteredRows.filter((r) => r.band === "noTarget").length;
    return {
      target,
      booking,
      sale,
      achPct: target > 0 ? booking / target : null,
      members: filteredRows.length,
      lowPerf,
      noTarget,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, lowPerfThreshold, summaryByHead, data?.meta.headSales]);

  // Rows to render for each view (after sort)
  function viewRows(): Member[] {
    let rows =
      activeView === "lowPerf"
        ? lowPerfRows
        : activeView === "secondary"
          ? filteredRows.filter((r) => !isPrimary(r))
          : activeView === "primary"
            ? filteredRows.filter(isPrimary)
            : filteredRows;
    return sortedRows(rows as unknown as Record<string, unknown>[], sort) as unknown as Member[];
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">FY</label>
          <Select value={fy} onValueChange={setFy}>
            <SelectTrigger className="h-8 w-28 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fys.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Period</label>
          <Select
            value={`${period.from}-${period.to}`}
            onValueChange={(v) => {
              const p = PERIODS.find((x) => `${x.from}-${x.to}` === v);
              if (p) setPeriod(p);
            }}
          >
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={`${p.from}-${p.to}`} value={`${p.from}-${p.to}`}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">State Head</label>
          <Select value={stateHeadFilter || "__all__"} onValueChange={(v) => setStateHeadFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-44 text-sm">
              <SelectValue placeholder="All heads" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All heads</SelectItem>
              {allHeads.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(activeView === "lowPerf") && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Threshold</label>
            <Select
              value={String(lowPerfThreshold)}
              onValueChange={(v) => setLowPerfThreshold(Number(v))}
            >
              <SelectTrigger className="h-8 w-28 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">Below 25%</SelectItem>
                <SelectItem value="50">Below 50%</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Search</label>
          <Input
            className="h-8 w-48 text-sm"
            placeholder="Name or head..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={downloadExcel}
            disabled={downloading || loading}
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? "Generating..." : "Download Excel"}
          </Button>
        </div>
      </div>

      {/* Status / notes */}
      {data?.meta.orderBookingNote && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{data.meta.orderBookingNote}</span>
        </div>
      )}
      {data?.meta.rosterSource === "fallback" && (
        <div className="flex items-start gap-2 rounded-md border border-orange-200 bg-orange-50 dark:border-orange-900/40 dark:bg-orange-950/20 px-3 py-2 text-sm text-orange-800 dark:text-orange-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Roster loaded from bundled fallback — Google Sheets may be unavailable. Data may be outdated.</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* KPI tiles */}
      {data && (
        <div className="flex flex-wrap gap-3">
          <KpiTile label="Members" value={fmtN(kpi.members)} sub={`${kpi.noTarget} no target`} />
          <KpiTile label={`Target (${period.label})`} value={fmtCr(kpi.target > 0 ? kpi.target : null)} />
          <KpiTile
            label="Order Booking"
            value={data.meta.ordersAvailable ? fmtCr(kpi.booking) : "Pending"}
            sub={data.meta.orderBookingSource ?? undefined}
          />
          <KpiTile
            label="Achievement"
            value={data.meta.ordersAvailable ? fmtPct(kpi.achPct) : "Pending"}
          />
          <KpiTile label="Low Performers" value={fmtN(kpi.lowPerf)} sub={`<${lowPerfThreshold}% threshold`} />
          <KpiTile
            label="Sale"
            value={fmtCr(kpi.sale > 0 ? kpi.sale : null)}
            sub={data.meta.saleSource ?? undefined}
          />
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-1 border-b pb-0">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setActiveView(v.id)}
            className={`px-3 py-1.5 text-sm font-medium rounded-t transition-colors ${
              activeView === v.id
                ? "border border-b-background bg-background text-foreground -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.id === "lowPerf"
              ? `Low Performers${data ? ` (${lowPerfRows.length})` : ""}`
              : v.label}
          </button>
        ))}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Loading...
        </div>
      )}

      {/* ── Summary by Head view ── */}
      {!loading && data && activeView === "summary" && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <Th label="State Head" />
                <Th label="Members" className="text-right" />
                <Th label="Target" className="text-right" />
                <Th label="Order Booking" className="text-right" />
                <Th label="Ach%" className="text-right" />
                <Th label="Sale" className="text-right" />
                <Th label="Retailers" className="text-right" />
                <Th label={`Low Perf (<${lowPerfThreshold}%)`} className="text-right" />
                <Th label="No Target" className="text-right" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {summaryByHead.map((s) => {
                const pct = s.target > 0 ? s.booking / s.target : null;
                return (
                  <tr key={s.head} className="hover:bg-muted/30 transition-colors">
                    <Td className="font-medium">{s.head}</Td>
                    <Td className="text-right">{fmtN(s.count)}</Td>
                    <Td className="text-right">{fmtCr(s.target || null)}</Td>
                    <Td className="text-right">
                      {data.meta.ordersAvailable ? fmtCr(s.booking || null) : "—"}
                    </Td>
                    <Td className="text-right">
                      {data.meta.ordersAvailable ? fmtPct(pct) : "—"}
                    </Td>
                    <Td className="text-right">{fmtCr(s.sale || null)}</Td>
                    <Td className="text-right">{fmtN(s.retailers || null)}</Td>
                    <Td className="text-right">{fmtN(s.lowPerf || null)}</Td>
                    <Td className="text-right">{fmtN(s.noTarget || null)}</Td>
                  </tr>
                );
              })}
              {summaryByHead.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Primary view ── */}
      {!loading && data && activeView === "primary" && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortTh label="State Head" sortKey="stateHead" sort={sort} onSort={toggleSort} />
                <Th label="State" />
                <Th label="HQ" />
                <SortTh label="Distributors" sortKey="distributorCount" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Direct Dealers" sortKey="directDealerCount" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Target (Primary)" sortKey="targetPrimary" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Order Booking" sortKey="orderBooking" sort={sort} onSort={toggleSort} className="text-right" />
                <Th label="Old/New" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {viewRows().map((r) => (
                <tr key={r.normKey} className="hover:bg-muted/30 transition-colors">
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-muted-foreground">{r.stateHead}</Td>
                  <Td>{r.state}</Td>
                  <Td>{r.hq}</Td>
                  <Td className="text-right">{fmtN(r.distributorCount)}</Td>
                  <Td className="text-right">{fmtN(r.directDealerCount)}</Td>
                  <Td className="text-right">{fmtCr(r.targetPrimary)}</Td>
                  <Td className="text-right">
                    {data.meta.ordersAvailable ? fmtCr(r.orderBooking) : "—"}
                  </Td>
                  <Td>{r.oldNew}</Td>
                </tr>
              ))}
              {viewRows().length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No primary team members found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Data / Low Performers / Secondary views (same table structure) ── */}
      {!loading && data && activeView !== "summary" && activeView !== "primary" && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortTh label="State Head" sortKey="stateHead" sort={sort} onSort={toggleSort} />
                <Th label="State" />
                <Th label="Old/New" />
                <SortTh label="Target" sortKey="targetSecondary" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Order Booking" sortKey="orderBooking" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Prior Booking" sortKey="priorOrderBooking" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Ach%" sortKey="achievementPct" sort={sort} onSort={toggleSort} className="text-right" />
                <Th label="Band" />
                <SortTh label="Sale" sortKey="saleAmount" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Retailers" sortKey="totalRetailers" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="New Ret." sortKey="newRetailers" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Visits" sortKey="visitedParties" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Working Days" sortKey="workingDays" sort={sort} onSort={toggleSort} className="text-right" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {viewRows().map((r) => (
                <tr
                  key={r.normKey}
                  className={`hover:bg-muted/30 transition-colors ${
                    r.activeLeft !== "Active" ? "opacity-60" : ""
                  }`}
                >
                  <Td className="font-medium">
                    {r.name}
                    {r.activeLeft !== "Active" && (
                      <span className="ml-1 text-[10px] text-muted-foreground font-normal">(left)</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{r.stateHead}</Td>
                  <Td>{r.state}</Td>
                  <Td>{r.oldNew}</Td>
                  <Td className="text-right">{fmtCr(r.targetSecondary)}</Td>
                  <Td className="text-right">
                    {data.meta.ordersAvailable ? fmtCr(r.orderBooking) : "—"}
                  </Td>
                  <Td className="text-right">{fmtCr(r.priorOrderBooking)}</Td>
                  <Td className="text-right">
                    {data.meta.ordersAvailable ? fmtPct(r.achievementPct) : "—"}
                  </Td>
                  <Td>
                    <BandChip band={data.meta.ordersAvailable ? r.band : "noTarget"} />
                  </Td>
                  <Td className="text-right">{fmtCr(r.saleAmount)}</Td>
                  <Td className="text-right">{fmtN(r.totalRetailers)}</Td>
                  <Td className="text-right">{fmtN(r.newRetailers)}</Td>
                  <Td className="text-right">{fmtN(r.visitedParties)}</Td>
                  <Td className="text-right">{fmtN(r.workingDays)}</Td>
                </tr>
              ))}
              {viewRows().length === 0 && (
                <tr>
                  <td
                    colSpan={14}
                    className="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    {activeView === "lowPerf"
                      ? `No members below the ${lowPerfThreshold}% threshold.`
                      : "No data."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Row count footer */}
      {!loading && data && activeView !== "summary" && (
        <p className="text-xs text-muted-foreground text-right">
          {viewRows().length} of {filteredRows.length} members
        </p>
      )}
    </div>
  );
}
