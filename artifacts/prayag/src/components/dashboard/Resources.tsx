// Coverage — retailer roster reach, filterable by State Head / State with an
// Excel export. Coverage is a roster stock (no month or distributor
// dimension), so the filter bar shows the head and state levels only.
import { useState, useEffect, useMemo } from "react";
import { KPICard } from "./shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Map, MapPin, Building2, Store, Download } from "lucide-react";
import { DEFAULT_FY } from "@/data/global-filter-context";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  hasEntityFilter,
  type EntityFilterValue,
} from "./CompanyReportFilters";

type HeadResource = {
  head: string;
  distributors: number;
  dealers: number;
  total: number;
  states: string;
};

type CoverageRow = { state: string; districts: number; cities: number; retailers: number };

type Payload = {
  filtered: boolean;
  /** State filter active → per-head counts cover the head's full territory. */
  headsFullTerritory: boolean;
  syncedAt: string;
  coverageTotals: { states: number; districts: number; cities: number; retailers: number };
  headsResources: HeadResource[];
  coverage: CoverageRow[];
};

export default function Resources() {
  // Coverage is a current roster snapshot with no FY dimension, so the page
  // is declared NONE in period-capability (no FY selector) and the filter
  // tree is pinned to DEFAULT_FY — options and data share the same basis.
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);

  // Head/state filters only — coverage has no distributor or month dimension.
  const filterQuery = useMemo(() => {
    const parts: string[] = [];
    if (entityFilter.heads.length > 0) parts.push(`heads=${encodeURIComponent(JSON.stringify(entityFilter.heads))}`);
    if (entityFilter.states.length > 0) parts.push(`states=${encodeURIComponent(JSON.stringify(entityFilter.states))}`);
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }, [entityFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/coverage-reports${filterQuery}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<Payload>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filterQuery]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Filters + export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CompanyReportFilterBar
          fy={DEFAULT_FY}
          value={entityFilter}
          onChange={setEntityFilter}
          showCustomers={false}
        />
        <a
          href={`/api/coverage-reports/export${filterQuery}`}
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-coverage"
        >
          <Download className="h-3.5 w-3.5" />
          Export Excel
        </a>
      </div>
      {hasEntityFilter(entityFilter) && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Filters active — counts below are a subset and will not match the unfiltered totals.
        </p>
      )}

      {loading && !data && <div className="py-12 text-center text-sm text-muted-foreground">Loading coverage...</div>}
      {error && <div className="py-6 text-center text-sm text-destructive">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard title="States" value={data.coverageTotals.states} icon={<Map className="w-5 h-5" />} />
            <KPICard title="Districts" value={data.coverageTotals.districts} icon={<MapPin className="w-5 h-5" />} />
            <KPICard title="Cities" value={data.coverageTotals.cities} icon={<Building2 className="w-5 h-5" />} />
            <KPICard title="Retailers" value={data.coverageTotals.retailers.toLocaleString()} icon={<Store className="w-5 h-5" />} />
          </div>

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">Resource Coverage by Head</CardTitle>
              {data.headsFullTerritory && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 font-normal">
                  Heads covering the selected states — distributor/dealer counts cover each head's full territory (no per-state split exists).
                </p>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 text-left font-medium">Head</th>
                      <th className="px-5 py-3 text-right font-medium">Distributors</th>
                      <th className="px-5 py-3 text-right font-medium">Dealers</th>
                      <th className="px-5 py-3 text-right font-medium">Total</th>
                      <th className="px-5 py-3 text-left font-medium">States Covered</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.headsResources.map((head, i) => (
                      <tr key={i} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 font-medium whitespace-nowrap">{head.head}</td>
                        <td className="px-5 py-3 text-right">{head.distributors}</td>
                        <td className="px-5 py-3 text-right">{head.dealers}</td>
                        <td className="px-5 py-3 text-right font-semibold">{head.total}</td>
                        <td className="px-5 py-3 text-muted-foreground max-w-md truncate" title={head.states}>{head.states}</td>
                      </tr>
                    ))}
                    {data.headsResources.length === 0 && (
                      <tr><td colSpan={5} className="px-5 py-6 text-center text-xs text-muted-foreground">No heads match this selection.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">State-wise Penetration</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto h-[400px]">
                <table className="w-full text-sm relative">
                  <thead className="bg-muted/50 text-muted-foreground sticky top-0 backdrop-blur-md">
                    <tr>
                      <th className="px-5 py-3 text-left font-medium">State</th>
                      <th className="px-5 py-3 text-right font-medium">Districts</th>
                      <th className="px-5 py-3 text-right font-medium">Cities</th>
                      <th className="px-5 py-3 text-right font-medium">Retailers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {[...data.coverage].sort((a, b) => b.cities - a.cities).map((cov, i) => (
                      <tr key={i} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 font-medium">{cov.state}</td>
                        <td className="px-5 py-3 text-right">{cov.districts}</td>
                        <td className="px-5 py-3 text-right">{cov.cities}</td>
                        <td className="px-5 py-3 text-right">{cov.retailers.toLocaleString()}</td>
                      </tr>
                    ))}
                    {data.coverage.length === 0 && (
                      <tr><td colSpan={4} className="px-5 py-6 text-center text-xs text-muted-foreground">No states match this selection.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
