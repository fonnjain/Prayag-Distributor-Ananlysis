// Editable state-head monthly target grid for the Data Sources tab.
// Reads from GET /api/primary-state-targets/by-head and writes via
// PUT /api/primary-state-targets/by-head.  Values are in Lakh rupees.
// This is the canonical editable source for primary state-head targets;
// the Primary Performance > State Targets tab reads the same DB rows.
import { useState, useEffect, useCallback } from "react";
import { Loader2, Save, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

const FYS = ["2026-27", "2025-26", "2024-25"];
const BASE = import.meta.env.BASE_URL ?? "/";
const API  = `${BASE}api`.replace(/\/+/g, "/");

// ── Types ────────────────────────────────────────────────────────────────────

type HeadRow = {
  stateHead: string;
  monthly: Record<string, number>;
  monthlySource: Record<string, string | null>;
};

type ByHeadData = {
  fy: string;
  months: string[];
  companyTotals: Record<string, number>;
  heads: HeadRow[];
};

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtL(n: number): string {
  if (!n) return "";
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

function parseL(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

// ── Company summary tiles (same compact format as State Targets tab) ──────────

function CompanyTiles({
  months,
  totals,
}: {
  months: string[];
  totals: Record<string, number>;
}) {
  const populated = months.filter((m) => (totals[m] ?? 0) > 0);
  if (populated.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-4">
      {populated.map((m) => (
        <div
          key={m}
          className="border border-border/60 rounded-lg px-4 py-2.5 min-w-[110px] bg-muted/20"
        >
          <p className="text-xs text-muted-foreground mb-0.5">{m}</p>
          <p className="text-base font-semibold tabular-nums">
            {Math.round(totals[m]).toLocaleString("en-IN")} L
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Target (Lakh)</p>
        </div>
      ))}
    </div>
  );
}

// ── Source badge ──────────────────────────────────────────────────────────────

function SourceDot({ source }: { source: string | null }) {
  if (!source) return null;
  const cls =
    source === "user"
      ? "bg-blue-500"
      : source === "given"
      ? "bg-green-500"
      : "bg-muted-foreground/40";
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${cls} mr-0.5 flex-shrink-0`}
      title={source === "user" ? "user-entered" : source === "given" ? "plan figure" : "derived"}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PrimaryStateTargetsEditor() {
  const [fy, setFy] = useState("2026-27");
  const [data, setData]     = useState<ByHeadData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  // edits: headName → monthLabel → string value
  const [edits, setEdits] = useState<Map<string, Map<string, string>>>(new Map());
  const [saving, setSaving]     = useState(false);
  const [saveOk, setSaveOk]     = useState(false);
  const [saveErr, setSaveErr]   = useState<string | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const load = useCallback(async (fyVal: string) => {
    setLoading(true);
    setFetchErr(null);
    setSaveOk(false);
    try {
      const r = await fetch(`${API}/primary-state-targets/by-head?fy=${fyVal}`);
      if (!r.ok) throw new Error(await r.text());
      const d: ByHeadData = await r.json() as ByHeadData;
      setData(d);
      // Initialise edits from saved values
      const next = new Map<string, Map<string, string>>();
      for (const h of d.heads) {
        const row = new Map<string, string>();
        for (const m of d.months) {
          const v = h.monthly[m] ?? 0;
          row.set(m, v > 0 ? fmtL(v) : "");
        }
        next.set(h.stateHead, row);
      }
      setEdits(next);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : "Could not load targets.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(fy); }, [fy, load]);

  // ── Change handler ────────────────────────────────────────────────────────

  const handleChange = useCallback((head: string, month: string, val: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const row  = new Map(next.get(head) ?? []);
      row.set(month, val);
      next.set(head, row);
      return next;
    });
    setSaveOk(false);
  }, []);

  // ── Dirty detection ───────────────────────────────────────────────────────

  function isDirtyCell(head: string, month: string): boolean {
    if (!data) return false;
    const saved = data.heads.find((h) => h.stateHead === head)?.monthly[month] ?? 0;
    const edited = parseL(edits.get(head)?.get(month) ?? "");
    return Math.round(edited * 100) !== Math.round(saved * 100);
  }

  function isDirtyHead(head: string): boolean {
    if (!data) return false;
    return (data.months ?? []).some((m) => isDirtyCell(head, m));
  }

  const dirtyCount = data
    ? data.heads.filter((h) => isDirtyHead(h.stateHead)).length
    : 0;

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    setSaveErr(null);

    const updates: { stateHead: string; monthLabel: string; targetLakh: number }[] = [];

    for (const h of data.heads) {
      for (const m of data.months) {
        if (!isDirtyCell(h.stateHead, m)) continue;
        updates.push({
          stateHead: h.stateHead,
          monthLabel: m,
          targetLakh: parseL(edits.get(h.stateHead)?.get(m) ?? ""),
        });
      }
    }

    try {
      const r = await fetch(`${API}/primary-state-targets/by-head`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy, updates }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaveOk(true);
      await load(fy);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not save targets.");
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Months to show in the scrollable grid: all 12 always, but we'll render
  // a visual divider between "existing data" months and "future" months.
  const months = data?.months ?? [];

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-xl">State Head Targets</CardTitle>
            <CardDescription className="mt-1">
              Monthly primary sale targets per State Head in Lakh rupees. Edit
              any cell and save — values override seeded plan figures and feed
              the State Targets view directly. Enter future months (Aug onwards)
              here to extend the target horizon.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <select
              value={fy}
              onChange={(e) => { setFy(e.target.value); setSaveOk(false); }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {FYS.map((f) => (
                <option key={f} value={f}>FY {f}</option>
              ))}
            </select>
            {dirtyCount > 0 && (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save {dirtyCount} head{dirtyCount !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>

        {saveOk && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" /> Targets saved.
          </p>
        )}
        {saveErr && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> {saveErr}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> plan figure
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40" /> derived
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500" /> user-entered
          </span>
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-6">
        {loading && (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading targets...
          </div>
        )}

        {fetchErr && (
          <p className="px-6 py-6 text-sm text-destructive">
            {fetchErr}
          </p>
        )}

        {data && !loading && (
          <div className="px-6">
            {/* Company monthly totals strip */}
            <CompanyTiles months={months} totals={data.companyTotals} />

            {/* Per-head editable grid */}
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-sm border-separate border-spacing-0">
                <thead className="bg-muted/40 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap sticky left-0 bg-muted/40 border-b border-border/40">
                      State Head
                    </th>
                    {months.map((m) => (
                      <th
                        key={m}
                        className="px-2 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap min-w-[88px] border-b border-border/40"
                      >
                        {m}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap border-b border-border/40">
                      Total L
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {data.heads.map((h) => {
                    const dirty = isDirtyHead(h.stateHead);
                    const rowTotal = months.reduce(
                      (s, m) => s + (parseL(edits.get(h.stateHead)?.get(m) ?? "") || (h.monthly[m] ?? 0)),
                      0,
                    );
                    return (
                      <tr
                        key={h.stateHead}
                        className={`hover:bg-muted/20 transition-colors ${dirty ? "bg-primary/5" : ""}`}
                      >
                        <td className="px-3 py-2 font-medium whitespace-nowrap sticky left-0 bg-card border-r border-border/20">
                          {h.stateHead}
                          {dirty && (
                            <span className="ml-1.5 text-xs text-primary">edited</span>
                          )}
                        </td>
                        {months.map((m) => {
                          const cellDirty = isDirtyCell(h.stateHead, m);
                          const src = h.monthlySource[m];
                          const val = edits.get(h.stateHead)?.get(m) ?? "";
                          const placeholder = h.monthly[m] > 0 ? fmtL(h.monthly[m]) : "—";
                          return (
                            <td key={m} className="px-1.5 py-1.5 text-right">
                              <div className="relative inline-flex items-center">
                                {src && !cellDirty && (
                                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none">
                                    <SourceDot source={src} />
                                  </span>
                                )}
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={val}
                                  onChange={(e) => handleChange(h.stateHead, m, e.target.value)}
                                  placeholder={placeholder}
                                  className={`w-20 text-right rounded border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring bg-background transition-colors ${
                                    cellDirty
                                      ? "border-primary ring-1 ring-primary/30"
                                      : "border-input"
                                  }`}
                                />
                              </div>
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-muted-foreground whitespace-nowrap">
                          {rowTotal > 0 ? Math.round(rowTotal).toLocaleString("en-IN") : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/30 border-t border-border/40">
                  <tr>
                    <td className="px-3 py-2.5 font-semibold sticky left-0 bg-muted/30">
                      Company Total
                    </td>
                    {months.map((m) => {
                      // Sum over edits (dirty) or saved
                      const total = data.heads.reduce((s, h) => {
                        const edited = edits.get(h.stateHead)?.get(m) ?? "";
                        const val = edited !== ""
                          ? parseL(edited)
                          : (h.monthly[m] ?? 0);
                        return s + val;
                      }, 0);
                      return (
                        <td key={m} className="px-2 py-2.5 text-right tabular-nums font-semibold">
                          {total > 0 ? Math.round(total).toLocaleString("en-IN") : "—"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {Math.round(
                        data.heads.reduce((s, h) => {
                          return s + months.reduce((ms, m) => {
                            const edited = edits.get(h.stateHead)?.get(m) ?? "";
                            return ms + (edited !== "" ? parseL(edited) : (h.monthly[m] ?? 0));
                          }, 0);
                        }, 0),
                      ).toLocaleString("en-IN")}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Values in Lakh (1 L = ₹1,00,000). Enter targets for future months (Aug onwards) to extend the
              plan horizon. Saved values override plan figures and propagate to the State Targets view
              immediately.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
