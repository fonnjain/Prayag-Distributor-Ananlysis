import { useState, useEffect, useCallback } from "react";
import { Loader2, Save, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  useGetPrimaryTargets,
  useSavePrimaryTargets,
} from "@workspace/api-client-react";

type Cadence = "annual" | "half_yearly" | "quarterly" | "monthly";
type Role = "state_head" | "team_member";

const FYS = ["2026-27", "2025-26", "2024-25"];

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

function toDisplayValues(monthly: number[], cadence: Cadence): number[] {
  const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  if (cadence === "annual") return [sum(monthly)];
  if (cadence === "half_yearly") return [sum(monthly.slice(0, 6)), sum(monthly.slice(6, 12))];
  if (cadence === "quarterly") return [
    sum(monthly.slice(0, 3)),
    sum(monthly.slice(3, 6)),
    sum(monthly.slice(6, 9)),
    sum(monthly.slice(9, 12)),
  ];
  return [...monthly];
}

function fmtCr(n: number): string {
  if (!n || n === 0) return "";
  return (n / 1e7).toFixed(2);
}

function parseCr(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 1e7) : 0;
}

function annualCr(monthly: number[]): string {
  const total = monthly.reduce((s, v) => s + v, 0);
  return total > 0 ? (total / 1e7).toFixed(2) : "—";
}

function emptyEdits(cadence: Cadence): string[] {
  return Array<string>(CADENCE_LENGTHS[cadence]).fill("");
}

interface RowProps {
  serialNo: number;
  name: string;
  role: Role;
  cadence: Cadence;
  savedMonthly: number[] | null;
  vals: string[];
  onChange: (name: string, idx: number, val: string) => void;
}

function TargetRow({ serialNo, name, role: _role, cadence, savedMonthly, vals, onChange }: RowProps) {
  const savedDisplay = savedMonthly ? toDisplayValues(savedMonthly, cadence) : [];
  const isDirty = vals.some((v, i) => {
    const saved = savedDisplay[i] ?? 0;
    return parseCr(v) !== saved;
  });
  const hasSaved = savedMonthly != null && savedMonthly.some((v) => v > 0);

  return (
    <tr className={`hover:bg-muted/30 transition-colors ${isDirty ? "bg-primary/5" : ""}`}>
      <td className="px-3 py-2 text-muted-foreground tabular-nums text-sm w-10">{serialNo}</td>
      <td className="px-3 py-2 font-medium text-sm whitespace-nowrap">
        {name}
        {hasSaved && !isDirty && (
          <span className="ml-2 text-xs text-muted-foreground tabular-nums">
            ₹{annualCr(savedMonthly!)} Cr
          </span>
        )}
        {isDirty && (
          <span className="ml-2 text-xs text-primary">edited</span>
        )}
      </td>
      {vals.map((v, i) => (
        <td key={i} className="px-2 py-1.5">
          <input
            type="text"
            inputMode="decimal"
            value={v}
            onChange={(e) => onChange(name, i, e.target.value)}
            placeholder={savedDisplay[i] ? fmtCr(savedDisplay[i]) : "0.00"}
            className={`w-24 text-right rounded border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring bg-background ${
              isDirty ? "border-primary" : "border-input"
            }`}
          />
        </td>
      ))}
    </tr>
  );
}

interface GroupTableProps {
  title: string;
  names: string[];
  role: Role;
  cadence: Cadence;
  savedMap: Map<string, number[]>;
  edits: Map<string, string[]>;
  onChange: (name: string, idx: number, val: string) => void;
}

