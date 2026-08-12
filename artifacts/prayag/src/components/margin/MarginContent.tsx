// Margin page — browse per-code BOM cost and realised-discount facts loaded
// from the GP MARGIN workbooks.
//
// discount_frac is a fraction (0.53 = 53% discount from MRP, not a percentage).
// bom_cost is factory BOM cost. Every figure derived from it is gross contribution
// only — no freight, overhead or SG&A is included.
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search, Loader2, ChevronLeft, ChevronRight, Info,
  TrendingDown, AlertTriangle, BarChart3, TrendingUp, X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types ──────────────────────────────────────────────────────────────────
interface MarginStats {
  totalRows: number;
  distinctFys: number;
  distinctCodes: number;
  negativeContributionCodes: number;
  rowsByFySegment: Record<string, { rows: number; months: number }>;
}

interface MarginRow {
  fy: string;
  month_label: string;
  segment: string;
  item_code: string;
  tab_name: string | null;
  qty: string | null;
  weight: string | null;
  mrp: string | null;
  discount_frac: string | null;
  avg_sale: string | null;
  bom_cost: string | null;
  sale_value: string | null;
  bom_value: string | null;
  source_file: string;
}

interface MarginListResponse {
  total: number;
  limit: number;
  offset: number;
  rows: MarginRow[];
}

interface SegmentSummary {
  segment: string;
  totalSaleValue: number;
  totalBomValue: number;
  gcPct: number | null;
  monthCount: number;
  negativeCodes: number;
}
function fmt(v: string | null | undefined, decimals = 2): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(v);
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: decimals });
}

