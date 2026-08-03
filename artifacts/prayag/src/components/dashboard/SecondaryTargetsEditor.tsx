import { trunc2 } from "@/lib/trunc";
// Secondary Targets editor — per-team-member secondary order-booking targets.
// Extracted from DataSources.tsx so it can live on the Targets page.
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CheckCircle2, Save, Loader2, AlertTriangle } from "lucide-react";
import {
  useGetTargets,
  useSaveTargets,
  type TargetsMember,
} from "@workspace/api-client-react";

const FYS = ["2026-27", "2025-26", "2024-25"];

type Cadence = "annual" | "half_yearly" | "quarterly" | "monthly";

const CADENCE_LABELS: Record<Cadence, string[]> = {
  annual: ["Annual (₹ Cr)"],
  half_yearly: ["H1 Apr-Sep", "H2 Oct-Mar"],
  quarterly: ["Q1 Apr-Jun", "Q2 Jul-Sep", "Q3 Oct-Dec", "Q4 Jan-Mar"],
  monthly: ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"],
};

const CADENCE_LENGTHS: Record<Cadence, number> = {
  annual: 1,
  half_yearly: 2,
  quarterly: 4,
  monthly: 12,
};

function fmtCrPrior(n: number | null | undefined): string {
  if (n == null) return "—";
  return `\u20b9${trunc2((n / 1e7))} Cr`;
}

function fmtCr(n: number): string {
  if (!n || n === 0) return "";
  return trunc2((n / 1e7));
}

function parseCr(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 1e7) : 0;
}

function sumArr(arr: number[]): number { return arr.reduce((s, v) => s + v, 0); }

function toDisplayValues(annualRupees: number, monthlyArr: number[], cadence: Cadence): number[] {
  // When monthly values are present, roll them up for coarser cadences
  // so Annual/Quarterly/Half-yearly always reflect the true monthly sum.
  if (monthlyArr.some((v) => v > 0)) {
    if (cadence === "monthly")     return [...monthlyArr];
    if (cadence === "annual")      return [sumArr(monthlyArr)];
    if (cadence === "half_yearly") return [sumArr(monthlyArr.slice(0, 6)), sumArr(monthlyArr.slice(6, 12))];
    if (cadence === "quarterly")   return [
      sumArr(monthlyArr.slice(0, 3)),
      sumArr(monthlyArr.slice(3, 6)),
      sumArr(monthlyArr.slice(6, 9)),
      sumArr(monthlyArr.slice(9, 12)),
    ];
  }
  // No monthly data — distribute the annual figure equally.
  const n = CADENCE_LENGTHS[cadence];
  const perPeriod = annualRupees / n;
  if (cadence === "annual")      return [annualRupees];
  if (cadence === "half_yearly") return [perPeriod, perPeriod];
  if (cadence === "quarterly")   return [perPeriod, perPeriod, perPeriod, perPeriod];
  return Array(12).fill(perPeriod);
}

function emptyEdits(cadence: Cadence): string[] {
  return Array<string>(CADENCE_LENGTHS[cadence]).fill("");
}

function coerceMonthly(arr: (number | null)[]): number[] {
  return arr.map((v) => v ?? 0);
}

