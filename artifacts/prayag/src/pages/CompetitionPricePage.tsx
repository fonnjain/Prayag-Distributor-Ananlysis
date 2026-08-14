// CompetitionPricePage — browse the Sparsh Pearl competitor price snapshot and
// map their rows to our Prayag item codes.
//
// Snapshot is fetched daily from https://prayag-competition-analysis.replit.app.
// "net price" is DERIVED (MRP × 60%) — never a real street price. Every number
// carries its brand, fetch date, and the word "derived".
//
// Three states per code:
//   no-row    — no competitor row exists (competitor doesn't cover this product)
//   unmapped  — row exists but prayag_item_code not yet set
//   mapped    — row linked to a Prayag code; appears in the MRP Calculator

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL;
const API  = (p: string) => `${BASE}api/${p}`;

// ── Types ─────────────────────────────────────────────────────────────────

interface SnapshotInfo {
  rowCount: number; mappedCount: number;
  fetchedAt: string | null; refreshInFlight: boolean; lastError: string | null;
}
interface CompetitorRow {
  id: number;
  competitorBrand: string; competitorCode: string; competitorName: string | null;
  category: string;
  mrp: number | null; netPriceDerived: number | null; discountPctAssumed: number | null;
  fetchedAt: string;
  prayagItemCode: string | null; mappedBy: string | null; mappedAt: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function SnapshotBanner({ info }: { info: SnapshotInfo | undefined }) {
  if (!info) return null;
  const age = info.fetchedAt ? fmtDate(info.fetchedAt) : "never";
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-2 text-sm ${
      info.lastError ? "bg-amber-50 border-amber-200" : "bg-muted/40"
    }`}>
      <span className="flex-1">
        {info.lastError
          ? <><span className="font-medium text-amber-700">⚠ Fetch failed.</span> Last good snapshot: {age}</>
          : <>Competitor data from <strong>{age}</strong> · {info.rowCount} rows · {info.mappedCount} mapped</>
        }
      </span>
      {info.lastError && (
        <span className="text-xs text-amber-600 max-w-xs truncate" title={info.lastError}>
          {info.lastError}
        </span>
      )}
    </div>
  );
}

// ── Inline mapping form ────────────────────────────────────────────────────

function MapForm({ row, apiKey, onDone }: { row: CompetitorRow; apiKey: string; onDone: () => void }) {
  const [code, setCode] = useState(row.prayagItemCode ?? "");
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: async (prayagItemCode: string | null) => {
      const r = await fetch(API(`competitor-price/${row.id}/map`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ prayagItemCode }),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error ?? `HTTP ${r.status}`); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cp-rows"] });
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

const LS_KEY = "prayag_api_key";

export default function CompetitionPricePage() {
  const [apiKey] = useState<string>(() => {
    try { return localStorage.getItem(LS_KEY) ?? ""; } catch { return ""; }
  });
  const [categoryFilter, setCategoryFilter] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [mappingId, setMappingId] = useState<number | null>(null);

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

  const rows    = rowsQ.data?.rows ?? [];
  const cats    = [...new Set(rows.map((r) => r.category))].sort();
  const allCats = categoryFilter ? [...new Set(rowsQ.data?.rows.map((r) => r.category) ?? [])].sort() : cats;

  // category list from all rows (unfiltered) — refetch once without filter
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
        {!apiKey && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-1.5 border border-amber-200">
            No API key found. Go to Market Survey and enter your key — then return here to map rows.
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
                      <MapForm row={r} apiKey={apiKey} onDone={() => setMappingId(null)} />
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
                    {mappingId !== r.id && apiKey && (
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
