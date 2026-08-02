import { useMemo, useState } from "react";
import {
  useGetTargets,
  useSaveTargets,
  getTargetSplitPreview,
  type TargetsMember,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import PrimaryStateTargetsEditor from "./PrimaryStateTargetsEditor";
import SecondaryTargetsEditor from "./SecondaryTargetsEditor";
import {
  Target,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Wand2,
  Save,
} from "lucide-react";

const FISCAL_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];

const FYS = ["2026-27", "2025-26"];

const FIELDS = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "directDealer", label: "Direct Dealer" },
  { key: "businessPlan", label: "Business Plan" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

type RowEdit = {
  annual: Record<FieldKey, string>;
  monthly: Record<FieldKey, string[]>;
};

function emptyEdit(): RowEdit {
  return {
    annual: { primary: "", secondary: "", directDealer: "", businessPlan: "" },
    monthly: {
      primary: Array(12).fill(""),
      secondary: Array(12).fill(""),
      directDealer: Array(12).fill(""),
      businessPlan: Array(12).fill(""),
    },
  };
}

function editFromSaved(m: TargetsMember): RowEdit {
  const e = emptyEdit();
  if (m.saved) {
    for (const f of FIELDS) {
      const a = m.saved.annual[f.key];
      e.annual[f.key] = a == null ? "" : String(a);
      const mo = m.saved.monthly[f.key] ?? [];
      e.monthly[f.key] = Array.from({ length: 12 }, (_, i) =>
        mo[i] == null ? "" : String(mo[i]),
      );
    }
  }
  return e;
}

function toNum(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function inr(n: number): string {
  return n.toLocaleString("en-IN");
}

export default function Targets() {
  const [fy, setFy] = useState(FYS[0]);
  const targets = useGetTargets({ fy });
  const save = useSaveTargets();

  const [head, setHead] = useState("");
  const [mode, setMode] = useState<"split" | "direct">("split");
  const [search, setSearch] = useState("");
  const [totals, setTotals] = useState<Record<FieldKey, string>>({
    primary: "", secondary: "", directDealer: "", businessPlan: "",
  });
  const [edits, setEdits] = useState<Map<string, RowEdit>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = targets.data;
  const stateHeads = data?.stateHeads ?? [];
  const effectiveHead = head || stateHeads[0] || "";

  const members = useMemo(
    () => (data?.members ?? []).filter((m) => m.stateHead === effectiveHead),
    [data, effectiveHead],
  );

  const editFor = (m: TargetsMember): RowEdit => edits.get(m.name) ?? editFromSaved(m);

  const setRow = (name: string, next: RowEdit) => {
    setEdits((prev) => {
      const map = new Map(prev);
      map.set(name, next);
      return map;
    });
    setNotice(null);
  };

  const setAnnual = (m: TargetsMember, f: FieldKey, v: string) => {
    const e = editFor(m);
    setRow(m.name, { ...e, annual: { ...e.annual, [f]: v } });
  };

  const setMonthly = (m: TargetsMember, f: FieldKey, i: number, v: string) => {
    const e = editFor(m);
    const arr = [...e.monthly[f]];
    arr[i] = v;
    setRow(m.name, { ...e, monthly: { ...e.monthly, [f]: arr } });
  };

  // Per-field reconciliation of the member column sums against the entered
  // State Head totals. Mismatched fields block the save.
  const reconcile = useMemo(() => {
    return FIELDS.map((f) => {
      const total = toNum(totals[f.key]);
      if (total == null) return { field: f, total: null, sum: 0, ok: true };
      let sum = 0;
      for (const m of members) {
        const v = toNum(editFor(m).annual[f.key]);
        if (v != null) sum += v;
      }
      return { field: f, total, sum, ok: Math.round(sum) === Math.round(total) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totals, members, edits]);

  const blocked = mode === "split" && reconcile.some((r) => !r.ok);

  const visibleMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, search]);

  const computeSplit = async () => {
    setError(null);
    setNotice(null);
    const params: Record<string, string | number> = { fy, stateHead: effectiveHead };
    let any = false;
    for (const f of FIELDS) {
      const v = toNum(totals[f.key]);
      if (v != null) {
        params[f.key] = v;
        any = true;
      }
    }
    if (!any) {
      setError("Enter at least one State Head total to split.");
      return;
    }
    setSplitting(true);
    try {
      const preview = await getTargetSplitPreview(params as never);
      const newJoiners = preview.members.filter((m) => m.basis === "equal-share");
      setEdits((prev) => {
        const map = new Map(prev);
        for (const sm of preview.members) {
          const member = members.find((m) => m.name === sm.name);
          const base = member ? (map.get(sm.name) ?? editFromSaved(member)) : emptyEdit();
          const annual = { ...base.annual };
          for (const f of FIELDS) {
            const v = sm.allocated[f.key];
            if (v != null) annual[f.key] = String(v);
          }
          map.set(sm.name, { ...base, annual });
        }
        return map;
      });
      setNotice(
        newJoiners.length > 0
          ? `Split applied. ${newJoiners.length} member${newJoiners.length === 1 ? " has" : "s have"} no prior-year history (new joiner) and received an equal per-head share instead of zero — adjust if needed, then save.`
          : "Split applied. Adjust any member, then save.",
      );
    } catch (e) {
      setError(extractError(e, "Could not compute the split. Try again in a minute."));
    } finally {
      setSplitting(false);
    }
  };

  const revert = () => {
    setEdits((prev) => {
      const map = new Map(prev);
      for (const m of members) map.delete(m.name);
      return map;
    });
    setError(null);
    setNotice("Reverted to the last saved values.");
  };

  const doSave = async () => {
    setError(null);
    setNotice(null);
    const rows = members
      .map((m) => {
        const e = editFor(m);
        const annual: Record<FieldKey, number | null> = {
          primary: toNum(e.annual.primary),
          secondary: toNum(e.annual.secondary),
          directDealer: toNum(e.annual.directDealer),
          businessPlan: toNum(e.annual.businessPlan),
        };
        const monthly: Record<FieldKey, Array<number | null>> = {
          primary: e.monthly.primary.map(toNum),
          secondary: e.monthly.secondary.map(toNum),
          directDealer: e.monthly.directDealer.map(toNum),
          businessPlan: e.monthly.businessPlan.map(toNum),
        };
        const hasValue =
          FIELDS.some((f) => annual[f.key] != null) ||
          FIELDS.some((f) => monthly[f.key].some((v) => v != null));
        const changed = edits.has(m.name) || m.saved != null;
        return hasValue && changed ? { teamMember: m.name, annual, monthly } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r != null);
    if (rows.length === 0) {
      setError("Nothing to save yet. Enter targets or compute a split first.");
      return;
    }
    try {
      const result = await save.mutateAsync({ data: { fy, rows } });
      setNotice(
        `Saved ${result.updated + result.appended} member${result.updated + result.appended === 1 ? "" : "s"}. Values are stored in the database and picked up by reports immediately.`,
      );
      setEdits((prev) => {
        const map = new Map(prev);
        for (const m of members) map.delete(m.name);
        return map;
      });
      await targets.refetch();
    } catch (e) {
      setError(extractError(e, "Could not save targets. Try again in a minute."));
    }
  };

  if (targets.isLoading || targets.isError || !data) {
    // Member section is still loading (or failed) — the two editors above are
    // independent sections and should render regardless.
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
        <PrimaryStateTargetsEditor />
        <SecondaryTargetsEditor />
        {targets.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading roster and member targets
          </div>
        ) : (
          <div className="py-16 text-center text-sm text-destructive">
            Could not load member targets. Please refresh the page.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
      {/* Section 1 — State Head Targets: PRIMARY sale target, per head, per month,
          in Lakh, stored in the database (primary_state_targets), writable. */}
      <PrimaryStateTargetsEditor />

      {/* Section 2 — Secondary Targets: secondary order booking per team member,
          entered at a chosen cadence. Different measure and level from section 1;
          neither is a breakdown of the other. */}
      <SecondaryTargetsEditor />

      {/* Section 3 — Member Targets: four measures per member, annual + monthly,
          from the Target Master sheet. */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <Target className="w-5 h-5 text-primary" />
            Member Targets
          </CardTitle>
          <CardDescription>
            Four measures per team member (Primary / Secondary / Direct Dealer /
            Business Plan), annual with monthly overrides, stored in the
            database. Enter directly, or enter State Head totals and split them
            pro-rata by last year&apos;s actuals (new joiners with no history get
            an equal per-head share). Note: these are member-level figures across
            four measures — not a breakdown of the State Head Targets grid above,
            which is the monthly primary target per head.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium block mb-1.5">Fiscal year</label>
              <select
                value={fy}
                onChange={(e) => { setFy(e.target.value); setEdits(new Map()); }}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              >
                {FYS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="text-sm font-medium block mb-1.5">State Head</label>
              <select
                value={effectiveHead}
                onChange={(e) => { setHead(e.target.value); setExpanded(null); }}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              >
                {stateHeads.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-md border border-border/50 p-0.5 text-sm">
              <button
                onClick={() => setMode("split")}
                className={cn(
                  "px-3 py-1.5 rounded font-medium transition-colors",
                  mode === "split" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                State-Head split
              </button>
              <button
                onClick={() => setMode("direct")}
                className={cn(
                  "px-3 py-1.5 rounded font-medium transition-colors",
                  mode === "direct" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Per-member entry
              </button>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search team member"
              className="h-9 w-full sm:w-64 rounded-md border border-border/50 bg-background px-3 text-sm"
            />
          </div>

          {mode === "split" && (
          <div>
            <p className="text-sm font-medium mb-1.5">
              State Head totals <span className="text-xs text-muted-foreground font-normal">(annual, rupees — optional)</span>
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="text-xs text-muted-foreground block mb-1">{f.label}</label>
                  <input
                    inputMode="numeric"
                    value={totals[f.key]}
                    onChange={(e) => setTotals((p) => ({ ...p, [f.key]: e.target.value }))}
                    placeholder="0"
                    className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                onClick={computeSplit}
                disabled={splitting}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {splitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Compute pro-rata split
              </button>
              <button
                onClick={revert}
                className="px-4 py-2 rounded-md border border-border/50 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
              >
                Revert to saved
              </button>
            </div>
          </div>
          )}
          {mode === "direct" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Enter targets directly per member; no State-Head total or reconciliation applies.
              </p>
              <button
                onClick={revert}
                className="px-3 py-1.5 rounded-md border border-border/50 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
              >
                Revert to saved
              </button>
            </div>
          )}

          {mode === "split" && (
          <div className="grid gap-2 sm:grid-cols-4">
            {reconcile.map((r) => (
              <div
                key={r.field.key}
                className={cn(
                  "rounded-md border p-2.5 text-xs",
                  r.total == null
                    ? "border-border/40 text-muted-foreground"
                    : r.ok
                      ? "border-green-500/40 text-green-700 dark:text-green-400"
                      : "border-destructive/50 text-destructive",
                )}
              >
                <p className="font-medium flex items-center gap-1.5">
                  {r.total != null && (r.ok
                    ? <CheckCircle2 className="w-3.5 h-3.5" />
                    : <AlertTriangle className="w-3.5 h-3.5" />)}
                  {r.field.label}
                </p>
                {r.total == null ? (
                  <p>No total entered</p>
                ) : (
                  <p>
                    Members {inr(r.sum)} / Total {inr(r.total)}
                    {!r.ok && ` (off by ${inr(Math.abs(r.total - r.sum))})`}
                  </p>
                )}
              </div>
            ))}
          </div>
          )}

          {error && (
            <div className="text-sm text-destructive border border-destructive/30 rounded-md p-3">{error}</div>
          )}
          {notice && !error && (
            <div className="text-sm text-green-700 dark:text-green-400 border border-green-500/30 rounded-md p-3">{notice}</div>
          )}

          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border/50">
                  <th className="py-2 pr-2 font-medium">Team member</th>
                  <th className="py-2 pr-2 font-medium text-right">Last FY actual</th>
                  {FIELDS.map((f) => (
                    <th key={f.key} className="py-2 pr-2 font-medium text-right">{f.label}</th>
                  ))}
                  <th className="py-2 font-medium">Saved</th>
                </tr>
              </thead>
              <tbody>
                {visibleMembers.map((m) => {
                  const e = editFor(m);
                  const open = expanded === m.name;
                  return (
                    <MemberRows
                      key={m.name}
                      member={m}
                      edit={e}
                      open={open}
                      onToggle={() => setExpanded(open ? null : m.name)}
                      onAnnual={(f, v) => setAnnual(m, f, v)}
                      onMonthly={(f, i, v) => setMonthly(m, f, i, v)}
                    />
                  );
                })}
                {visibleMembers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      No team members match the search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <button
            onClick={doSave}
            disabled={save.isPending || blocked}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {save.isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Saving</>
            ) : (
              <><Save className="w-4 h-4" /> Save targets</>
            )}
          </button>
          {blocked && (
            <p className="text-xs text-destructive">
              Member totals must match the entered State Head totals before saving.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MemberRows({
  member,
  edit,
  open,
  onToggle,
  onAnnual,
  onMonthly,
}: {
  member: TargetsMember;
  edit: RowEdit;
  open: boolean;
  onToggle: () => void;
  onAnnual: (f: FieldKey, v: string) => void;
  onMonthly: (f: FieldKey, i: number, v: string) => void;
}) {
  return (
    <>
      <tr className="border-b border-border/30">
        <td className="py-2 pr-2">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-left font-medium hover:text-primary transition-colors">
            {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
            <span>
              {member.name}
              <span className="block text-xs text-muted-foreground font-normal">
                {member.headquarter || member.state}
              </span>
            </span>
          </button>
        </td>
        <td className="py-2 pr-2 text-right text-muted-foreground tabular-nums">
          {member.priorYearActual > 0 ? inr(Math.round(member.priorYearActual)) : "—"}
        </td>
        {FIELDS.map((f) => (
          <td key={f.key} className="py-2 pr-2">
            <input
              inputMode="numeric"
              value={edit.annual[f.key]}
              onChange={(e) => onAnnual(f.key, e.target.value)}
              placeholder="—"
              className="w-full min-w-[92px] h-8 rounded border border-border/40 bg-background px-2 text-sm text-right tabular-nums"
            />
          </td>
        ))}
        <td className="py-2 text-xs text-muted-foreground whitespace-nowrap">
          {member.saved ? (
            <span title={`${member.saved.updatedBy} ${member.saved.updatedAt}`}>
              {member.saved.updatedAt.slice(0, 10)}
            </span>
          ) : (
            "—"
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/30 bg-muted/30">
          <td colSpan={7} className="py-3 px-2">
            <p className="text-xs text-muted-foreground mb-2">
              Monthly overrides (blank months use an equal twelfth of the annual figure; overrides must total the annual)
            </p>
            <div className="space-y-2 overflow-x-auto">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-1.5 min-w-[900px]">
                  <span className="text-xs font-medium w-24 shrink-0">{f.label}</span>
                  {FISCAL_MONTHS.map((mo, i) => (
                    <div key={mo} className="flex-1">
                      <span className="block text-[10px] text-muted-foreground text-center">{mo}</span>
                      <input
                        inputMode="numeric"
                        value={edit.monthly[f.key][i]}
                        onChange={(e) => onMonthly(f.key, i, e.target.value)}
                        className="w-full h-7 rounded border border-border/40 bg-background px-1 text-xs text-right tabular-nums"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function extractError(e: unknown, fallback: string): string {
  if (
    e && typeof e === "object" && "data" in e &&
    e.data && typeof e.data === "object" && "error" in e.data &&
    typeof (e.data as { error?: unknown }).error === "string"
  ) {
    return (e.data as { error: string }).error;
  }
  return fallback;
}
