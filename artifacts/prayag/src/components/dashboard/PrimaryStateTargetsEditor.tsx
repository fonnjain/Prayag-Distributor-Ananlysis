import { trunc2 } from "@/lib/trunc";
// Editable state-head monthly target grid — the single canonical source for
// primary state-head targets.  Reads from GET /api/primary-state-targets/by-head
// and writes via PUT /api/primary-state-targets/by-head.
// Values are in Lakh rupees.
import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Save, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
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

const MONTH_SHORT = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

type SeasonalCalibration = {
  fy: string;
  derivedFrom: string;
  monthly: number[];   // 12 normalised shares, Apr=0..Mar=11
  quarterly: number[];
  monthNames: readonly string[];
};

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
  seasonalCalibration: SeasonalCalibration;
};

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtL(n: number): string {
  if (!n) return "";
  return n % 1 === 0 ? String(Math.round(n)) : trunc2(n);
}

function parseL(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
}

function fmtPct(n: number): string {
  return trunc2((n * 100));
}

// ── Editable seasonal calibration panel ──────────────────────────────────────

type SeasonalPanelProps = {
  calibration: SeasonalCalibration;
  overrides: number[];  // 12 values as normalised shares (may differ from calibration)
  onOverride: (idx: number, val: number) => void;
  onReset: () => void;
  onAutoCalc: () => void;
  hasEmpty: boolean;
};

function SeasonalPanel({ calibration, overrides, onOverride, onReset, onAutoCalc, hasEmpty }: SeasonalPanelProps) {
  const [editing, setEditing] = useState<string[]>(() =>
    overrides.map((v) => fmtPct(v)),
  );
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) { initialized.current = true; return; }
    setEditing(overrides.map((v) => fmtPct(v)));
  }, [overrides]);

  function handleChange(idx: number, raw: string) {
    const next = [...editing];
    next[idx] = raw;
    setEditing(next);
    const n = parseFloat(raw.replace(/[,\s]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      onOverride(idx, n / 100);
    }
  }

  const isOverridden = overrides.some((v, i) => Math.abs(v - calibration.monthly[i]) > 0.0001);

  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground mb-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="font-medium text-foreground/80">
          Seasonal Calibration — Primary Target Splitting
          {isOverridden && (
            <span className="ml-2 text-blue-500 font-normal">(custom weights active)</span>
          )}
        </p>
        <div className="flex gap-2 flex-wrap">
          {isOverridden && (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border/60 hover:bg-muted/60 transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Reset to default
            </button>
          )}
          <button
            type="button"
            onClick={onAutoCalc}
            disabled={!hasEmpty}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            title={hasEmpty ? "Fill empty months using seasonal weights and implied annual total" : "No empty months to fill"}
          >
            <RefreshCw className="h-3 w-3" />
            Auto Calculate
          </button>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-x-3 gap-y-2 mb-2">
        {MONTH_SHORT.map((m, i) => (
          <div key={m} className="flex flex-col items-center gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{m}</span>
            <input
              type="text"
              inputMode="decimal"
              value={editing[i] ?? fmtPct(overrides[i] ?? 0)}
              onChange={(e) => handleChange(i, e.target.value)}
              className="w-14 text-center rounded border border-input bg-background px-1 py-0.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-[9px] text-muted-foreground/50">%</span>
          </div>
        ))}
      </div>
      <div className="flex gap-4 flex-wrap border-t border-border/40 pt-2">
        {(["Q1","Q2","Q3","Q4"] as const).map((q, i) => {
          const qShare = [0,3,6,9].map((s,qi) =>
            overrides.slice(s, s+3).reduce((a,b) => a+b, 0)
          )[i] ?? 0;
          return (
            <span key={q}>
              <span className="text-muted-foreground/70">{q}</span>{" "}
              <span className="font-mono text-foreground/70">{trunc2((qShare * 100))}%</span>
            </span>
          );
        })}
        <span className="ml-auto text-muted-foreground/60 italic">
          Calibrated from FY{calibration.fy} retail actuals. Edit % to customise; click Auto Calculate to fill empty months.
        </span>
      </div>
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
      className={`inline-block w-1.5 h-1.5 rounded-full ${cls} flex-shrink-0`}
      title={source === "user" ? "user-entered" : source === "given" ? "plan figure" : "derived"}
    />
  );
}

// ── Company tiles ─────────────────────────────────────────────────────────────

