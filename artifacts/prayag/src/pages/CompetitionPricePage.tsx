// CompetitionPricePage.tsx
// Mapping a competitor row to a Prayag item code is an ordinary in-app action.
// No credential required — mapper identity is self-declared (stored in localStorage
// under "prayag_ms_recorder", same key as the Market Survey recorder name).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API  = (path: string) => `${BASE}/api/${path}`;

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return s; }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface CompetitorRow {
  id:                 number;
  competitorBrand:    string;
  competitorCode:     string;
  competitorName:     string | null;
  category:           string;
  mrp:                number | null;
  netPriceDerived:    number | null;
  discountPctAssumed: number | null;
  fetchedAt:          string;
  prayagItemCode:     string | null;
  mappedBy:           string | null;
  mappedAt:           string | null;
}

interface SnapshotInfo {
  rowCount:        number;
  mappedCount:     number;
  fetchedAt:       string | null;
  refreshInFlight: boolean;
  lastError:       string | null;
}

// ── Snapshot banner ────────────────────────────────────────────────────────

function SnapshotBanner({ info }: { info: SnapshotInfo | undefined }) {
  if (!info) return null;

  const unmapped = info.rowCount - info.mappedCount;
  const ageDays  = info.fetchedAt
    ? Math.floor((Date.now() - new Date(info.fetchedAt).getTime()) / 86_400_000)
    : null;
  const stale    = ageDays != null && ageDays > 2;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {info.lastError && (
        <span className="text-destructive font-medium">
          Last fetch failed — {info.lastError.slice(0, 120)}
        </span>
      )}
      {stale && !info.lastError && (
        <span className="text-amber-700">
          Snapshot is {ageDays} day{ageDays !== 1 ? "s" : ""} old
        </span>
      )}
      {info.fetchedAt && (
        <span>Fetched {fmtDate(info.fetchedAt)}</span>
      )}
      {info.rowCount > 0 && (
        <span>
          {unmapped} of {info.rowCount} row{info.rowCount !== 1 ? "s" : ""} unmapped
        </span>
      )}
      {info.refreshInFlight && <span className="text-blue-600">Refresh in progress…</span>}
    </div>
  );
}

// ── Inline mapping form ────────────────────────────────────────────────────

const LS_RECORDER = "prayag_ms_recorder";

