import { trunc2IN } from "@/lib/trunc";
// ── T2 — Engine targets per salesperson and State Head (SECONDARY basis) ─────
// Renders inside EngineTargets as the "People" sub-tab. Every figure here is
// computed on the secondary register (retailer → distributor) — the only
// measure that carries a salesperson name. The company/distributor engine
// stays on the primary basis; the two are labelled and never blended.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, AlertTriangle, Sparkles, Undo2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

type PersonFlag = { kind: string; detail: string };

type PersonRow = {
  type: "member" | "head";
  name: string;
  key: string;
  stateHead: string;
  state: string;
  baseline: number;
  baselineRetailers: number;
  oldSkuPairs: number;
  uncoveredAllocated: number;
  oldSkuTarget: number | null;
  newSkuTarget: number | null;
  newCustomerTarget: number | null;
  combined: number | null;
  engineProposed: number | null;
  source: "generated" | "user" | "none";
  userFilled: number | null;
  difference: number | null;
  hadTarget: boolean;
  monthlySplit: number[] | null;
  splitBasis: string | null;
  fallbackBasis: string | null;
  flags: PersonFlag[];
  scaledCombined?: number | null;
};

type PeopleResult = {
  basis: "secondary";
  basisNote: string;
  fy: string;
  baselineFy: string;
  params: { increasePct: number; weights: { oldSku: number; newSku: number; newCustomers: number } };
  baseline: {
    skuLineTotal: number;
    registerTotal: number;
    deltaPct: number;
    lines: number;
    attributedTotal: number;
    unattributedTotal: number;
    unattributedHeads: number;
  };
  populations: {
    oldSkuPairs: number;
    newSkuCandidatePairs: number;
    newCustomers: {
      registeredRetailers: number;
      declaredCoverage: number;
      idVerifiedCoverage: number;
      uncoveredRetailers: number;
      note: string;
      unattributedStates: number;
    };
  };
  zeroTargetMoved: { count: number; names: string[]; totalGenerated: number };
  leftMembersExcluded: string[];
  impliedCompanyTotal: number;
  scaling: { requested: number | null; factor: number | null };
  rows: PersonRow[];
};

function cr(n: number): string {
  return `₹${trunc2IN((n / 1e7))} Cr`;
}
function lakh(n: number): string {
  if (Math.abs(n) >= 1e7) return cr(n);
  return `₹${trunc2IN((n / 1e5))} L`;
}

const FLAG_LABEL: Record<string, string> = {
  left: "Left — no target",
  fallback: "Fallback (peer median)",
  newMember: "New member",
  proRated: "Pro-rated tenure",
  thinBase: "Thin retailer base",
  gainedTarget: "Was zero-target",
  noPool: "No uncovered pool",
  sumMismatch: "Differs from member sum",
};

const FLAG_CLASS: Record<string, string> = {
  left: "bg-muted text-muted-foreground",
  fallback: "bg-amber-500/15 text-amber-600",
  newMember: "bg-sky-500/15 text-sky-600",
  proRated: "bg-violet-500/15 text-violet-600",
  thinBase: "bg-amber-500/15 text-amber-600",
  gainedTarget: "bg-emerald-500/15 text-emerald-600",
  noPool: "bg-muted text-muted-foreground",
  sumMismatch: "bg-destructive/15 text-destructive",
};

