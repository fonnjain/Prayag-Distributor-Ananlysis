// MRP Master page — browse effective-dated prices by segment and series.
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { IndianRupee, Search, ChevronLeft, ChevronRight, History, X, Info, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types ──────────────────────────────────────────────────────────────────
interface MrpRow {
  itemCode: string;
  itemName: string | null;
  segment: string;
  series: string | null;
  packing: string | null;
  currentMrp: number | null;
  effectiveFrom: string | null;
  historyCount: number;
}

interface MrpListResponse {
  total: number;
  limit: number;
  offset: number;
  rows: MrpRow[];
}

interface MrpMeta {
  segments: string[];
  seriesBySegment: Record<string, string[]>;
  totalCodes: number;
  codesWithRevision: number;
}

interface HistoryEntry {
  id: number;
  mrp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceFile: string;
  isCurrent: boolean;
}

interface HistoryResponse {
  itemCode: string;
  itemName: string | null;
  segment: string;
  series: string | null;
  packing: string | null;
  history: HistoryEntry[];
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function isUnknownOrigin(d: string): boolean {
  return d === "1970-01-01";
}

const SEGMENT_COLORS: Record<string, string> = {
  "PTMT": "bg-blue-100 text-blue-800",
  "CP": "bg-amber-100 text-amber-800",
  "Pipe & Fitting": "bg-green-100 text-green-800",
  "Sanitaryware": "bg-purple-100 text-purple-800",
  "Hardware": "bg-slate-100 text-slate-700",
  "QUAA & FERN": "bg-rose-100 text-rose-800",
};

function SegmentBadge({ segment }: { segment: string }) {
  const cls = SEGMENT_COLORS[segment] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {segment}
    </span>
  );
}

// ── History panel ──────────────────────────────────────────────────────────
function HistoryPanel({
  code,
  onClose,
}: {
  code: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery<HistoryResponse>({
    queryKey: ["mrp-history", code],
    queryFn: () => fetch(`${BASE}/api/mrp/${encodeURIComponent(code)}/history`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-md bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-slate-500" />
            <span className="font-semibold text-slate-800">Price History</span>
            {data && (
              <SegmentBadge segment={data.segment} />
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-slate-100 text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Item info */}
        {data && (
          <div className="border-b bg-slate-50 px-4 py-3">
            <p className="text-sm font-mono font-medium text-slate-700">{data.itemCode}</p>
            <p className="text-sm text-slate-600 mt-0.5">{data.itemName ?? "—"}</p>
            {data.series && (
              <p className="text-xs text-slate-500 mt-0.5">{data.series}{data.packing ? ` · ${data.packing}` : ""}</p>
            )}
          </div>
        )}

        {/* History entries */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600">Failed to load history.</p>
          )}
          {data?.history.map((h, i) => (
            <div
              key={h.id}
              className={`rounded-lg border px-4 py-3 ${
                h.isCurrent
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-base font-semibold ${
                    h.isCurrent ? "text-emerald-700" : "text-slate-600"
                  }`}
                >
                  {fmt(h.mrp)}
                </span>
                {h.isCurrent && (
                  <span className="rounded-full bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 font-medium">
                    Current
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1 space-y-0.5">
                <p>
                  From:{" "}
                  {isUnknownOrigin(h.effectiveFrom) ? (
                    <span className="italic text-slate-400">origin</span>
                  ) : (
                    fmtDate(h.effectiveFrom)
                  )}
                </p>
                {h.effectiveTo && (
                  <p>Until: {fmtDate(h.effectiveTo)}</p>
                )}
              </div>
              {data.history.length > 1 && i < data.history.length - 1 && !h.isCurrent && (
                <p className="text-xs text-slate-400 mt-1">
                  Δ{" "}
                  {data.history[i + 1]
                    ? (
                        ((data.history[i + 1].mrp - h.mrp) / h.mrp) * 100
                      ).toFixed(1) + "%"
                    : ""}
                </p>
              )}
            </div>
          ))}
          {data?.history.length === 0 && (
            <p className="text-sm text-slate-500">No history entries.</p>
          )}
        </div>

        {/* Source file footer */}
        {data?.history[0] && (
          <div className="border-t px-4 py-2">
            <p className="text-xs text-slate-400 truncate">
              Source: {data.history[0].sourceFile}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
const PAGE_SIZE = 50;
const ALL = "__ALL__";

export default function MrpContent() {
  const [segment, setSegment] = useState<string>(ALL);
  const [series, setSeries] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [historyCode, setHistoryCode] = useState<string | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset series when segment changes
  useEffect(() => {
    setSeries(ALL);
    setOffset(0);
  }, [segment]);

  // Meta (segments + series)
  const { data: meta } = useQuery<MrpMeta>({
    queryKey: ["mrp-meta"],
    queryFn: () => fetch(`${BASE}/api/mrp/meta`).then((r) => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  // List
  const params = new URLSearchParams();
  if (segment !== ALL) params.set("segment", segment);
  if (series !== ALL) params.set("series", series);
  if (debouncedSearch) params.set("q", debouncedSearch);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const { data: listData, isLoading, isFetching } = useQuery<MrpListResponse>({
    queryKey: ["mrp-list", segment, series, debouncedSearch, offset],
    queryFn: () =>
      fetch(`${BASE}/api/mrp?${params}`).then((r) => r.json()),
    staleTime: 2 * 60 * 1000,
  });

  const seriesOptions =
    segment !== ALL && meta?.seriesBySegment[segment]
      ? meta.seriesBySegment[segment]
      : [];

  const totalPages = Math.ceil((listData?.total ?? 0) / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const isEmpty = meta && meta.totalCodes === 0;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IndianRupee className="h-5 w-5 text-emerald-600" />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">MRP Master</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Effective-dated price catalogue — 6 segments
            </p>
          </div>
        </div>
        {meta && (
          <div className="flex items-center gap-4 text-sm text-slate-600">
            <span>
              <span className="font-semibold text-slate-900">{meta.totalCodes.toLocaleString("en-IN")}</span>{" "}
              codes
            </span>
            <span>
              <span className="font-semibold text-slate-900">{meta.codesWithRevision.toLocaleString("en-IN")}</span>{" "}
              with revision
            </span>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-b px-6 py-3 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={segment} onValueChange={(v) => { setSegment(v); setOffset(0); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All segments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All segments</SelectItem>
            {(meta?.segments ?? []).map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={series}
          onValueChange={(v) => { setSeries(v); setOffset(0); }}
          disabled={seriesOptions.length === 0}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All series" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All series</SelectItem>
            {seriesOptions.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isFetching && !isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        )}
      </div>

      {/* Empty state — not yet loaded */}
      {isEmpty && (
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md w-full mx-4">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Info className="h-4 w-4 text-blue-500" />
                MRP data not loaded yet
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-600 space-y-2">
              <p>
                The MRP tables are empty. Trigger a load with:
              </p>
              <pre className="bg-slate-100 rounded p-3 text-xs overflow-auto">
{`curl -s -X POST \\
  -H "X-Admin-Secret: <SESSION_SECRET>" \\
  <BASE_URL>/api/admin/mrp/load | jq .`}
              </pre>
              <p className="text-xs text-slate-500">
                This reads the 6 workbooks and populates mrp_master + mrp_history (~5 500 codes).
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Table */}
      {!isEmpty && (
        <div className="flex-1 overflow-auto px-6 py-4">
          <div className="bg-white rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="w-[140px]">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[140px]">Segment</TableHead>
                  <TableHead className="w-[160px]">Series</TableHead>
                  <TableHead className="w-[110px] text-right">Current MRP</TableHead>
                  <TableHead className="w-[130px]">Effective From</TableHead>
                  <TableHead className="w-[80px] text-center">Revisions</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 8 }).map((_, j) => (
                        <TableCell key={j}>
                          <div className="h-4 bg-slate-100 rounded animate-pulse" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {!isLoading && listData?.rows.map((row) => (
                  <TableRow
                    key={row.itemCode}
                    className="hover:bg-slate-50 cursor-pointer"
                    onClick={() => setHistoryCode(row.itemCode)}
                  >
                    <TableCell>
                      <span className="font-mono text-xs font-medium text-slate-700">
                        {row.itemCode}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-slate-600 line-clamp-2">
                        {row.itemName ?? <span className="italic text-slate-400">—</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <SegmentBadge segment={row.segment} />
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-slate-600">{row.series ?? "—"}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-semibold text-slate-800">
                        {fmt(row.currentMrp)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-slate-500">
                        {fmtDate(row.effectiveFrom)}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      {row.historyCount > 1 ? (
                        <Badge variant="outline" className="text-xs">
                          {row.historyCount}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">1</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistoryCode(row.itemCode);
                        }}
                        className="rounded p-1 hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                        title="View price history"
                      >
                        <History className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
                {!isLoading && listData?.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-slate-400 py-12">
                      No items match the current filters.
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
                {listData.total.toLocaleString("en-IN")} items
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <span className="text-xs text-slate-500">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= listData.total}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* History panel */}
      {historyCode && (
        <HistoryPanel code={historyCode} onClose={() => setHistoryCode(null)} />
      )}
    </div>
  );
}
