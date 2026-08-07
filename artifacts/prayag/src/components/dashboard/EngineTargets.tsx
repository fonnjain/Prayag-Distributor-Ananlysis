import { trunc2IN } from "@/lib/trunc";
// ── T1 — Engine Generated Targets tab ────────────────────────────────────────
// Sub-tabs: Combined | Existing Sales Old SKU | Existing Sales New SKU | New Customers.
// All figures are engine PROPOSALS; user edits persist and survive regeneration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, AlertTriangle, Sparkles, Undo2 } from "lucide-react";
import PeopleEngineTargets from "./PeopleEngineTargets";

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

// ── Types (mirror api-server targetEngine.ts EngineResult) ──────────────────

type Weights = { oldSku: number; newSku: number; newCustomers: number };

type EngineRoute = {
  key: "oldSku" | "newSku" | "newCustomers";
  label: string;
  baselineValue: number;
  growthAllocated: number;
  target: number;
};

type SegmentRow = {
  segment: string;
  baseline: number;
  multiplier: number;
  multiplierSource: string;
  target: number;
  realVolumeGrowthPct: number | null;
  belowInflationFloor: boolean;
  monthlyTarget: number[] | null;
  seasonalBasis: string;
};

type RollupRow = {
  key: string;
  name: string;
  baseline: number;
  proposed: number;
  value: number;
  source: "generated" | "user";
  hadTarget: boolean;
};

type EngineResult = {
  fy: string;
  baselineFy: string;
  baseline: {
    totalValue: number;
    totalRows: number;
    territoryValue: number;
    projectValue: number;
    pairCount: number;
    customerCount: number;
  };
  populations: {
    existingOldSku: { pairs: number; customers: number; baselineValue: number };
    existingNewSku: { pairs: number; customers: number; distinctCodes: number; baselineValue: number };
    newCustomers: { pairs: number; baselineValue: number };
    reconciles: boolean;
  };
  params: {
    increasePct: number;
    inflationPct: number;
    weights: Weights;
    segMultipliers: Record<string, number>;
    source: "default" | "user";
  };
  companyMultiplier: number | null;
  realTerms: {
    nominalPct: number;
    realPct: number | null;
    context: { fy: string; valueCr: number; nominalPct: number | null; realPct: number | null }[];
  };
  combined: {
    base: number;
    growth: number;
    weights: Weights;
    altWeights: Weights;
    routes: EngineRoute[];
    projectCarriedAtBaseline: number;
    grandTarget: number;
  };
  segments: SegmentRow[];
  oldSkuList: { customer: string; code: string; segment: string; baseline: number }[];
  headRollup: RollupRow[];
  memberRollup: RollupRow[];
  memberAttribution: {
    attributedValue: number;
    unattributedValue: number;
    basis: string;
  };
  zeroTargetReport: {
    zeroTargetActiveCount: number;
    membersMoved: number;
    headsMoved: string[];
    names: string[];
    stillWithoutBaseline: string[];
  };
};

// ── Formatting ───────────────────────────────────────────────────────────────

function cr(n: number): string {
  return `₹${trunc2IN((n / 1e7))} Cr`;
}
function lakh(n: number): string {
  if (Math.abs(n) >= 1e7) return cr(n);
  return `₹${trunc2IN((n / 1e5))} L`;
}

// ── Component ────────────────────────────────────────────────────────────────

const SUBTABS = [
  { key: "combined", label: "Combined" },
  { key: "oldSku", label: "Existing Sales Old SKU" },
  { key: "newSku", label: "Existing Sales New SKU" },
  { key: "newCustomers", label: "New Customers" },
  { key: "people", label: "People (Secondary)" },
] as const;

type SubTab = (typeof SUBTABS)[number]["key"];