function fmtRupee(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(v);
  if (!isFinite(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtPct(frac: string | null | undefined): string {
  if (frac == null || frac === "") return "—";
  const n = parseFloat(frac);
  if (!isFinite(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}

function fmtCr(val: number): string {
  const cr = val / 1e7;
  return "₹" + cr.toLocaleString("en-IN", { maximumFractionDigits: 2 }) + " Cr";
}
function grossContribPct(row: MarginRow): number | null {
  const sale = parseFloat(row.avg_sale ?? "");
  const bom  = parseFloat(row.bom_cost ?? "");
  if (!isFinite(sale) || !isFinite(bom) || sale === 0) return null;
  return ((sale - bom) / sale) * 100;
}

function contribColor(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct < 0)  return "text-red-600 font-semibold";
  if (pct < 10) return "text-amber-600";
  if (pct < 20) return "text-yellow-600";
  return "text-emerald-700";
}

const SEGMENT_COLORS: Record<string, string> = {
  "PTMT":                    "bg-blue-100 text-blue-800",
  "CP":                      "bg-amber-100 text-amber-800",
  "Garden Pipe":             "bg-green-100 text-green-800",
  "Sanitaryware":            "bg-purple-100 text-purple-800",
  "Hardware":                "bg-slate-100 text-slate-700",
  "Plumbing":                "bg-cyan-100 text-cyan-800",
  "Sink":                    "bg-rose-100 text-rose-800",
  "Waste Pipe & Connection": "bg-orange-100 text-orange-800",
};

const CHART_COLORS: Record<string, string> = {
  "PTMT":                    "#3b82f6",
  "CP":                      "#f59e0b",
  "Garden Pipe":             "#22c55e",
  "Sanitaryware":            "#a855f7",
  "Hardware":                "#64748b",
  "Plumbing":                "#06b6d4",
  "Sink":                    "#f43f5e",
  "Waste Pipe & Connection": "#f97316",
};
function SegBadge({ seg }: { seg: string }) {
  const cls = SEGMENT_COLORS[seg] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {seg}
    </span>
  );
}

const PAGE_SIZE = 100;
const ALL = "__ALL__";

function SegmentCards({
  summaries, activeSegment, onToggle,
}: {
  summaries: SegmentSummary[];
  activeSegment: string;
  onToggle: (seg: string) => void;
}) {
  return (
    <div className="px-6 pt-4 pb-2">
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
        Segment Summary
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {summaries.map((s) => {
          const active = activeSegment === s.segment;
          const gcColor =
            s.gcPct == null  ? "text-slate-400"
            : s.gcPct < 0    ? "text-red-600"
            : s.gcPct < 10   ? "text-amber-600"
            : s.gcPct < 20   ? "text-yellow-600"
            : "text-emerald-700";
          return (
            <button
              key={s.segment}
              onClick={() => onToggle(s.segment)}
              className={`text-left rounded-lg border p-3 transition-colors ${
                active
                  ? "border-blue-400 bg-blue-50 shadow-sm"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <SegBadge seg={s.segment} />
                {s.negativeCodes > 0 && (
                  <span className="flex items-center gap-0.5 text-red-500 text-[10px] font-medium">
                    <TrendingDown className="h-3 w-3" />
                    {s.negativeCodes}
                  </span>
                )}
              </div>
              <div className={`text-xl font-bold ${gcColor}`}>
                {s.gcPct != null ? s.gcPct.toFixed(1) + "%" : "—"}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">avg gross contrib</div>
              <div className="mt-2 text-xs text-slate-700 font-medium">{fmtCr(s.totalSaleValue)}</div>
              <div className="text-[10px] text-slate-400">{s.monthCount}m · total sale</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
function StatsHeader({ stats }: { stats: MarginStats }) {
  const fyKeys = Array.from(
    new Set(Object.keys(stats.rowsByFySegment).map((k) => k.split("|")[0])),
  ).sort();

  return (
    <div className="bg-white border-b px-6 py-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-emerald-600" />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">GP Margin</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              BOM cost &amp; realised discount — {fyKeys.join(", ")} · gross contribution only
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5 text-sm text-slate-600 flex-wrap">
          <span>
            <span className="font-semibold text-slate-900">
              {stats.totalRows.toLocaleString("en-IN")}
            </span>{" "}
            fact rows
          </span>
          <span>
            <span className="font-semibold text-slate-900">
              {stats.distinctCodes.toLocaleString("en-IN")}
            </span>{" "}
            distinct codes
          </span>
          {stats.negativeContributionCodes > 0 && (
            <span className="flex items-center gap-1 text-red-600 font-medium">
              <TrendingDown className="h-3.5 w-3.5" />
              {stats.negativeContributionCodes} negative-contribution codes
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function MarginContent() {
  const [fy,      setFy]      = useState(ALL);
  const [segment, setSegment] = useState(ALL);
  const [search,  setSearch]  = useState("");
  const [debSearch, setDebSearch] = useState("");
  const [offset,  setOffset]  = useState(0);

  useEffect(() => {
    const t = setTimeout(() => { setDebSearch(search); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setOffset(0); }, [fy, segment]);

  const { data: stats } = useQuery<MarginStats>({
    queryKey: ["margin-stats"],
    queryFn: () => fetch(`${BASE}/api/margin/stats`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const trendParams = new URLSearchParams();
  if (fy !== ALL) trendParams.set("fy", fy);

  const { data: trend } = useQuery<TrendResponse>({
    queryKey: ["margin-trend", fy],
    queryFn: () => fetch(`${BASE}/api/margin/trend?${trendParams}`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
    enabled: !!(stats && stats.totalRows > 0),
  });

  const params = new URLSearchParams();
  if (fy !== ALL)      params.set("fy",      fy);
  if (segment !== ALL) params.set("segment", segment);
  if (debSearch)       params.set("q",       debSearch);
  params.set("limit",  String(PAGE_SIZE));
  params.set("offset", String(offset));

  const { data: listData, isLoading, isFetching } = useQuery<MarginListResponse>({
    queryKey: ["margin-list", fy, segment, debSearch, offset],
    queryFn: () => fetch(`${BASE}/api/margin/list?${params}`).then((r) => r.json()),
    staleTime: 2 * 60 * 1000,
    enabled: !!(stats && stats.totalRows > 0),
  });

  // Derive filter options from stats
  const fyOptions = stats
    ? Array.from(new Set(Object.keys(stats.rowsByFySegment).map((k) => k.split("|")[0]))).sort()
    : [];
  const segOptions = stats
    ? Array.from(new Set(Object.keys(stats.rowsByFySegment).map((k) => k.split("|")[1]))).sort()
    : [];

  // Active segment for segment-pill click (maps to table filter)
  const handleSegmentToggle = (seg: string) => {
    setSegment((prev) => (prev === seg ? ALL : seg));
    setOffset(0);
  };

  const isEmpty = stats && stats.totalRows === 0;
  const totalPages = Math.ceil((listData?.total ?? 0) / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // Build the chart's month labels (deduplicate across FYs when all FYs shown)
  const chartData = trend?.monthlyTrend ?? [];
  const chartSegments = trend
    ? Array.from(
        new Set(trend.segmentSummary.map((s) => s.segment))
      ).sort()
    : [];

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-auto">
      {/* Stats header */}
      {stats && <StatsHeader stats={stats} />}

      {/* Disclaimer banner */}
      <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-start gap-2 text-xs text-amber-800 shrink-0">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
        <span>
          <span className="font-medium">Gross contribution only.</span>{" "}
          bom_cost is factory BOM cost; discount_frac is a fraction of MRP (0.53 = 53% off).
          No freight, overhead or SG&amp;A is included.
          The "Gross Contrib %" column = (avg_sale − bom_cost) / avg_sale — not net profit.
        </span>
      </div>

      {/* Not yet loaded */}
      {isEmpty && (
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md w-full mx-4">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Info className="h-4 w-4 text-blue-500" />
                GP Margin data not loaded yet
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-600 space-y-2">
              <p>Trigger a load from Google Drive with:</p>
                <pre className="bg-slate-100 rounded p-3 text-xs overflow-auto">
{`# Step 1 — kick off (returns 202 immediately)
curl -s -X POST \\
  -H "X-Admin-Secret: <SESSION_SECRET>" \\
  <BASE_URL>/api/admin/margin/load | jq .

# Step 2 — poll until status = "done"
curl -s \\
  -H "X-Admin-Secret: <SESSION_SECRET>" \\
  <BASE_URL>/api/admin/margin/load-status | jq .status`}
              </pre>
              <p className="text-xs text-slate-500">
                Downloads 177+ GP MARGIN files from Google Drive (~15 min).
                Returns 202 immediately — all rows become visible after the load
                finishes and the transaction commits. Refresh this page once the
                load-status endpoint reports <code className="font-mono">done</code>.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Analytics section — segment cards + trend chart */}
      {!isEmpty && trend && (
        <>
          {/* FY filter for analytics */}
          <div className="px-6 pt-4 pb-0 flex items-center gap-3">
            <TrendingUp className="h-4 w-4 text-slate-400" />
            <span className="text-xs text-slate-500">Analytics view:</span>
            <Select value={fy} onValueChange={(v) => { setFy(v); setOffset(0); }}>
              <SelectTrigger className="w-[130px] h-7 text-xs">
                <SelectValue placeholder="All FYs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All FYs</SelectItem>
                {fyOptions.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
              </SelectContent>
            </Select>
            {segment !== ALL && (
              <button
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                onClick={() => setSegment(ALL)}
              >
                <X className="h-3 w-3" /> Clear segment filter
              </button>
            )}
          </div>

          <SegmentCards
            summaries={trend.segmentSummary}
            activeSegment={segment}
            onToggle={handleSegmentToggle}
          />

          {chartData.length > 0 && (
            <TrendChart
              data={chartData}
              segments={chartSegments}
              activeSegment={segment}
            />
          )}

          <NegativeCodesAlert
            codes={trend.negativeCodes}
            activeSegment={segment}
          />
        </>
      )}

      {/* Table section */}
      {!isEmpty && (
        <>
          {/* Filters */}
          <div className="bg-white border-y px-6 py-3 flex items-center gap-3 flex-wrap shrink-0">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mr-1">
              Detail Table
            </div>
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search code…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-8 text-sm"
              />
            </div>

            <Select value={fy} onValueChange={(v) => { setFy(v); setOffset(0); }}>
              <SelectTrigger className="w-[130px] h-8 text-sm">
                <SelectValue placeholder="All FYs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All FYs</SelectItem>
                {fyOptions.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={segment} onValueChange={(v) => { setSegment(v); setOffset(0); }}>
              <SelectTrigger className="w-[190px] h-8 text-sm">
                <SelectValue placeholder="All segments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All segments</SelectItem>
                {segOptions.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>

            {isFetching && !isLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            )}

            {listData && (
              <span className="text-xs text-slate-500 ml-auto">
                {listData.total.toLocaleString("en-IN")} rows
              </span>
            )}
          </div>

          <div className="px-6 py-4">
            <div className="bg-white rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50 text-xs">
                    <TableHead className="w-[80px]">FY</TableHead>
                    <TableHead className="w-[70px]">Month</TableHead>
                    <TableHead className="w-[140px]">Segment</TableHead>
                    <TableHead className="w-[110px]">Code</TableHead>
                    <TableHead className="w-[70px] text-right">Qty</TableHead>
                    <TableHead className="w-[85px] text-right">MRP</TableHead>
                    <TableHead className="w-[80px] text-right" title="Discount fraction from MRP">Disc Frac</TableHead>
                    <TableHead className="w-[90px] text-right">Avg Sale</TableHead>
                    <TableHead className="w-[90px] text-right" title="Factory BOM / purchase cost">BOM Cost</TableHead>
                    <TableHead className="w-[100px] text-right" title="(avg_sale - bom_cost) / avg_sale — gross contribution only">Gross Contrib %</TableHead>
                    <TableHead className="w-[100px] text-right">Sale Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading &&
                    Array.from({ length: 8 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 11 }).map((_, j) => (
                          <TableCell key={j}>
                            <div className="h-4 bg-slate-100 rounded animate-pulse" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}

                  {!isLoading && listData?.rows.map((row, i) => {
                    const contrib = grossContribPct(row);
                    return (
                      <TableRow
                        key={`${row.fy}|${row.month_label}|${row.segment}|${row.item_code}|${i}`}
                        className="hover:bg-slate-50"
                      >
                        <TableCell className="text-xs text-slate-500">{row.fy}</TableCell>
                        <TableCell className="text-xs font-mono text-slate-600">{row.month_label}</TableCell>
                        <TableCell>
                          <button
                            className="text-left"
                            onClick={() => handleSegmentToggle(row.segment)}
                          >
                            <SegBadge seg={row.segment} />
                          </button>
                          {row.tab_name && row.tab_name !== row.segment && (
                            <span className="ml-1 text-[10px] text-slate-400">{row.tab_name}</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium text-slate-800">
                          {row.item_code}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-600">
                          {fmt(row.qty, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-600">
                          {fmtRupee(row.mrp)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-600">
                          {fmtPct(row.discount_frac)}
                          <span className="text-[10px] text-slate-400 ml-0.5">(frac)</span>
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-700 font-medium">
                          {fmtRupee(row.avg_sale)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-700">
                          {fmtRupee(row.bom_cost)}
                        </TableCell>
                        <TableCell className={`text-right text-xs ${contribColor(contrib)}`}>
                          {contrib != null ? contrib.toFixed(1) + "%" : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-600">
                          {fmtRupee(row.sale_value)}
                        </TableCell>
                      </TableRow>
                    );
                  })}

                  {!isLoading && listData?.rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-slate-400 py-12">
                        No rows match the current filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {listData && listData.total > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-4 text-sm text-slate-600">
                <span>
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, listData.total)} of{" "}
                  {listData.total.toLocaleString("en-IN")}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                  >
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <span className="text-xs text-slate-500">Page {currentPage} of {totalPages}</span>
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={offset + PAGE_SIZE >= listData.total}
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TrendChart({
  data, segments, activeSegment,
}: {
  data: Array<Record<string, number | string | null>>;
  segments: string[];
  activeSegment: string;
}) {
  const visibleSegs = activeSegment === ALL ? segments : [activeSegment];

  // Custom tooltip
  const CustomTooltip = ({
    active, payload, label,
  }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs min-w-[160px]">
        <div className="font-semibold text-slate-700 mb-2">{label}</div>
        {payload.map((p) => (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color }} />
              <span className="text-slate-600">{p.name}</span>
            </span>
            <span className="font-semibold text-slate-800">
              {p.value != null ? p.value.toFixed(1) + "%" : "—"}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="px-6 pb-4">
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
        Monthly Gross Contribution % Trend
        {activeSegment !== ALL && (
          <span className="ml-2 normal-case text-blue-600">· {activeSegment}</span>
        )}
      </h2>
      <div className="bg-white rounded-lg border p-4">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              tickLine={false}
              axisLine={{ stroke: "#e2e8f0" }}
            />
            <YAxis
              tickFormatter={(v: number) => v.toFixed(0) + "%"}
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip content={<CustomTooltip />} />
            {visibleSegs.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
            )}
            {visibleSegs.map((seg, idx) => (
              <Line
                key={seg}
                type="monotone"
                dataKey={seg}
                name={seg}
                stroke={chartColor(seg, idx)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function chartColor(seg: string, idx: number): string {
  return CHART_COLORS[seg] ?? ["#6366f1","#14b8a6","#ec4899","#84cc16"][idx % 4];
}

interface TrendResponse {
  monthlyTrend: Array<Record<string, number | string | null>>;
  segmentSummary: SegmentSummary[];
  negativeCodes: NegativeCode[];
}

function NegativeCodesAlert({
  codes, activeSegment,
}: {
  codes: NegativeCode[];
  activeSegment: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const filtered = activeSegment === ALL ? codes : codes.filter((c) => c.segment === activeSegment);
  if (filtered.length === 0) return null;
  const shown = expanded ? filtered : filtered.slice(0, 8);

  return (
    <div className="mx-6 mb-4 rounded-lg border border-red-200 bg-red-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-red-100">
        <div className="flex items-center gap-2 text-red-700">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <span className="text-sm font-semibold">
            {filtered.length} codes with negative gross contribution
          </span>
          <span className="text-xs text-red-500">
            (bom_cost &gt; avg_sale)
          </span>
        </div>
        <button
          className="text-xs text-red-600 hover:text-red-800 font-medium"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show less" : `Show all ${filtered.length}`}
        </button>
      </div>
      <div className="px-4 py-3 flex flex-wrap gap-2">
        {shown.map((c) => (
          <div
            key={`${c.segment}|${c.itemCode}`}
            className="inline-flex items-center gap-1.5 rounded border border-red-200 bg-white px-2 py-1 text-xs"
          >
            <span className="font-mono font-semibold text-slate-800">{c.itemCode}</span>
            <SegBadge seg={c.segment} />
            <span className="text-red-600 font-semibold">
              {c.gcPct != null ? c.gcPct.toFixed(1) + "%" : "neg"}
            </span>
            <span className="text-slate-400 text-[10px]">{fmtCr(c.totalSaleValue)}</span>
          </div>
        ))}
        {!expanded && filtered.length > 8 && (
          <button
            className="text-xs text-red-600 hover:text-red-800 font-medium self-center"
            onClick={() => setExpanded(true)}
          >
            +{filtered.length - 8} more…
          </button>
        )}
      </div>
    </div>
  );
}

interface NegativeCode {
  itemCode: string;
  segment: string;
  totalSaleValue: number;
  gcPct: number | null;
}