function CompanyTiles({ months, totals }: { months: string[]; totals: Record<string, number> }) {
  const populated = months.filter((m) => (totals[m] ?? 0) > 0);
  if (populated.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-4">
      {populated.map((m) => (
        <div key={m} className="border border-border/60 rounded-lg px-4 py-2.5 min-w-[110px] bg-muted/20">
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

// ── Main component ────────────────────────────────────────────────────────────

export default function PrimaryStateTargetsEditor() {
  const [fy, setFy] = useState("2026-27");
  const [data, setData]       = useState<ByHeadData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  // edits: headName → monthLabel → string value
  const [edits, setEdits] = useState<Map<string, Map<string, string>>>(new Map());
  const [saving, setSaving]   = useState(false);
  const [saveOk, setSaveOk]   = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Seasonal weight overrides — 12 normalised shares
  const [seasonalOverrides, setSeasonalOverrides] = useState<number[]>([]);

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
      setSeasonalOverrides([...d.seasonalCalibration.monthly]);
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

  // ── Seasonal override handlers ────────────────────────────────────────────

  const handleSeasonalOverride = useCallback((idx: number, val: number) => {
    setSeasonalOverrides((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  }, []);

  const handleSeasonalReset = useCallback(() => {
    if (data) setSeasonalOverrides([...data.seasonalCalibration.monthly]);
  }, [data]);

  // ── Auto Calculate ────────────────────────────────────────────────────────
  // For each head:
  //   1. Look at which months have values (non-zero) — call them "filled"
  //   2. Compute filledWeightSum = sum of seasonal weights for those months
  //   3. impliedAnnual = sum(filled values) / filledWeightSum
  //   4. Fill empty months: value = impliedAnnual × weight[i]
  //   Round to nearest integer Lakh.

  const handleAutoCalc = useCallback(() => {
    if (!data) return;
    const months = data.months;

    // Normalise the overrides so they sum to 1
    const total = seasonalOverrides.reduce((s, v) => s + v, 0);
    const weights = total > 0 ? seasonalOverrides.map((v) => v / total) : seasonalOverrides;

    setEdits((prev) => {
      const next = new Map(prev);

      for (const h of data.heads) {
        const row = new Map(next.get(h.stateHead) ?? []);

        // Collect filled values and their indices
        const filledIdxs: number[] = [];
        let filledSum = 0;
        let filledWeightSum = 0;

        months.forEach((m, i) => {
          const raw = row.get(m) ?? "";
          const saved = h.monthly[m] ?? 0;
          const val = raw !== "" ? parseL(raw) : saved;
          if (val > 0) {
            filledIdxs.push(i);
            filledSum += val;
            filledWeightSum += weights[i] ?? 0;
          }
        });

        if (filledSum === 0 || filledWeightSum === 0) continue; // nothing to infer from

        const impliedAnnual = filledSum / filledWeightSum;

        // Fill empty months only
        let changed = false;
        months.forEach((m, i) => {
          const raw = row.get(m) ?? "";
          const saved = h.monthly[m] ?? 0;
          const hasValue = raw !== "" ? parseL(raw) > 0 : saved > 0;
          if (!hasValue) {
            const computed = Math.round(impliedAnnual * (weights[i] ?? 0));
            if (computed > 0) {
              row.set(m, String(computed));
              changed = true;
            }
          }
        });

        if (changed) next.set(h.stateHead, row);
      }

      return next;
    });
    setSaveOk(false);
  }, [data, seasonalOverrides]);

  // ── Dirty detection ───────────────────────────────────────────────────────

  function isDirtyCell(head: string, month: string): boolean {
    if (!data) return false;
    const saved   = data.heads.find((h) => h.stateHead === head)?.monthly[month] ?? 0;
    const edited  = parseL(edits.get(head)?.get(month) ?? "");
    return Math.round(edited * 10) !== Math.round(saved * 10);
  }

  function isDirtyHead(head: string): boolean {
    return (data?.months ?? []).some((m) => isDirtyCell(head, m));
  }

  const dirtyCount = data ? data.heads.filter((h) => isDirtyHead(h.stateHead)).length : 0;

  // Whether any head has empty future months (for the Auto Calc button state)
  const hasEmpty = data
    ? data.heads.some((h) =>
        data.months.some((m) => {
          const raw = edits.get(h.stateHead)?.get(m) ?? "";
          const saved = h.monthly[m] ?? 0;
          return raw === "" ? saved === 0 : parseL(raw) === 0;
        }),
      )
    : false;

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

  const months = data?.months ?? [];

  // Running company totals (use edits where dirty, otherwise saved)
  function liveCompanyTotals(): Record<string, number> {
    if (!data) return {};
    return Object.fromEntries(
      months.map((m) => [
        m,
        data.heads.reduce((s, h) => {
          const edited = edits.get(h.stateHead)?.get(m) ?? "";
          return s + (edited !== "" ? parseL(edited) : (h.monthly[m] ?? 0));
        }, 0),
      ]),
    );
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-xl">State Head Targets</CardTitle>
            <CardDescription className="mt-1">
              Monthly primary sale targets per State Head in Lakh rupees. Single canonical source — edits propagate to all views. Enter future months (Aug onwards) directly or use Auto Calculate to derive them from the seasonal curve.
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
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
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
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> plan figure
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40" /> derived
          </span>
          <span className="flex items-center gap-1.5">
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
          <p className="px-6 py-6 text-sm text-destructive">{fetchErr}</p>
        )}

        {data && !loading && (
          <div className="px-6">
            {/* Seasonal calibration panel */}
            <SeasonalPanel
              calibration={data.seasonalCalibration}
              overrides={seasonalOverrides}
              onOverride={handleSeasonalOverride}
              onReset={handleSeasonalReset}
              onAutoCalc={handleAutoCalc}
              hasEmpty={hasEmpty}
            />

            {/* Company monthly totals strip — live (reflects dirty edits) */}
            <CompanyTiles months={months} totals={liveCompanyTotals()} />

            {/* Per-head editable grid */}
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-sm border-separate border-spacing-0">
                <thead className="bg-muted/40 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap sticky left-0 bg-muted/40 border-b border-border/40 min-w-[160px]">
                      State Head
                    </th>
                    {months.map((m) => (
                      <th key={m} className="px-2 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap min-w-[88px] border-b border-border/40">
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
                    const rowTotal = months.reduce((s, m) => {
                      const raw  = edits.get(h.stateHead)?.get(m) ?? "";
                      const val  = raw !== "" ? parseL(raw) : (h.monthly[m] ?? 0);
                      return s + val;
                    }, 0);
                    return (
                      <tr
                        key={h.stateHead}
                        className={`hover:bg-muted/20 transition-colors ${dirty ? "bg-primary/5" : ""}`}
                      >
                        <td className="px-3 py-2 font-medium whitespace-nowrap sticky left-0 bg-card border-r border-border/20">
                          {h.stateHead}
                          {dirty && <span className="ml-1.5 text-xs text-primary">edited</span>}
                        </td>
                        {months.map((m, mi) => {
                          const cellDirty  = isDirtyCell(h.stateHead, m);
                          const src        = h.monthlySource[m];
                          const val        = edits.get(h.stateHead)?.get(m) ?? "";
                          const savedVal   = h.monthly[m] ?? 0;
                          const placeholder = savedVal > 0 ? fmtL(savedVal) : "—";
                          const isAutoFilled = cellDirty && val !== "" && src == null;
                          return (
                            <td key={m} className="px-1.5 py-1.5 text-right">
                              <div className="relative inline-flex items-center gap-0.5 justify-end">
                                {src && !cellDirty && (
                                  <SourceDot source={src} />
                                )}
                                {isAutoFilled && (
                                  <SourceDot source="user" />
                                )}
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={val}
                                  onChange={(e) => handleChange(h.stateHead, m, e.target.value)}
                                  placeholder={placeholder}
                                  title={`Month ${mi + 1}: seasonal weight ${fmtPct(seasonalOverrides[mi] ?? 0)}%`}
                                  className={`w-20 text-right rounded border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring bg-background transition-colors ${
                                    cellDirty ? "border-primary ring-1 ring-primary/30" : "border-input"
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
                    <td className="px-3 py-2.5 font-semibold sticky left-0 bg-muted/30 border-r border-border/20">
                      Company Total
                    </td>
                    {months.map((m) => {
                      const total = data.heads.reduce((s, h) => {
                        const edited = edits.get(h.stateHead)?.get(m) ?? "";
                        return s + (edited !== "" ? parseL(edited) : (h.monthly[m] ?? 0));
                      }, 0);
                      return (
                        <td key={m} className="px-2 py-2.5 text-right tabular-nums font-semibold">
                          {total > 0 ? Math.round(total).toLocaleString("en-IN") : "—"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {Math.round(
                        data.heads.reduce((s, h) =>
                          s + months.reduce((ms, m) => {
                            const edited = edits.get(h.stateHead)?.get(m) ?? "";
                            return ms + (edited !== "" ? parseL(edited) : (h.monthly[m] ?? 0));
                          }, 0), 0,
                        ),
                      ).toLocaleString("en-IN")}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Values in Lakh (1 L = ₹1,00,000). Adjust seasonal % weights above then click Auto Calculate to fill empty months from implied annual. Saved values override plan figures and propagate to all reports instantly.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