export default function PeopleEngineTargets() {
  const [data, setData] = useState<PeopleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [headFilter, setHeadFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [scaleStr, setScaleStr] = useState<string>("");
  const [scaleApplied, setScaleApplied] = useState<number | null>(null);

  const load = useCallback(async (scaleTo?: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const qs = scaleTo ? `?scaleTo=${scaleTo}` : "";
      const res = await fetch(`${API}/target-engine/people${qs}`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      setData(await res.json());
      setScaleApplied(scaleTo ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const heads = useMemo(
    () => (data ? [...new Set(data.rows.filter((r) => r.type === "head").map((r) => r.name))].sort() : []),
    [data],
  );

  const memberOptions = useMemo(() => {
    if (!data) return [];
    return data.rows
      .filter((r) => r.type === "member" && (headFilter === "all" || r.stateHead === headFilter))
      .map((r) => r.name)
      .sort();
  }, [data, headFilter]);

  const visible = useMemo(() => {
    if (!data) return [];
    let rows = data.rows;
    if (headFilter !== "all") {
      rows = rows.filter(
        (r) => (r.type === "head" && r.name === headFilter) || (r.type === "member" && r.stateHead === headFilter),
      );
    }
    if (memberFilter !== "all") {
      rows = rows.filter((r) => r.type === "head" || r.name === memberFilter);
    }
    return rows;
  }, [data, headFilter, memberFilter]);

  const edit = async (row: PersonRow) => {
    if (!data || row.source === "none") return;
    const input = window.prompt(
      `New annual target for ${row.name} (rupees).\nEngine proposes ${lakh(row.engineProposed ?? row.combined ?? 0)}.`,
      String(Math.round(row.combined ?? 0)),
    );
    if (input == null) return;
    const v = Number(input.replace(/[,\s]/g, ""));
    if (!Number.isFinite(v) || v < 0) { setNotice("Enter a valid non-negative number."); return; }
    try {
      const rowKey = `${row.type === "head" ? "sechead" : "secmember"}|${row.key}`;
      const res = await fetch(`${API}/target-engine/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy: data.fy, rowKey, value: v, engineValue: row.engineProposed ?? row.combined }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      await load(scaleApplied);
    } catch (e) {
      setNotice(`Could not save the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const revert = async (row: PersonRow) => {
    if (!data) return;
    try {
      const rowKey = `${row.type === "head" ? "sechead" : "secmember"}|${row.key}`;
      const res = await fetch(`${API}/target-engine/override/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy: data.fy, rowKey }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      await load(scaleApplied);
    } catch (e) {
      setNotice(`Could not revert the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const applyScale = () => {
    const v = Number(scaleStr.replace(/[,\s]/g, ""));
    if (!Number.isFinite(v) || v <= 0) { setNotice("Enter the company target in rupees (e.g. 4000000000 for ₹400 Cr)."); return; }
    setNotice(null);
    void load(v);
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Building person-level targets from last
        year&apos;s secondary business…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-16 text-center text-sm text-destructive">
        Could not build person-level targets: {error ?? "no data"}.
        <button onClick={() => void load()} className="ml-2 underline">Retry</button>
      </div>
    );
  }

  const nc = data.populations.newCustomers;

  return (
    <div className="space-y-6">
      {/* Basis banner — this is a DIFFERENT measure from the company tabs */}
      <Card className="border-sky-500/30 bg-sky-500/5">
        <CardContent className="px-6 py-3 text-sm text-muted-foreground">
          <b className="text-foreground">Secondary basis.</b> {data.basisNote}
        </CardContent>
      </Card>

      {notice && <p className="text-sm text-amber-600">{notice}</p>}

      {/* Baseline reconciliation strip */}
      <Card className="border-border/50 bg-card/50">
        <CardContent className="px-6 py-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span>Baseline <b>FY{data.baselineFy}</b> secondary: <b>{cr(data.baseline.skuLineTotal)}</b></span>
          <span>Register total: <b>{cr(data.baseline.registerTotal)}</b> (difference {data.baseline.deltaPct}%)</span>
          <span>Attributed to the roster: <b>{cr(data.baseline.attributedTotal)}</b></span>
          <span title="Business booked under names that are not on the current team roster (mostly people who have left).">
            Not attributed: <b>{cr(data.baseline.unattributedTotal)}</b> ({data.baseline.unattributedHeads} names)
          </span>
          <span>Growth setting: <b>+{data.params.increasePct}%</b></span>
        </CardContent>
      </Card>

      {/* Populations + guards strip */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">New-customer pool</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>{nc.registeredRetailers.toLocaleString("en-IN")} registered retailers</p>
            <p>{nc.declaredCoverage.toLocaleString("en-IN")} declared covered (non-dedup)</p>
            <p><b>{nc.uncoveredRetailers.toLocaleString("en-IN")}</b> uncovered — attributed by state to each salesperson</p>
            <p className="text-xs text-muted-foreground">{nc.unattributedStates} states have retailers but no salesperson.</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Zero-target members</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <p><b>{data.zeroTargetMoved.count}</b> members had no target — all now receive one, totalling <b>{cr(data.zeroTargetMoved.totalGenerated)}</b>.</p>
            <p className="text-xs text-muted-foreground">{data.leftMembersExcluded.length} members who left get none (history kept).</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Bottom-up total &amp; scaling</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <p>Sum of all person targets: <b>{cr(data.impliedCompanyTotal)}</b></p>
            <div className="flex gap-2 items-center">
              <input
                value={scaleStr}
                onChange={(e) => setScaleStr(e.target.value)}
                placeholder="Company target (₹)"
                className="w-36 rounded border border-border/50 bg-background px-2 py-1 text-sm"
              />
              <button onClick={applyScale} className="text-sm underline">Scale</button>
              {scaleApplied != null && (
                <button onClick={() => void load(null)} className="text-sm text-muted-foreground underline">Clear</button>
              )}
            </div>
            {data.scaling.factor != null && (
              <p className="text-xs text-amber-600">
                Visible scaling ×{data.scaling.factor} applied to reach {cr(data.scaling.requested ?? 0)} — shown as a separate column, never silently.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filter + table */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Targets by person</CardTitle>
            <CardDescription>Head rows are the sum of their members. Click a figure to edit it — your edits survive regeneration.</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <select
              value={headFilter}
              onChange={(e) => { setHeadFilter(e.target.value); setMemberFilter("all"); }}
              className="rounded border border-border/50 bg-background px-2 py-1"
            >
              <option value="all">All State Heads</option>
              {heads.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <select
              value={memberFilter}
              onChange={(e) => setMemberFilter(e.target.value)}
              className="rounded border border-border/50 bg-background px-2 py-1"
            >
              <option value="all">All salespeople</option>
              {memberOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button onClick={() => void load(scaleApplied)} title="Regenerate (your edits are kept)">
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">State Head</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3 text-right">FY{data.baselineFy} secondary</th>
                <th className="py-2 pr-3 text-right">Old-SKU</th>
                <th className="py-2 pr-3 text-right">New-SKU</th>
                <th className="py-2 pr-3 text-right" title="Uncovered roster retailers attributed to this person by state and baseline share">Pool (retailers)</th>
                <th className="py-2 pr-3 text-right">New-customer</th>
                <th className="py-2 pr-3 text-right">Combined</th>
                {data.scaling.factor != null && <th className="py-2 pr-3 text-right">Scaled</th>}
                <th className="py-2 pr-3 text-right">User Filled (annualised)</th>
                <th className="py-2 pr-3 text-right">Difference</th>
                <th className="py-2 pr-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={`${r.type}|${r.key}`}
                  className={cn(
                    "border-b border-border/30",
                    r.type === "head" && "bg-muted/40 font-medium",
                    r.source === "none" && "opacity-50",
                  )}
                >
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {r.name}
                    {r.type === "head" && <span className="ml-1 text-[10px] uppercase text-muted-foreground">head</span>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.type === "member" ? r.stateHead : "—"}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.state}</td>
                  <td className="py-1.5 pr-3 text-right">{r.baseline > 0 ? lakh(r.baseline) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.oldSkuTarget != null ? lakh(r.oldSkuTarget) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.newSkuTarget != null ? lakh(r.newSkuTarget) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.uncoveredAllocated > 0 ? r.uncoveredAllocated.toLocaleString("en-IN") : "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{r.newCustomerTarget != null ? lakh(r.newCustomerTarget) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                    {r.combined != null ? (
                      <button onClick={() => void edit(r)} className="hover:underline" title="Click to edit">
                        {lakh(r.combined)}
                        {r.source === "user" && <Sparkles className="inline w-3 h-3 ml-1 text-amber-500" />}
                      </button>
                    ) : "—"}
                    {r.source === "user" && (
                      <>
                        {r.engineProposed != null && (
                          <span className="block text-[11px] text-muted-foreground">engine: {lakh(r.engineProposed)}</span>
                        )}
                        <button onClick={() => void revert(r)} title="Revert to the engine figure" className="ml-1 align-middle">
                          <Undo2 className="inline w-3 h-3 text-muted-foreground" />
                        </button>
                      </>
                    )}
                  </td>
                  {data.scaling.factor != null && (
                    <td className="py-1.5 pr-3 text-right">{r.scaledCombined != null ? lakh(r.scaledCombined) : "—"}</td>
                  )}
                  <td className="py-1.5 pr-3 text-right">{r.userFilled != null ? lakh(r.userFilled) : "—"}</td>
                  <td className={cn("py-1.5 pr-3 text-right", (r.difference ?? 0) > 0 ? "text-emerald-600" : (r.difference ?? 0) < 0 ? "text-destructive" : "")}>
                    {r.difference != null ? lakh(r.difference) : "—"}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {r.flags.map((f, i) => (
                        <span
                          key={i}
                          title={f.detail}
                          className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap", FLAG_CLASS[f.kind] ?? "bg-muted")}
                        >
                          {f.kind === "sumMismatch" && <AlertTriangle className="w-3 h-3 mr-0.5" />}
                          {FLAG_LABEL[f.kind] ?? f.kind}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Monthly phasing follows each person&apos;s own segment mix and that segment&apos;s seasonal curve
            (fallback figures use a flat curve). Hover a note for the full explanation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