export default function EngineTargets() {
  const [data, setData] = useState<EngineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SubTab>("combined");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Editable params (strings for inputs)
  const [incStr, setIncStr] = useState("25");
  const [wOld, setWOld] = useState("25");
  const [wNew, setWNew] = useState("45");
  const [wCust, setWCust] = useState("30");
  const [segMults, setSegMults] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/target-engine`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const d: EngineResult = await res.json();
      setData(d);
      setIncStr(String(d.params.increasePct));
      setWOld(String(d.params.weights.oldSku));
      setWNew(String(d.params.weights.newSku));
      setWCust(String(d.params.weights.newCustomers));
      setSegMults(
        Object.fromEntries(
          Object.entries(d.params.segMultipliers ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const weightsSum = useMemo(
    () => (Number(wOld) || 0) + (Number(wNew) || 0) + (Number(wCust) || 0),
    [wOld, wNew, wCust],
  );

  const saveParams = async () => {
    if (!data) return;
    if (Math.abs(weightsSum - 100) > 0.01) {
      setNotice("Weights must add up to 100 before saving.");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`${API}/target-engine/params`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fy: data.fy,
          params: {
            increasePct: Number(incStr) || 25,
            inflationPct: data.params.inflationPct,
            weights: {
              oldSku: Number(wOld) || 0,
              newSku: Number(wNew) || 0,
              newCustomers: Number(wCust) || 0,
            },
            segMultipliers: Object.fromEntries(
              Object.entries(segMults)
                .map(([k, v]) => [k, Number(v)])
                .filter(([, v]) => Number.isFinite(v as number) && (v as number) > 0),
            ),
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Server responded ${res.status}`);
      }
      setNotice("Parameters saved. Regenerating with your settings…");
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const editRollup = async (row: RollupRow) => {
    if (!data) return;
    const input = window.prompt(
      `New target for ${row.name} (rupees).\nEngine proposes ${lakh(row.proposed)}.`,
      String(Math.round(row.value)),
    );
    if (input == null) return;
    const v = Number(input.replace(/[,\s]/g, ""));
    if (!Number.isFinite(v) || v < 0) { setNotice("Enter a valid non-negative number."); return; }
    try {
      const res = await fetch(`${API}/target-engine/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy: data.fy, rowKey: row.key, value: v, engineValue: row.proposed }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      await load();
    } catch (e) {
      setNotice(`Could not save the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const clearRollup = async (row: RollupRow) => {
    if (!data) return;
    try {
      const res = await fetch(`${API}/target-engine/override/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy: data.fy, rowKey: row.key }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      await load();
    } catch (e) {
      setNotice(`Could not revert the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Building target proposals from last
        year&apos;s actuals…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-16 text-center text-sm text-destructive">
        Could not build engine targets: {error ?? "no data"}.
        <button onClick={() => void load()} className="ml-2 underline">Retry</button>
      </div>
    );
  }

  const { combined, realTerms } = data;

  return (
    <div className="space-y-6">
      {/* Sub-tabs */}
      <div className="inline-flex rounded-md border border-border/50 p-0.5 text-sm flex-wrap">
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded font-medium transition-colors",
              tab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => void load()}
          className="px-3 py-1.5 text-muted-foreground hover:text-foreground"
          title="Regenerate (your edits are kept)"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      {notice && <p className="text-sm text-amber-600">{notice}</p>}

      {tab === "people" && <PeopleEngineTargets />}
      {tab !== "people" && (
      <>
      {/* Baseline strip — visible on all primary-basis tabs */}
      <Card className="border-border/50 bg-card/50">
        <CardContent className="px-6 py-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span>
            Baseline <b>FY{data.baselineFy}</b> actuals: <b>{cr(data.baseline.totalValue)}</b>{" "}
            ({data.baseline.totalRows.toLocaleString("en-IN")} invoice lines — frozen register)
          </span>
          <span>
            Territory {cr(data.baseline.territoryValue)} + Project/Govt{" "}
            {cr(data.baseline.projectValue)}
            {data.populations.reconciles ? " ✓ reconciles" : " ⚠ does not reconcile"}
          </span>
          <span>
            Populations: old SKU {data.populations.existingOldSku.pairs.toLocaleString("en-IN")} pairs
            ({data.baseline.customerCount} customers) · new SKU{" "}
            {data.populations.existingNewSku.pairs.toLocaleString("en-IN")} candidate pairs · new
            customers 0 baseline pairs — each pair in exactly one population
          </span>
        </CardContent>
      </Card>

      {tab === "combined" && (
        <CombinedTab
          data={data}
          incStr={incStr} setIncStr={setIncStr}
          wOld={wOld} setWOld={setWOld}
          wNew={wNew} setWNew={setWNew}
          wCust={wCust} setWCust={setWCust}
          segMults={segMults} setSegMults={setSegMults}
          weightsSum={weightsSum}
          saving={saving}
          onSave={() => void saveParams()}
          onEdit={editRollup}
          onClear={clearRollup}
        />
      )}

      {tab === "oldSku" && <OldSkuTab data={data} />}
      {tab === "newSku" && <NewSkuTab route={combined.routes.find((r) => r.key === "newSku")!} fy={data.fy} />}
      {tab === "newCustomers" && (
        <NewCustomersTab
          route={combined.routes.find((r) => r.key === "newCustomers")!}
          realTerms={realTerms}
        />
      )}
      </>
      )}
    </div>
  );
}

// ── Combined tab ─────────────────────────────────────────────────────────────

function CombinedTab(props: {
  data: EngineResult;
  incStr: string; setIncStr: (s: string) => void;
  wOld: string; setWOld: (s: string) => void;
  wNew: string; setWNew: (s: string) => void;
  wCust: string; setWCust: (s: string) => void;
  segMults: Record<string, string>;
  setSegMults: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  weightsSum: number;
  saving: boolean;
  onSave: () => void;
  onEdit: (r: RollupRow) => void;
  onClear: (r: RollupRow) => void;
}) {
  const { data, weightsSum } = props;
  const { combined, realTerms, params } = data;
  const inc = Number(props.incStr) || params.increasePct;

  const contextLine = useMemo(() => {
    const parts = realTerms.context
      .filter((c) => c.nominalPct != null)
      .map((c) => `FY${c.fy}: ${fmtPct(c.nominalPct)} nominal / ${fmtPct(c.realPct)} real`);
    return parts.join(" · ");
  }, [realTerms]);

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> Growth parameters
          </CardTitle>
          <CardDescription>
            Every value is editable — the engine recomputes proposals; your edits are kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Target increase (%)</label>
              <input
                inputMode="numeric"
                value={props.incStr}
                onChange={(e) => props.setIncStr(e.target.value)}
                className="w-24 h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              />
            </div>
            <div className="text-sm text-muted-foreground pb-2">
              {realTerms.realPct != null ? (
                <>
                  <b>{inc}% nominal ≈ {realTerms.realPct}% real</b> after expected price
                  increases (company price index {data.companyMultiplier ?? "n/a"}).
                </>
              ) : (
                <>Price index unavailable — real-terms line cannot be computed.</>
              )}
            </div>
          </div>
          {contextLine && (
            <p className="text-xs text-muted-foreground">For context, the business did: {contextLine}.</p>
          )}
          <div>
            <p className="text-sm font-medium mb-1.5">
              Growth split across the three routes{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (splits the growth of {cr(combined.growth)}, not the total)
              </span>
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {(
                [
                  ["Old SKU", props.wOld, props.setWOld],
                  ["New SKU", props.wNew, props.setWNew],
                  ["New customers", props.wCust, props.setWCust],
                ] as const
              ).map(([label, val, set]) => (
                <div key={label}>
                  <label className="text-xs text-muted-foreground block mb-1">{label} (%)</label>
                  <input
                    inputMode="numeric"
                    value={val}
                    onChange={(e) => set(e.target.value)}
                    className="w-24 h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
                  />
                </div>
              ))}
              <span
                className={cn(
                  "text-sm pb-2",
                  Math.abs(weightsSum - 100) > 0.01 ? "text-destructive" : "text-muted-foreground",
                )}
              >
                Sum: {weightsSum}%{Math.abs(weightsSum - 100) > 0.01 && " — must equal 100"}
              </span>
              <button
                onClick={props.onSave}
                disabled={props.saving}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-60"
              >
                {props.saving ? "Saving…" : "Save & regenerate"}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Alternative worth considering: {combined.altWeights.oldSku}/{combined.altWeights.newSku}/
              {combined.altWeights.newCustomers} — leans harder on new SKUs and new customers if you
              believe existing accounts are close to saturated.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Route summary */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Where the growth comes from</CardTitle>
          <CardDescription>
            Baseline {cr(combined.base)} + growth {cr(combined.growth)} = target{" "}
            {cr(combined.grandTarget)}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
                <th className="py-2">Route</th>
                <th className="py-2 text-right">Baseline</th>
                <th className="py-2 text-right">Growth allocated</th>
                <th className="py-2 text-right">Resulting target</th>
              </tr>
            </thead>
            <tbody>
              {combined.routes.map((r) => (
                <tr key={r.key} className="border-b border-border/30">
                  <td className="py-2">{r.label}</td>
                  <td className="py-2 text-right">{r.baselineValue > 0 ? cr(r.baselineValue) : "—"}</td>
                  <td className="py-2 text-right">{cr(r.growthAllocated)}</td>
                  <td className="py-2 text-right font-medium">{cr(r.target)}</td>
                </tr>
              ))}
              <tr className="border-b border-border/50 font-medium bg-muted/30">
                <td className="py-2">Total (territory routes)</td>
                <td className="py-2 text-right">
                  {cr(combined.routes.reduce((s, r) => s + r.baselineValue, 0))}
                </td>
                <td className="py-2 text-right">
                  {cr(combined.routes.reduce((s, r) => s + r.growthAllocated, 0))}
                </td>
                <td className="py-2 text-right">
                  {cr(combined.routes.reduce((s, r) => s + r.target, 0))}
                </td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-2">Project / Govt (carried at baseline, outside territory routes)</td>
                <td className="py-2 text-right">{cr(combined.projectCarriedAtBaseline)}</td>
                <td className="py-2 text-right">—</td>
                <td className="py-2 text-right">{cr(combined.projectCarriedAtBaseline)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Segments */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Per-segment targets & price reality check</CardTitle>
          <CardDescription>
            Each segment&apos;s own price index (from actual invoice prices). A flag means the{" "}
            {data.params.inflationPct}% floor is not beaten in real terms — the target is mostly
            price, not volume.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
                <th className="py-2">Segment</th>
                <th className="py-2 text-right">Baseline</th>
                <th className="py-2 text-right">Price index</th>
                <th className="py-2 text-right">Target</th>
                <th className="py-2 text-right">Real growth</th>
                <th className="py-2">Monthly split</th>
              </tr>
            </thead>
            <tbody>
              {data.segments.map((s) => (
                <tr key={s.segment} className="border-b border-border/30">
                  <td className="py-2">
                    {s.segment}
                    {s.belowInflationFloor && (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 inline ml-1.5" />
                    )}
                  </td>
                  <td className="py-2 text-right">{cr(s.baseline)}</td>
                  <td className="py-2 text-right">
                    <input
                      inputMode="decimal"
                      value={props.segMults[s.segment] ?? String(s.multiplier)}
                      onChange={(e) =>
                        props.setSegMults((p) => ({ ...p, [s.segment]: e.target.value }))
                      }
                      className="w-20 h-8 rounded-md border border-border/50 bg-background px-2 text-sm text-right"
                      title={`Default from actual invoice prices (${s.multiplierSource}); edit and Save & regenerate`}
                    />
                  </td>
                  <td className="py-2 text-right">{cr(s.target)}</td>
                  <td className={cn("py-2 text-right", s.belowInflationFloor && "text-amber-600")}>
                    {s.realVolumeGrowthPct != null ? `${s.realVolumeGrowthPct}%` : "n/a"}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {s.seasonalBasis === "segment-curve" ? "own seasonal curve" : "flat (no curve)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Rollups */}
      <RollupCard
        title="Proposed targets by State Head"
        rows={data.headRollup}
        onEdit={props.onEdit}
        onClear={props.onClear}
      />
      <RollupCard
        title="Proposed targets by team member"
        description={`Allocation basis: ${data.memberAttribution.basis === "head-pro-rata" ? "each head's baseline split pro-rata on this year's booking mix" : data.memberAttribution.basis}. Unallocated: ${cr(data.memberAttribution.unattributedValue)}.`}
        rows={data.memberRollup}
        onEdit={props.onEdit}
        onClear={props.onClear}
      />

      {/* Zero-target report */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Zero-target members</CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-6 text-sm space-y-2">
          <p>
            {data.zeroTargetReport.zeroTargetActiveCount} active members currently have no target on
            the dashboard. The engine now proposes targets for{" "}
            <b>{data.zeroTargetReport.membersMoved}</b> of them.
          </p>
          {data.zeroTargetReport.stillWithoutBaseline.length > 0 && (
            <p className="text-muted-foreground">
              Still without a proposal (no booking history to base one on):{" "}
              {data.zeroTargetReport.stillWithoutBaseline.join(", ")}.
            </p>
          )}
          {data.zeroTargetReport.headsMoved.length > 0 && (
            <p>Heads previously without any target now covered: {data.zeroTargetReport.headsMoved.join(", ")}.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function fmtPct(n: number | null): string {
  if (n == null) return "n/a";
  return `${n > 0 ? "+" : ""}${n}%`;
}

// ── Rollup table with inline edit ────────────────────────────────────────────

function RollupCard(props: {
  title: string;
  description?: string;
  rows: RollupRow[];
  onEdit: (r: RollupRow) => void;
  onClear: (r: RollupRow) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? props.rows : props.rows.slice(0, 15);
  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="px-6 pt-6 pb-2">
        <CardTitle className="text-lg">{props.title}</CardTitle>
        {props.description && <CardDescription>{props.description}</CardDescription>}
      </CardHeader>
      <CardContent className="px-6 pb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
              <th className="py-2">Name</th>
              <th className="py-2 text-right">Baseline</th>
              <th className="py-2 text-right">Proposed (+{""}growth)</th>
              <th className="py-2 text-right">Target</th>
              <th className="py-2 text-right">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/30">
                <td className="py-1.5">
                  {r.name}
                  {!r.hadTarget && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-600">new</span>
                  )}
                </td>
                <td className="py-1.5 text-right">{lakh(r.baseline)}</td>
                <td className="py-1.5 text-right text-muted-foreground">{lakh(r.proposed)}</td>
                <td className="py-1.5 text-right font-medium">
                  <button onClick={() => props.onEdit(r)} className="hover:underline" title="Click to edit">
                    {lakh(r.value)}
                  </button>
                </td>
                <td className="py-1.5 text-right">
                  {r.source === "user" ? (
                    <span className="inline-flex items-center gap-1 text-primary">
                      edited
                      <button onClick={() => props.onClear(r)} title="Revert to engine proposal">
                        <Undo2 className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">engine</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {props.rows.length > 15 && (
          <button
            onClick={() => setShowAll((s) => !s)}
            className="mt-2 text-xs text-primary hover:underline"
          >
            {showAll ? "Show fewer" : `Show all ${props.rows.length}`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Old SKU tab ──────────────────────────────────────────────────────────────

function OldSkuTab({ data }: { data: EngineResult }) {
  const [limit, setLimit] = useState(50);
  const route = data.combined.routes.find((r) => r.key === "oldSku")!;
  return (
    <div className="space-y-6">
      <RouteSummary route={route} note="Growth here means selling more of what each customer already buys — the list below ranks last year's customer×SKU pairs by value, biggest lever first." />
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Last year&apos;s customer×SKU pairs (top {limit})</CardTitle>
          <CardDescription>
            {data.populations.existingOldSku.pairs.toLocaleString("en-IN")} pairs across{" "}
            {data.populations.existingOldSku.customers} customers, totalling{" "}
            {cr(data.populations.existingOldSku.baselineValue)}.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
                <th className="py-2">Customer</th>
                <th className="py-2">SKU code</th>
                <th className="py-2">Segment</th>
                <th className="py-2 text-right">Baseline value</th>
              </tr>
            </thead>
            <tbody>
              {data.oldSkuList.slice(0, limit).map((r, i) => (
                <tr key={i} className="border-b border-border/30">
                  <td className="py-1.5">{r.customer}</td>
                  <td className="py-1.5 font-mono text-xs">{r.code}</td>
                  <td className="py-1.5">{r.segment}</td>
                  <td className="py-1.5 text-right">{lakh(r.baseline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {limit < data.oldSkuList.length && (
            <button onClick={() => setLimit((l) => l + 100)} className="mt-2 text-xs text-primary hover:underline">
              Show more
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RouteSummary({ route, note }: { route: EngineRoute; note: string }) {
  return (
    <Card className="border-border/50 bg-card/50">
      <CardContent className="px-6 py-4 text-sm flex flex-wrap gap-x-8 gap-y-1">
        <span>Baseline: <b>{route.baselineValue > 0 ? cr(route.baselineValue) : "—"}</b></span>
        <span>Growth allocated: <b>{cr(route.growthAllocated)}</b></span>
        <span>Resulting target: <b>{cr(route.target)}</b></span>
        <span className="w-full text-muted-foreground text-xs">{note}</span>
      </CardContent>
    </Card>
  );
}

// ── New SKU tab (reuses the existing K3 push list) ───────────────────────────

type DistItem = { key: string; name: string; state?: string | null };

function NewSkuTab({ route, fy }: { route: EngineRoute; fy: string }) {
  const [dists, setDists] = useState<DistItem[]>([]);
  const [sel, setSel] = useState("");
  const [push, setPush] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API}/sku/distributors?fy=${fy}`);
        const d = await res.json();
        const list = (d.distributors ?? d.rows ?? d ?? []) as any[];
        setDists(
          list
            .map((x) => ({
              key: x.customer ?? x.key ?? x.distributorKey ?? x.name,
              name: x.customer ?? x.name ?? x.key,
              state: x.headCanon ?? x.state ?? null,
            }))
            .filter((x) => x.key),
        );
      } catch {
        setErr("Could not load the distributor list.");
      }
    })();
  }, [fy]);

  useEffect(() => {
    if (!sel) { setPush(null); return; }
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const res = await fetch(
          `${API}/sku/push-list?fy=${fy}&level=distributor&distributorKey=${encodeURIComponent(sel)}`,
        );
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        setPush(await res.json());
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [sel, fy]);

  return (
    <div className="space-y-6">
      <RouteSummary
        route={route}
        note="Growth here comes from placing SKUs a customer's peers already sell but they don't — this is the existing push list, pick a distributor to see theirs."
      />
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Push list by distributor</CardTitle>
          <CardDescription>
            Same peer-cohort push list as SKU Deep Dive — nothing reinvented.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 space-y-4">
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="w-full sm:w-96 h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
          >
            <option value="">Choose a distributor…</option>
            {dists.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}{d.state ? ` — ${d.state}` : ""}
              </option>
            ))}
          </select>
          {loading && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Building the push list…
            </p>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          {push?.segments?.length > 0 && (
            <div className="space-y-4">
              {push.segments.map((seg: any) => (
                <div key={seg.segment}>
                  <p className="text-sm font-medium">{seg.segment}</p>
                  <table className="w-full text-sm">
                    <tbody>
                      {(seg.topCodes ?? []).slice(0, 8).map((c: any) => (
                        <tr key={c.code} className="border-b border-border/30">
                          <td className="py-1 font-mono text-xs">{c.code}</td>
                          <td className="py-1 text-xs">{c.itemName ?? ""}</td>
                          <td className="py-1 text-xs text-muted-foreground">
                            {c.peerCount != null ? `${c.peerCount} peers buy this` : ""}
                            {c.tierLabel ? ` · ${c.tierLabel}` : ""}
                          </td>
                          <td className="py-1 text-right text-xs">
                            {c.peerNet != null ? lakh(c.peerNet) : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          {push && !(push.segments?.length > 0) && !loading && (
            <p className="text-sm text-muted-foreground">No push-list gaps for this distributor.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── New Customers tab ────────────────────────────────────────────────────────

function NewCustomersTab({
  route,
  realTerms,
}: {
  route: EngineRoute;
  realTerms: EngineResult["realTerms"];
}) {
  return (
    <div className="space-y-6">
      <RouteSummary
        route={route}
        note="Growth here comes from opening accounts that don't buy from us today."
      />
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="px-6 pt-6 pb-2">
          <CardTitle className="text-lg">Where to find them</CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-6 text-sm space-y-3">
          <p>
            The whitespace analysis already maps this: districts with prior-year demand but no
            distributor (coverage gaps) and retailers not assigned to anyone (assignment gaps).
          </p>
          <p className="text-muted-foreground">
            Open <b>Distributor Deep Dive → select a state head → Whitespace</b> for the district-level
            list. The target above is the share of growth this route must deliver; the whitespace
            list is the working document for it.
          </p>
          {realTerms.realPct != null && (
            <p className="text-xs text-muted-foreground">
              Reminder: at the current parameters, {realTerms.nominalPct}% nominal is{" "}
              {realTerms.realPct}% real — new-customer acquisition is what keeps that gap honest.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