function MapForm({ row, mappedBy, onDone }: { row: CompetitorRow; mappedBy: string; onDone: () => void }) {
  const [code, setCode] = useState(row.prayagItemCode ?? "");
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: async (prayagItemCode: string | null) => {
      const r = await fetch(API(`competitor-price/${row.id}/map`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prayagItemCode, mappedBy: mappedBy || "(anonymous)" }),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error ?? `HTTP ${r.status}`); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cp-rows"] });
      qc.invalidateQueries({ queryKey: ["cp-rows-all"] });
      qc.invalidateQueries({ queryKey: ["cp-info"] });
      onDone();
    },
  });

  return (
    <div className="flex items-center gap-2 mt-1">
      <input
        className="rounded border px-2 py-1 text-xs font-mono w-32 focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="e.g. 145-B"
        value={code}
        onChange={(e) => setCode(e.target.value.trim())}
        autoFocus
      />
      <button
        className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={mut.isPending}
        onClick={() => mut.mutate(code || null)}
      >
        {mut.isPending ? "…" : "Save"}
      </button>
      {row.prayagItemCode && (
        <button
          className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          disabled={mut.isPending}
          onClick={() => mut.mutate(null)}
        >
          Remove
        </button>
      )}
      <button className="text-xs text-muted-foreground underline" onClick={onDone}>cancel</button>
      {mut.error && <span className="text-xs text-destructive">{String(mut.error)}</span>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function CompetitionPricePage() {
  // Self-declared recorder name — shared with Market Survey (same localStorage key).
  const mappedBy = (() => {
    try { return localStorage.getItem(LS_RECORDER) ?? ""; } catch { return ""; }
  })();

  const [categoryFilter, setCategoryFilter] = useState("");
  const [searchQ,        setSearchQ       ] = useState("");
  const [mappingId,      setMappingId     ] = useState<number | null>(null);

  const { data: info } = useQuery<SnapshotInfo>({
    queryKey: ["cp-info"],
    queryFn: () => fetch(API("competitor-price/snapshot-info")).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const rowsQ = useQuery<{ rows: CompetitorRow[]; snapshotFetchedAt: string | null; lastError: string | null }>({
    queryKey: ["cp-rows", categoryFilter, searchQ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (categoryFilter) params.set("category", categoryFilter);
      if (searchQ)        params.set("q", searchQ);
      return fetch(`${API("competitor-price")}?${params}`).then((r) => r.json());
    },
  });

  const rows = rowsQ.data?.rows ?? [];

  // Category list from all rows (unfiltered)
  const allRowsQ = useQuery<{ rows: CompetitorRow[] }>({
    queryKey: ["cp-rows-all"],
    queryFn: () => fetch(API("competitor-price")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  const allCategories = [...new Set((allRowsQ.data?.rows ?? []).map((r) => r.category))].sort();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b px-6 py-4 space-y-2 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Competition Prices</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Sparsh Pearl catalogue from the Prayag Competition Analysis app.
              Net prices are <span className="font-medium">derived</span> (MRP × 60%) — not observed street prices.
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground shrink-0">
            <div>{info?.rowCount ?? "—"} rows</div>
            <div>{info?.mappedCount ?? "—"} mapped</div>
            <div>{(info?.rowCount ?? 0) - (info?.mappedCount ?? 0)} unmapped</div>
          </div>
        </div>
        <SnapshotBanner info={info} />
        {mappedBy && (
          <p className="text-xs text-muted-foreground">
            Mapping as <span className="font-medium">{mappedBy}</span>{" "}
            <span className="text-muted-foreground/60">(self-declared — set in Market Survey)</span>
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="border-b px-6 py-2 flex items-center gap-3 shrink-0">
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          className="rounded border bg-background px-2 py-1 text-sm w-56"
          placeholder="Search description…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
        />
        <span className="text-xs text-muted-foreground ml-auto">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {rowsQ.isPending ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {info?.rowCount === 0
              ? "No data yet — the daily fetch hasn't run. Check back in a few minutes."
              : "No rows match the current filter."}
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background border-b z-10">
              <tr className="text-muted-foreground">
                <th className="px-4 py-2 text-left">Category</th>
                <th className="px-4 py-2 text-left">Description</th>
                <th className="px-4 py-2 text-right">Their MRP</th>
                <th className="px-4 py-2 text-right">Derived net <span className="font-normal">(−40%)</span></th>
                <th className="px-4 py-2 text-left">Mapped to</th>
                <th className="px-4 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className={`hover:bg-muted/30 ${r.prayagItemCode ? "bg-green-50/40" : ""}`}>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{r.category}</td>
                  <td className="px-4 py-2">
                    <span className="font-medium">{r.competitorName}</span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {r.mrp != null ? `₹${r.mrp.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.netPriceDerived != null ? (
                      <span className="font-mono">
                        ₹{r.netPriceDerived.toFixed(2)}
                        <span className="ml-1 text-muted-foreground text-[10px]">derived</span>
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {mappingId === r.id ? (
                      <MapForm row={r} mappedBy={mappedBy} onDone={() => setMappingId(null)} />
                    ) : r.prayagItemCode ? (
                      <div>
                        <span className="font-mono font-medium text-green-700">{r.prayagItemCode}</span>
                        {r.mappedBy && (
                          <span className="ml-1 text-muted-foreground text-[10px]">by {r.mappedBy}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">unmapped</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {mappingId !== r.id && (
                      <button
                        className="text-xs text-primary underline"
                        onClick={() => setMappingId(r.id)}
                      >
                        {r.prayagItemCode ? "edit" : "map"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer note */}
      <div className="border-t px-6 py-2 text-xs text-muted-foreground shrink-0">
        Snapshot date: {fmtDate(rowsQ.data?.snapshotFetchedAt ?? null)} ·
        Source: Prayag Competition Analysis app (Sparsh Pearl catalogue only) ·
        Net prices derived at {rows[0]?.discountPctAssumed ?? 40}% off MRP — not observed.
        Do not feed these into the MRP calculator or pricing recommendations without separate review.
      </div>
    </div>
  );
}
