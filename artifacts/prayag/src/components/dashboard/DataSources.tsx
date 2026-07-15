import { lazy, Suspense, useState, useCallback } from "react";
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

const DashboardUploadPanel = lazy(() => import("./DashboardUploadPanel"));

const FYS = ["2026-27", "2025-26"];

function fmtCr(n: number | null | undefined): string {
  if (n == null) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function toNum(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function TargetEditor() {
  const [fy, setFy] = useState(FYS[0]);
  const targets = useGetTargets({ fy });
  const save = useSaveTargets();
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const members: TargetsMember[] = targets.data?.members ?? [];

  const getValue = useCallback(
    (m: TargetsMember) => {
      if (edits.has(m.name)) return edits.get(m.name)!;
      const v = m.saved?.annual.secondary;
      return v == null ? "" : String(v);
    },
    [edits],
  );

  const setValue = (name: string, v: string) => {
    setSaveSuccess(false);
    setEdits((prev) => new Map(prev).set(name, v));
  };

  const dirtyCount = [...edits.entries()].filter(([name, val]) => {
    const member = members.find((m) => m.name === name);
    if (!member) return false;
    const savedVal = member.saved?.annual.secondary;
    const editedNum = toNum(val);
    return editedNum !== (savedVal ?? null);
  }).length;

  const handleSave = async () => {
    setSaveError(null);
    setSaveSuccess(false);
    const rows = members
      .map((m) => {
        const raw = getValue(m);
        const secondary = toNum(raw);
        const saved = m.saved?.annual.secondary ?? null;
        if (secondary === saved) return null;
        return {
          teamMember: m.name,
          annual: {
            primary: m.saved?.annual.primary ?? null,
            secondary,
            directDealer: m.saved?.annual.directDealer ?? null,
            businessPlan: m.saved?.annual.businessPlan ?? null,
          },
          monthly: {
            primary: m.saved?.monthly.primary ?? [],
            secondary: m.saved?.monthly.secondary ?? [],
            directDealer: m.saved?.monthly.directDealer ?? [],
            businessPlan: m.saved?.monthly.businessPlan ?? [],
          },
        };
      })
      .filter(Boolean) as Parameters<typeof save.mutateAsync>[0]["data"]["rows"];

    if (rows.length === 0) return;
    try {
      await save.mutateAsync({ data: { fy, rows } });
      setEdits(new Map());
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
              Annual secondary order booking targets per team member. Edits write to the Prayag Target Master and override the xlsx import values.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <select
              value={fy}
              onChange={(e) => { setFy(e.target.value); setEdits(new Map()); setSaveSuccess(false); }}
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
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">State Head</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">State</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Prior Year</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Secondary Target (Annual, ₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => {
                  const val = getValue(m);
                  const savedVal = m.saved?.annual.secondary ?? null;
                  const editedNum = toNum(val);
                  const isDirty = editedNum !== savedVal;
                  return (
                    <tr key={m.name} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2 font-medium">{m.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.stateHead}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.state}</td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">{fmtCr(m.priorYearActual)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-2">
                          {isDirty && savedVal != null && (
                            <span className="text-xs text-muted-foreground tabular-nums line-through">
                              {fmtCr(savedVal)}
                            </span>
                          )}
                          <input
                            type="text"
                            inputMode="numeric"
                            value={val}
                            onChange={(e) => setValue(m.name, e.target.value)}
                            placeholder="e.g. 6000000"
                            className={`w-36 text-right rounded border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring bg-background ${
                              isDirty ? "border-primary" : "border-input"
                            }`}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && !targets.isLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No team members found for FY {fy}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 mt-3 text-xs text-muted-foreground">
          Enter annual target in rupees (e.g. 6000000 for ₹60 Lakh). Blank clears the saved target.
          The Prayag Target Master overrides the xlsx import when both are present.
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

      {/* Dashboard xlsx import — moved from State Head > Settings */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl">Dashboard Import</CardTitle>
          <CardDescription>
            Upload the STATE HEAD DASHBOARD xlsx file for each fiscal year. Populates targets, CTC, designation, and stateHead assignments.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <Suspense fallback={<div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}>
            <DashboardUploadPanel />
          </Suspense>
        </CardContent>
      </Card>

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