function GroupTable({ title, names, role, cadence, savedMap, edits, onChange }: GroupTableProps) {
  if (names.length === 0) return null;
  const colLabels = CADENCE_LABELS[cadence];

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
        {title}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-10">S.No.</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
              {colLabels.map((lbl) => (
                <th key={lbl} className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">
                  {lbl}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {names.map((name, idx) => (
              <TargetRow
                key={name}
                serialNo={idx + 1}
                name={name}
                role={role}
                cadence={cadence}
                savedMonthly={savedMap.get(name) ?? null}
                vals={edits.get(name) ?? emptyEdits(cadence)}
                onChange={onChange}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PrimaryTargetsEntry() {
  const [fy, setFy] = useState("2026-27");
  const [cadence, setCadence] = useState<Cadence>("annual");
  const [edits, setEdits] = useState<Map<string, string[]>>(new Map());
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const data = useGetPrimaryTargets({ fy });
  const save = useSavePrimaryTargets();

  // Re-initialise edits from saved values whenever data or cadence changes.
  useEffect(() => {
    if (!data.data) return;
    const next = new Map<string, string[]>();
    for (const entry of data.data.entries) {
      const displayVals = toDisplayValues(entry.monthlyExpanded ?? [], cadence);
      const strs = displayVals.map((v) => (v > 0 ? fmtCr(v) : ""));
      next.set(entry.name, strs);
    }
    setEdits(next);
    setSaveSuccess(false);
    setSaveError(null);
  }, [data.data, cadence]);

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

  // Build saved monthly map for quick lookup.
  const savedMap = new Map<string, number[]>();
  if (data.data) {
    for (const e of data.data.entries) {
      savedMap.set(e.name, e.monthlyExpanded ?? []);
    }
  }

  // Compute dirty count.
  let dirtyCount = 0;
  if (data.data) {
    const allNames = [
      ...(data.data.stateHeads ?? []),
      ...(data.data.teamMembers ?? []),
    ];
    for (const name of allNames) {
      const vals = edits.get(name) ?? emptyEdits(cadence);
      const savedMonthly = savedMap.get(name);
      const savedDisplay = savedMonthly ? toDisplayValues(savedMonthly, cadence) : [];
      if (vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0))) dirtyCount++;
    }
  }

  const handleSave = async () => {
    if (!data.data) return;
    setSaveError(null);

    const stateHeadSet = new Set(data.data.stateHeads ?? []);
    const allNames = [
      ...(data.data.stateHeads ?? []),
      ...(data.data.teamMembers ?? []),
    ];

    const rows: Array<{ name: string; role: Role; cadence: Cadence; values: number[] }> = [];

    for (const name of allNames) {
      const vals = edits.get(name) ?? emptyEdits(cadence);
      const savedMonthly = savedMap.get(name);
      const savedDisplay = savedMonthly ? toDisplayValues(savedMonthly, cadence) : [];
      const isDirty = vals.some((v, i) => parseCr(v) !== (savedDisplay[i] ?? 0));
      if (!isDirty) continue;

      const values = vals.map((v) => parseCr(v));
      rows.push({
        name,
        role: stateHeadSet.has(name) ? "state_head" : "team_member",
        cadence,
        values,
      });
    }

    if (rows.length === 0) return;

    try {
      await save.mutateAsync({ data: { fy, rows } });
      setSaveSuccess(true);
      await data.refetch();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save. Try again.");
    }
  };

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-xl">Primary Targets</CardTitle>
            <CardDescription className="mt-1">
              Annual primary sale targets for State Heads and Primary Team Members, split by season. Stored in the database, independent of the Google Sheets Target Master.
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
        {data.data?.seasonalCalibration && (
          <div className="mt-4 rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground/80 mb-2">
              Seasonal Calibration — Primary Target Splitting
            </p>
            <div className="grid grid-cols-6 gap-x-3 gap-y-1 mb-2">
              {data.data.seasonalCalibration.monthNames.map((m, i) => (
                <div key={m} className="flex flex-col items-center">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{m}</span>
                  <span className="font-mono text-foreground/70">
                    {((data.data!.seasonalCalibration!.monthly[i] ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-4 flex-wrap border-t border-border/40 pt-2">
              {(["Q1", "Q2", "Q3", "Q4"] as const).map((q, i) => (
                <span key={q}>
                  <span className="text-muted-foreground/70">{q}</span>{" "}
                  <span className="font-mono text-foreground/70">
                    {((data.data!.seasonalCalibration!.quarterly[i] ?? 0) * 100).toFixed(1)}%
                  </span>
                </span>
              ))}
              <span className="ml-auto text-muted-foreground/60 italic">
                Calibrated from FY{data.data.seasonalCalibration.fy} retail actuals. Institutional/tender targets are not seasonalised.
              </span>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-6">
        {data.isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading roster...
          </div>
        ) : data.isError ? (
          <p className="px-6 py-6 text-sm text-destructive">
            Could not load roster for FY {fy}. The State Head Dashboard must be uploaded first.
          </p>
        ) : (
          <div className="space-y-8">
            <GroupTable
              title="State Heads"
              names={data.data?.stateHeads ?? []}
              role="state_head"
              cadence={cadence}
              savedMap={savedMap}
              edits={edits}
              onChange={handleChange}
            />
            <GroupTable
              title="Primary Team Members"
              names={data.data?.teamMembers ?? []}
              role="team_member"
              cadence={cadence}
              savedMap={savedMap}
              edits={edits}
              onChange={handleChange}
            />
            {(data.data?.stateHeads ?? []).length === 0 &&
              (data.data?.teamMembers ?? []).length === 0 && (
              <p className="px-6 py-6 text-sm text-muted-foreground text-center">
                No roster found for FY {fy}. Upload the STATE HEAD DASHBOARD xlsx first.
              </p>
            )}
          </div>
        )}
        <p className="px-4 mt-4 text-xs text-muted-foreground">
          Enter targets in crores (e.g. 164.22 for ₹164.22 Cr). Values are split seasonally across months when saved.
          Blank rows are ignored. These targets override the xlsx-imported primary targets in all management reports.
        </p>
      </CardContent>
    </Card>
  );
}
