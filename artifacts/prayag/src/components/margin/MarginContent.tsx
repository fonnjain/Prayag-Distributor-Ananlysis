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
  TrendingDown, AlertTriangle, BarChart3,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

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

// ── Helpers ────────────────────────────────────────────────────────────────
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

// Gross contribution % = (avg_sale - bom_cost) / avg_sale
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

// ── Stats header ───────────────────────────────────────────────────────────
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

      {/* FY × Segment summary pills */}
      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(stats.rowsByFySegment).map(([key, v]) => {
          const [fy, seg] = key.split("|");
          return (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] text-slate-600"
            >
              <span className="font-medium text-slate-800">{fy}</span>
              <SegBadge seg={seg} />
              <span className="text-slate-500">
                {v.rows.toLocaleString("en-IN")} rows · {v.months}m
              </span>
            </span>
          );
        })}
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
  });

  // Derive filter options from stats
  const fyOptions = stats
    ? Array.from(new Set(Object.keys(stats.rowsByFySegment).map((k) => k.split("|")[0]))).sort()
    : [];
  const segOptions = stats
    ? Array.from(new Set(Object.keys(stats.rowsByFySegment).map((k) => k.split("|")[1]))).sort()
    : [];

  const isEmpty = stats && stats.totalRows === 0;
  const totalPages = Math.ceil((listData?.total ?? 0) / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Stats header */}
      {stats && <StatsHeader stats={stats} />}

      {/* Disclaimer banner */}
      <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-start gap-2 text-xs text-amber-800">
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
{`curl -s -X POST \\
  -H "X-Admin-Secret: <SESSION_SECRET>" \\
  <BASE_URL>/api/admin/margin/load | jq .`}
              </pre>
              <p className="text-xs text-slate-500">
                Reads 133 GP MARGIN workbooks (FY2025-26 + FY2026-27) from Drive,
                classifies monthly vs cumulative, validates cross-totals, and populates
                margin_fact.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      {!isEmpty && (
        <div className="bg-white border-b px-6 py-3 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={fy} onValueChange={(v) => { setFy(v); setOffset(0); }}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="All FYs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All FYs</SelectItem>
              {fyOptions.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={segment} onValueChange={(v) => { setSegment(v); setOffset(0); }}>
            <SelectTrigger className="w-[190px]">
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
      )}

      {/* Table */}
      {!isEmpty && (
        <div className="flex-1 overflow-auto px-6 py-4">
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
                        <SegBadge seg={row.segment} />
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
      )}
    </div>
  );
}