export default function SecondaryTargetsEditor() {
  const [fy, setFy] = useState(FYS[0]);
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const targets = useGetTargets({ fy });
  const save = useSaveTargets();
  const [edits, setEdits] = useState<Map<string, string[]>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const members: TargetsMember[] = targets.data?.members ?? [];

  // Compute the canonical display values for a member+cadence, taking into
  // account: (1) Target Master monthly overrides, (2) STATE HD plan pre-fill,
  // (3) annual distribution, in that priority order.
  function savedDisplayVals(m: TargetsMember, cad: Cadence): number[] {
    const annual = m.saved?.annual.secondary ?? 0;
    const monthly = coerceMonthly(m.saved?.monthly.secondary ?? []);
    // 1. Target Master monthly overrides exist → use them.
    if (monthly.some((v) => v > 0)) return toDisplayValues(annual, monthly, cad);
    // 2. State HD plan available → roll up to the requested cadence as pre-fill.
    if (m.secMonthlyPlan) {
      const planVals = m.secMonthlyPlan.map((v) => v ?? 0);
      if (planVals.some((v) => v > 0)) return toDisplayValues(0, planVals, cad);
    }
    // 3. Annual target → distribute (or return 0 if no annual).
    if (annual > 0) return toDisplayValues(annual, [], cad);
    return Array<number>(CADENCE_LENGTHS[cad]).fill(0);
  }

  // Re-initialise edits from saved values whenever data or cadence changes.
  useEffect(() => {
    const next = new Map<string, string[]>();
    for (const m of members) {
      const displayVals = savedDisplayVals(m, cadence);
      next.set(m.name, displayVals.map((v) => (v > 0 ? fmtCr(v) : "")));
    }
    setEdits(next);
    setSaveSuccess(false);
    setSaveError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.data, cadence]);

  const handleChange = useCallback((name: string, idx: number, val: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const row = [...(next.get(name) ?? emptyEdits(cadence))];
      row[idx] = val;
      next.set(name, row);
      return next;
    });
    setSaveSuccess(false);
  }, [cadence]);

  const colLabels = CADENCE_LABELS[cadence];
  const colCount = CADENCE_LENGTHS[cadence];

  // Compute dirty count.
  const dirtyCount = members.filter((m) => {
    const savedDisplay = savedDisplayVals(m, cadence);
    const vals = edits.get(m.name) ?? emptyEdits(cadence);
    return vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
  }).length;

  const handleSave = async () => {
    setSaveError(null);
    setSaveSuccess(false);
    const rows = members
      .map((m) => {
        const savedDisplay = savedDisplayVals(m, cadence);
        const vals = edits.get(m.name) ?? emptyEdits(cadence);
        const isDirty = vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
        if (!isDirty) return null;

        const monthly = coerceMonthly(m.saved?.monthly.secondary ?? []);
        const parsedVals = vals.map((v) => parseCr(v));
        const newAnnual = parsedVals.reduce((s, v) => s + v, 0);

        // For monthly cadence, save the 12 monthly values; otherwise keep existing monthly.
        const newMonthly = cadence === "monthly" ? parsedVals : monthly;

        return {
          teamMember: m.name,
          annual: {
            primary: m.saved?.annual.primary ?? null,
            secondary: newAnnual > 0 ? newAnnual : null,
            directDealer: m.saved?.annual.directDealer ?? null,
            businessPlan: m.saved?.annual.businessPlan ?? null,
          },
          monthly: {
            primary: m.saved?.monthly.primary ?? [],
            secondary: newMonthly,
            directDealer: m.saved?.monthly.directDealer ?? [],
            businessPlan: m.saved?.monthly.businessPlan ?? [],
          },
        };
      })
      .filter(Boolean) as Parameters<typeof save.mutateAsync>[0]["data"]["rows"];

    if (rows.length === 0) return;
    try {
      await save.mutateAsync({ data: { fy, rows } });
      setSaveSuccess(true);
      await targets.refetch();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save. Try again.");
    }
  };

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-xl">Secondary Targets</CardTitle>
            <CardDescription className="mt-1">
              Secondary order booking targets per team member. Monthly cadence pre-fills from the State Head Dashboard plan figures (Apr-Jul actuals available). Save to lock in monthly values; other cadences distribute the annual total equally.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <select
              value={fy}
              onChange={(e) => { setFy(e.target.value); setSaveSuccess(false); }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {FYS.map((f) => (
                <option key={f} value={f}>FY {f}</option>
              ))}
            </select>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Cadence)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="annual">Annual</option>
              <option value="half_yearly">Half-Yearly</option>
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
            </select>
            {dirtyCount > 0 && (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={save.isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {save.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save {dirtyCount} change{dirtyCount !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>
        {saveSuccess && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" /> Targets saved.
          </p>
        )}
        {saveError && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> {saveError}
          </p>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-6">
        {targets.isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-10">S.No.</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">State Head</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">State</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Prior Year</th>
                  {colLabels.map((lbl) => (
                    <th key={lbl} className="px-2 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap">
                      {lbl}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m, idx) => {
                  const annual = m.saved?.annual.secondary ?? 0;
                  const monthlyArr = coerceMonthly(m.saved?.monthly.secondary ?? []);
                  const savedDisplay = annual > 0 || monthlyArr.length > 0
                    ? toDisplayValues(annual, monthlyArr, cadence)
                    : Array<number>(colCount).fill(0);
                  const vals = edits.get(m.name) ?? emptyEdits(cadence);
                  const isDirty = vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
                  const hasSaved = annual > 0;
                  return (
                    <tr key={m.name} className={`hover:bg-muted/30 transition-colors ${isDirty ? "bg-primary/5" : ""}`}>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums text-sm">{idx + 1}</td>
                      <td className="px-4 py-2 font-medium whitespace-nowrap">
                        {m.name}
                        {hasSaved && !isDirty && (
                          <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                            ₹{trunc2((annual / 1e7))} Cr
                          </span>
                        )}
                        {isDirty && <span className="ml-2 text-xs text-primary">edited</span>}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{m.stateHead}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.state}</td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">{fmtCrPrior(m.priorYearActual)}</td>
                      {vals.map((v, i) => (
                        <td key={i} className="px-2 py-1.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={v}
                            onChange={(e) => handleChange(m.name, i, e.target.value)}
                            placeholder={savedDisplay[i] ? fmtCr(savedDisplay[i]) : "0.00"}
                            className={`w-24 text-right rounded border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring bg-background ${
                              isDirty ? "border-primary" : "border-input"
                            }`}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {members.length === 0 && !targets.isLoading && (
                  <tr>
                    <td colSpan={5 + colCount} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No team members found for FY {fy}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 mt-3 text-xs text-muted-foreground">
          Enter targets in crores (e.g. 0.60 for ₹60 Lakh). Values entered in monthly cadence are stored per-month; other cadences split the annual total equally across months.
        </p>
      </CardContent>
    </Card>
  );
}
