import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "@/data/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, Database, FolderGit2, CheckCircle2, Clock, Save, Loader2, AlertTriangle } from "lucide-react";
import {
  useGetTargets,
  useSaveTargets,
  type TargetsMember,
} from "@workspace/api-client-react";
import DataHealth from "./DataHealth";
import PrimaryTargetsEntry from "./PrimaryTargetsEntry";

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
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtCr(n: number): string {
  if (!n || n === 0) return "";
  return (n / 1e7).toFixed(2);
}

function parseCr(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 1e7) : 0;
}

function toDisplayValues(annualRupees: number, monthlyArr: number[], cadence: Cadence): number[] {
  const n = CADENCE_LENGTHS[cadence];
  if (cadence === "monthly" && monthlyArr.length === 12) return [...monthlyArr];
  const perPeriod = annualRupees / n;
  if (cadence === "annual") return [annualRupees];
  if (cadence === "half_yearly") return [perPeriod, perPeriod];
  if (cadence === "quarterly") return [perPeriod, perPeriod, perPeriod, perPeriod];
  return Array(12).fill(perPeriod);
}

function emptyEdits(cadence: Cadence): string[] {
  return Array<string>(CADENCE_LENGTHS[cadence]).fill("");
}

function coerceMonthly(arr: (number | null)[]): number[] {
  return arr.map((v) => v ?? 0);
}

function TargetEditor() {
  const [fy, setFy] = useState(FYS[0]);
  const [cadence, setCadence] = useState<Cadence>("annual");
  const targets = useGetTargets({ fy });
  const save = useSaveTargets();
  const [edits, setEdits] = useState<Map<string, string[]>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const members: TargetsMember[] = targets.data?.members ?? [];

  // Re-initialise edits from saved values whenever data or cadence changes.
  useEffect(() => {
    const next = new Map<string, string[]>();
    for (const m of members) {
      const annual = m.saved?.annual.secondary ?? 0;
      const monthly = coerceMonthly(m.saved?.monthly.secondary ?? []);
      const displayVals = annual > 0 || monthly.length > 0
        ? toDisplayValues(annual, monthly, cadence)
        : Array<number>(CADENCE_LENGTHS[cadence]).fill(0);
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
    const annual = m.saved?.annual.secondary ?? 0;
    const monthly = coerceMonthly(m.saved?.monthly.secondary ?? []);
    const savedDisplay = annual > 0 || monthly.length > 0
      ? toDisplayValues(annual, monthly, cadence)
      : Array<number>(colCount).fill(0);
    const vals = edits.get(m.name) ?? emptyEdits(cadence);
    return vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
  }).length;

  const handleSave = async () => {
    setSaveError(null);
    setSaveSuccess(false);
    const rows = members
      .map((m) => {
        const annual = m.saved?.annual.secondary ?? 0;
        const monthly = coerceMonthly(m.saved?.monthly.secondary ?? []);
        const savedDisplay = annual > 0 || monthly.length > 0
          ? toDisplayValues(annual, monthly, cadence)
          : Array<number>(colCount).fill(0);
        const vals = edits.get(m.name) ?? emptyEdits(cadence);
        const isDirty = vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
        if (!isDirty) return null;

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
              Annual secondary order booking targets per team member. Stored in the database and applied across all management reports.
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
                            ₹{(annual / 1e7).toFixed(2)} Cr
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

export default function DataSources() {
  const { manifest } = useDashboard();
  const generatedDate = new Date(manifest.generated);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <DataHealth />

      {/* Editable primary targets */}
      <PrimaryTargetsEntry />

      {/* Editable secondary targets */}
      <TargetEditor />

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            Dataset Provenance
          </CardTitle>
          <CardDescription>
            Transparency audit of all source files merged into this intelligence view.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-8">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-4 h-4" /> Last Generated
              </p>
              <p className="text-sm font-medium">{generatedDate.toLocaleString()}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <FolderGit2 className="w-4 h-4" /> Source Drive
              </p>
              <p className="text-sm font-medium truncate" title={manifest.drive_account}>{manifest.drive_account}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Pipeline Status
              </p>
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Validated & Normalized</p>
            </div>
          </div>

          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4">Primary Sources</h3>
              <div className="grid gap-3">
                {Object.entries(manifest.primary_sources).map(([key, source]) => (
                  <div key={key} className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-background/50">
                    <FileText className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{key.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{source.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-8">
              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-purple-500"></span> Sales Data Files
                </h3>
                <ul className="space-y-2">
                  {manifest.sales_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.fy})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span> Orders & Support
                </h3>
                <ul className="space-y-2">
                  {manifest.order_and_support_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.period})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {manifest.notes && manifest.notes.length > 0 && (
              <div className="pt-4 border-t border-border/50">
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-3">Processing Notes</h3>
                <ul className="space-y-2">
                  {manifest.notes.map((note, i) => (
                    <li key={i} className="text-sm text-muted-foreground italic">
                      Note: {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
