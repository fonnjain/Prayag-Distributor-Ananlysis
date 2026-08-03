import { trunc2, trunc2IN } from "@/lib/trunc";
// C2 — Comparison Deep Dive: trajectory (Mode A) and peer (Mode B) views.
// NO NEW COMPUTATION — this page calls POST /api/comparison and renders what
// comes back, including its refusals. A refusal is a result, not an error.
// If a figure is not in the API response, it does not appear on screen.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, Info, Plus, Printer, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── API types (mirror of the C1 contract) ────────────────────────────────────
type PeriodSpec = {
  kind: "month" | "quarter" | "fy" | "ytd" | "custom";
  fy: string;
  month?: number;
  quarter?: number;
  monthFrom?: number;
  monthTo?: number;
};
type MeasureDef = { id: string; label: string; money: boolean; sources: string[] | null };
type GuardResult = { id: number; name: string; status: "pass" | "annotated" | "blocked" | "notApplicable"; detail: string | null; data?: unknown };
type TrendMeta = {
  level: number | null; levelPeriod: string | null; levelIsPartial?: boolean;
  direction: number | null; directionBasis: string | null;
  usedPeriods: string[]; excludedPeriods: { label: string; reason: string }[];
};
type QuadrantView = {
  measure: string; measureLabel: string; levelSplit: number; splitRule: string;
  groups: { quadrant: string; label: string; entities: { entity: string; level: number; direction: number }[] }[];
  noDirection: { entity: string; reason: string }[];
};
type RosterChange = { entity: string; fromFy: string; toFy: string; joiners: string[]; leavers: string[]; note: string };
type CohortGroup = { name: string; population: number; value: number | null; valueLabel: string; note?: string };
type CohortSuggestion = { rank: number; kind: string; action: string; evidence: string; caveats: string[] };
type CohortResult = {
  blocked: false;
  basis: { rule: string; ruleDetail: string; fy: string; channel: string; channelLabel: string; readings: string[] };
  cohorts: CohortGroup[];
  difference?: { value: number | null; label: string; sampleNote: string };
  correlation?: { r: number | null; n: number; suppressed: boolean; note: string };
  suggestions?: CohortSuggestion[];
  notes: string[];
};
type Suggestion = { rank: number; kind: string; entity: string; measure?: string; measureLabel?: string; action: string; evidence: string; level?: number; direction?: number; caveats: string[] };
type CellValue = { value: number | string | null; real?: number | null; realIndex?: number | null; realIndexName?: string | null; note?: string | null; suppressed?: boolean };
type MatrixRow = { entity: string; measure: string; measureLabel: string; source: string | null; excludeFromRanking?: boolean; flags?: string[]; rankEligible?: boolean; rankBlockReason?: string | null; cells: CellValue[]; trend?: TrendMeta; };
type BasisBlock = {
  entityType?: string; basis?: string; channel?: string; channelLabel?: string;
  population?: string; normalise?: string;
  periods?: { label: string; fy: string; completeness: string; months: string[] }[];
  sources?: Record<string, string>;
};
type OkResponse = {
  blocked: false; basis: Required<BasisBlock>; guards: GuardResult[]; matrix: MatrixRow[]; quadrants?: QuadrantView[]; rosterChanges?: RosterChange[]; suggestions?: Suggestion[];
  likeForLike?: { entity: string; headlineAchievement: number | null; likeForLikeAchievement: number | null; untargetedMembers: string[] }[];
  notes: string[];
};
type BlockedResponse = { blocked: true; reason: string; guards: GuardResult[]; basis: BasisBlock };
type ApiResult = OkResponse | BlockedResponse;

const ENTITY_TYPES = ["company", "head", "member", "distributor", "retailer", "segment", "code"] as const;
const CHANNELS = ["territory", "project", "all"] as const;
const NORMALISE = ["absolute", "perElapsedMonth", "perWorkingDay", "perRetailer", "perVisit", "realTerms"] as const;
const NORMALISE_LABEL: Record<string, string> = {
  absolute: "Absolute", perElapsedMonth: "Per elapsed month", perWorkingDay: "Per working day",
  perRetailer: "Per retailer", perVisit: "Per visit", realTerms: "Real terms",
};
const FISCAL_MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const FYS = ["2026-27", "2025-26", "2024-25", "2023-24", "2022-23"];

function periodLabel(p: PeriodSpec): string {
  if (p.kind === "ytd") return `YTD FY${p.fy}`;
  if (p.kind === "fy") return `FY${p.fy}`;
  if (p.kind === "quarter") return `Q${p.quarter} FY${p.fy}`;
  if (p.kind === "month") return `${FISCAL_MONTHS[(p.month ?? 1) - 1]} FY${p.fy}`;
  return `${FISCAL_MONTHS[(p.monthFrom ?? 1) - 1]}–${FISCAL_MONTHS[(p.monthTo ?? 12) - 1]} FY${p.fy}`;
}

function fmtValue(v: number | string | null, money: boolean): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (money) return `₹${trunc2IN((v / 1e7))} Cr`;
  return trunc2IN(v);
}

// ── Small UI helpers ─────────────────────────────────────────────────────────
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</span>;
}

function Chip({ children, onRemove, testId }: { children: React.ReactNode; onRemove?: () => void; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs" data-testid={testId}>
      {children}
      {onRemove && (
        <button onClick={onRemove} className="text-muted-foreground hover:text-foreground" aria-label="remove">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Searchable single-pick dropdown that ADDS to a selection list. */
function EntityPicker({ options, onPick, searchable, onSearch, disabled, disabledReason }: {
  options: string[]; onPick: (v: string) => void; searchable?: boolean;
  onSearch?: (q: string) => void; disabled?: boolean; disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const shown = searchable && onSearch ? options : options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative" ref={ref} title={disabled ? disabledReason : undefined}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={cn("flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs",
          disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/40")}
        data-testid="button-add-entity"
      >
        <Plus className="h-3 w-3" /> add
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); onSearch?.(e.target.value); }}
            placeholder="Search…"
            className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
          {shown.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches</div>}
          {shown.slice(0, 200).map((o) => (
            <button key={o} onClick={() => { onPick(o); setOpen(false); setQ(""); }}
              className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted/50">
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectBox<T extends string>({ value, options, labels, onChange, testId }: {
  value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (v: T) => void; testId?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}
      className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
      {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
    </select>
  );
}

// ── Sparkline — zero-based, no axis tricks ───────────────────────────────────
function Sparkline({ values }: { values: (number | null)[] }) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums, 0);
  const min = Math.min(...nums, 0); // zero-based: axis always includes 0
  const range = max - min || 1;
  const W = 84, H = 24;
  const pts = values.map((v, i) => v == null ? null : [4 + (i * (W - 8)) / Math.max(1, values.length - 1), H - 3 - ((v - min) / range) * (H - 6)] as const);
  const path = pts.filter(Boolean).map((p, i) => `${i === 0 ? "M" : "L"}${trunc2(p![0])},${trunc2(p![1])}`).join(" ");
  const zeroY = H - 3 - ((0 - min) / range) * (H - 6);
  return (
    <svg width={W} height={H} className="text-primary" aria-label="trend, zero-based scale">
      <line x1={4} x2={W - 4} y1={zeroY} y2={zeroY} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

// ── Basis strip — the full block, never a summary ────────────────────────────
const GUARD_STYLE: Record<GuardResult["status"], string> = {
  pass: "bg-green-500/10 text-green-800 dark:text-green-300",
  annotated: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  blocked: "bg-blue-500/10 text-blue-800 dark:text-blue-300",
  notApplicable: "bg-muted/40 text-muted-foreground",
};

function BasisStrip({ result }: { result: ApiResult }) {
  const b = result.basis;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="basis-strip">
      {b.channelLabel && (
        <div className="rounded-md border border-blue-300/50 bg-blue-500/5 px-3 py-2 text-sm font-medium text-blue-900 dark:text-blue-200" data-testid="text-channel-label">
          {b.channelLabel}
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {b.entityType && <span><strong className="text-foreground">Entity:</strong> {b.entityType}</span>}
        {b.basis && <span><strong className="text-foreground">Basis:</strong> {b.basis}</span>}
        {b.population && <span><strong className="text-foreground">Population:</strong> {b.population}</span>}
        {b.normalise && <span><strong className="text-foreground">Normalise:</strong> {NORMALISE_LABEL[b.normalise] ?? b.normalise}</span>}
      </div>
      {(b.periods?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {b.periods!.map((p, i) => (
            <span key={i} className={cn("rounded px-2 py-0.5 text-[11px]",
              p.completeness === "complete" ? "bg-green-500/10 text-green-800 dark:text-green-300"
              : p.completeness === "partial" ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
              : "bg-muted/50 text-muted-foreground")}>
              {p.label} — {p.completeness}{p.months.length > 0 ? ` (${p.months.length} mo with data)` : ""}
            </span>
          ))}
        </div>
      )}
      {b.sources && Object.keys(b.sources).length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          <strong className="text-foreground">Sources:</strong>{" "}
          {Object.entries(b.sources).map(([m, s]) => `${m} ← ${s}`).join("; ")}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {result.guards.map((g) => (
          <span key={g.id} className={cn("rounded px-1.5 py-0.5 text-[10px]", GUARD_STYLE[g.status])} title={g.detail ?? undefined}>
            G{g.id} {g.name}: {g.status}{g.detail && g.status !== "pass" && g.status !== "notApplicable" ? ` — ${g.detail}` : ""}
          </span>
        ))}
      </div>
      {!result.blocked && result.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {result.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}
    </div>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────────
function CellRender({ cell, money }: { cell: CellValue; money: boolean }) {
  if (cell.suppressed) {
    return <span className="text-xs italic text-muted-foreground" title={cell.note ?? undefined}>suppressed{cell.note ? ` — ${cell.note}` : ""}</span>;
  }
  if (cell.value == null) {
    return <span className="text-xs italic text-muted-foreground">{cell.note ?? "not recorded yet"}</span>;
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-mono tabular-nums">{fmtValue(cell.value, money)}</span>
      {cell.real != null && (
        <span className="text-[10px] text-muted-foreground">
          real {fmtValue(cell.real, money)}{cell.realIndexName ? ` · ${cell.realIndexName}` : ""}
        </span>
      )}
      {cell.note && <span className="max-w-[220px] text-right text-[10px] text-muted-foreground">{cell.note}</span>}
    </span>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────
export default function ComparisonDeepDive() {
  const [entityType, setEntityType] = useState<string>("member");
  const [entities, setEntities] = useState<string[]>([]);
  const [contextHead, setContextHead] = useState<string>("");
  const [periods, setPeriods] = useState<PeriodSpec[]>([{ kind: "ytd", fy: FYS[0] }]);
  const [measures, setMeasures] = useState<string[]>([]);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("territory");
  const [normalise, setNormalise] = useState<(typeof NORMALISE)[number]>("absolute");
  const [population, setPopulation] = useState<"activeOnly" | "includeLeft">("activeOnly");

  const [catalogue, setCatalogue] = useState<Record<string, MeasureDef[]>>({});
  const [entityOptions, setEntityOptions] = useState<string[]>([]);
  const [optionsSearchable, setOptionsSearchable] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<{ message: string; validMeasures?: { id: string; label: string }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [view, setView] = useState<"compare" | "cohorts">("compare");
  const [matrixMeasure, setMatrixMeasure] = useState<string | null>(null);
  // Mode D — cohort state
  const [cohortRule, setCohortRule] = useState<string>("assignment");
  const [cohortBand, setCohortBand] = useState<number>(50);
  const [cohortResult, setCohortResult] = useState<CohortResult | null>(null);
  const [cohortLoading, setCohortLoading] = useState(false);
  const [cohortError, setCohortError] = useState<string | null>(null);

  // Period builder state
  const [pbFy, setPbFy] = useState(FYS[0]);
  const [pbKind, setPbKind] = useState<PeriodSpec["kind"]>("quarter");
  const [pbQuarter, setPbQuarter] = useState(1);
  const [pbMonth, setPbMonth] = useState(1);
  const [pbFrom, setPbFrom] = useState(1);
  const [pbTo, setPbTo] = useState(3);

  useEffect(() => {
    fetch("/api/comparison/catalogue").then((r) => r.json()).then(setCatalogue).catch(() => {});
  }, []);

  const loadOptions = (q = "") => {
    fetch(`/api/comparison/entities?type=${entityType}${q ? `&q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => r.json())
      .then((d) => { setEntityOptions(d.entities ?? []); setOptionsSearchable(!!d.searchable); })
      .catch(() => setEntityOptions([]));
  };
  useEffect(() => {
    setEntities([]); setContextHead(""); setResult(null); setError(null); setSortCol(null);
    const valid = new Set((catalogue[entityType] ?? []).map((m) => m.id));
    setMeasures((ms) => ms.filter((m) => valid.has(m)));
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, catalogue]);

  const measureDefs = catalogue[entityType] ?? [];
  const defsById = useMemo(() => new Map(measureDefs.map((m) => [m.id, m])), [measureDefs]);

  // Mode: many periods = trajectory (A); many entities = peer (B).
  const modeA = periods.length > 1 && entities.length <= 1;
  const modeC = periods.length > 1 && entities.length > 1;
  const modeB = entities.length > 1 && !modeC;
  const lockPeriods = false;
  const lockEntities = false;
  const LOCK_MSG = "";

  const addPeriod = () => {
    const p: PeriodSpec = { kind: pbKind, fy: pbFy };
    if (pbKind === "quarter") p.quarter = pbQuarter;
    if (pbKind === "month") p.month = pbMonth;
    if (pbKind === "custom") { p.monthFrom = pbFrom; p.monthTo = pbTo; }
    if (periods.some((x) => periodLabel(x) === periodLabel(p))) return;
    setPeriods((ps) => [...ps, p]);
  };

  const requestBody = () => ({
    entityType,
    entities: entityType === "company" && entities.length === 0 ? ["company"] : entities,
    periods,
    measures,
    channel,
    normalise,
    population,
    ...(contextHead ? { context: { stateHead: contextHead } } : {}),
  });

  const run = async (overrideHead?: string) => {
    setLoading(true); setError(null); setResult(null); setSortCol(null);
    try {
      const body = requestBody();
      if (overrideHead) (body as Record<string, unknown>).context = { stateHead: overrideHead };
      const r = await fetch("/api/comparison", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await r.json();
      if (r.ok || r.status === 422) setResult(data);
      else setError({ message: data.error ?? `HTTP ${r.status}`, validMeasures: data.detail?.validMeasures });
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  const canRun = measures.length > 0 && periods.length > 0 && (entityType === "company" || entities.length > 0);

  const runCohortQuery = async () => {
    setCohortLoading(true); setCohortError(null); setCohortResult(null);
    try {
      const body: Record<string, unknown> = { rule: cohortRule, channel };
      if (cohortRule === "achievementBand") body.band = cohortBand / 100;
      // The build runs server-side detached from the request; a 202 means
      // "still building" — keep polling until the cached result is ready.
      const deadline = Date.now() + 15 * 60 * 1000;
      for (;;) {
        const r = await fetch("/api/comparison/cohort", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        let data: any = null;
        try { data = await r.json(); } catch {
          throw new Error(`the server took too long to answer (HTTP ${r.status}) — the build is likely still running; press Build again in a minute`);
        }
        if (r.status === 202 && data?.building) {
          if (Date.now() > deadline) throw new Error("the cohort build is taking unusually long — try again later");
          await new Promise((res) => setTimeout(res, (data.retryAfter ?? 20) * 1000));
          continue;
        }
        if (r.ok) { setCohortResult(data); return; }
        throw new Error(data?.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      setCohortError(e instanceof Error ? e.message : String(e));
    } finally {
      setCohortLoading(false);
    }
  };

  const exportCohortPdf = () => {
    if (!cohortResult) return;
    const el = document.getElementById("cohort-print-root");
    if (!el) return;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Cohorts</title><style>
      body{font-family:system-ui,sans-serif;font-size:11px;color:#111;margin:24px}
      table{border-collapse:collapse;width:100%;margin-top:8px}
      th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
      .basis{border:1px solid #99c;background:#eef3fb;padding:8px 10px;margin-bottom:10px;font-weight:600}
      .muted{color:#666;font-size:10px}
    </style></head><body>
      <div class="basis">${cohortResult.basis.channelLabel.replace(/</g, "&lt;")}</div>
      <div class="basis">Cohort rule: ${cohortResult.basis.ruleDetail.replace(/</g, "&lt;")}<br/>
        Rule id: ${cohortResult.basis.rule.replace(/</g, "&lt;")} · FY: ${cohortResult.basis.fy.replace(/</g, "&lt;")} · Channel: ${cohortResult.basis.channel.replace(/</g, "&lt;")}</div>
      ${(cohortResult.basis.readings ?? []).length ? `<div class="basis">Readings — both interpretations carry:<br/>${cohortResult.basis.readings.map((r) => `• ${r.replace(/</g, "&lt;")}`).join("<br/>")}</div>` : ""}
      ${el.innerHTML}
      <p class="muted">Generated ${new Date().toLocaleString("en-IN")} — cohorts are rules, re-evaluated on live data.</p>
    </body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  };

  // Disambiguation candidates from guard 10 on a blocked response.
  const disambiguation = useMemo(() => {
    if (!result?.blocked) return null;
    const g = result.guards.find((x) => x.id === 10 && x.status === "blocked" && Array.isArray(x.data));
    return g ? (g.data as { name: string; stateHead: string; headquarter?: string }[]) : null;
  }, [result]);

  // Mode B rows grouped by entity.
  const ok = result && !result.blocked ? (result as OkResponse) : null;
  const peerRows = useMemo(() => {
    if (!ok) return [];
    const byEntity = new Map<string, { entity: string; excludeFromRanking: boolean; flags: Set<string>; cells: Map<string, CellValue> }>();
    for (const row of ok.matrix) {
      let e = byEntity.get(row.entity);
      if (!e) { e = { entity: row.entity, excludeFromRanking: false, flags: new Set(), cells: new Map() }; byEntity.set(row.entity, e); }
      e.cells.set(row.measure, row.cells[0] ?? { value: null });
      if (row.excludeFromRanking) e.excludeFromRanking = true;
      for (const f of row.flags ?? []) e.flags.add(f);
    }
    return [...byEntity.values()];
  }, [ok]);

  const rowFlags = (r: { flags: Set<string> }): string[] => [...r.flags];

  // Ranking eligibility comes from the API (guard 7), never inferred client-side.
  const sortDisabled = (measureId: string): string | null => {
    if (!ok) return null;
    const blocked = ok.matrix.find((r) => r.measure === measureId && r.rankEligible === false);
    return blocked ? (blocked.rankBlockReason ?? "ranking on this measure is blocked by a guard") : null;
  };

  const rankedRows = useMemo(() => {
    const ranked = peerRows.filter((r) => !r.excludeFromRanking);
    if (!sortCol) return ranked;
    return [...ranked].sort((a, b) => {
      const av = a.cells.get(sortCol)?.value; const bv = b.cells.get(sortCol)?.value;
      const an = typeof av === "number" ? av : null; const bn = typeof bv === "number" ? bv : null;
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return sortDesc ? bn - an : an - bn;
    });
  }, [peerRows, sortCol, sortDesc]);
  const notRankedRows = peerRows.filter((r) => r.excludeFromRanking);

  // Exports — Excel from the server (same body), PDF via print window; both
  // carry the full basis strip.
  const exportExcel = async () => {
    const r = await fetch("/api/comparison/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody()),
    });
    const ct = r.headers.get("Content-Type") ?? "";
    if (!ct.includes("spreadsheetml")) {
      const d = await r.json().catch(() => null);
      setError({ message: d?.error ?? `Export failed (${r.status})` });
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Comparison_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    if (!result) return;
    const el = document.getElementById("comparison-print-root");
    const basisEl = document.querySelector('[data-testid="basis-strip"]');
    const blockedEl = document.querySelector('[data-testid="blocked-panel"]');
    if (!basisEl) return;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Comparison</title><style>
      body{font-family:system-ui,sans-serif;font-size:11px;color:#111;margin:24px}
      table{border-collapse:collapse;width:100%;margin-top:8px}
      th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
      .basis{border:1px solid #99c;background:#eef3fb;padding:8px 10px;margin-bottom:10px;font-weight:600}
      .muted{color:#666;font-size:10px}
      .strip{border:1px solid #ccc;padding:8px 10px;margin-bottom:10px}
      .strip span{margin-right:8px}
      svg{display:none}
      @media print { .basis{page-break-inside:avoid} }
    </style></head><body>
      <div class="basis">${(result.basis.channelLabel ?? "").replace(/</g, "&lt;")}</div>
      <div class="strip">${basisEl.innerHTML}</div>
      ${blockedEl ? `<div class="strip">${blockedEl.innerHTML}</div>` : ""}
      ${el ? el.innerHTML : ""}
      <p class="muted">Generated ${new Date().toLocaleString("en-IN")} — every figure on this page carries the basis above.</p>
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  return (
    <div className="space-y-4">
      {/* ── View toggle: comparisons vs rule-based cohorts ── */}
      <div className="flex gap-1 rounded-lg border border-border bg-card p-1 w-fit">
        {(["compare", "cohorts"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={cn("rounded-md px-3 py-1.5 text-xs font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/40")}
            data-testid={`view-${v}`}>
            {v === "compare" ? "Compare" : "Cohorts"}
          </button>
        ))}
      </div>

      {view === "cohorts" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-col gap-1">
              <FieldLabel>Cohort rule (a rule, not a hand-picked list)</FieldLabel>
              <SelectBox value={cohortRule}
                options={["assignment", "achievementBand", "distributorTier", "customerStatus", "segmentSeason", "sheetMapped"] as const}
                labels={{
                  assignment: "Retailers: with vs without distributor",
                  achievementBand: "Members: above vs below achievement band",
                  distributorTier: "Distributors: by tier A/B/C",
                  customerStatus: "Customers: retained / reactivated / lapsed",
                  segmentSeason: "Segments: in vs out of season this quarter",
                  sheetMapped: "Members: working sheet mapped vs not",
                }}
                onChange={setCohortRule} testId="select-cohort-rule" />
            </div>
            {cohortRule === "achievementBand" && (
              <div className="flex flex-col gap-1">
                <FieldLabel>Band (%)</FieldLabel>
                <input type="number" min={1} max={400} value={cohortBand}
                  onChange={(e) => setCohortBand(Number(e.target.value) || 50)}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  data-testid="input-cohort-band" />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <FieldLabel>Channel</FieldLabel>
              <SelectBox value={channel} options={CHANNELS} onChange={(v) => setChannel(v)} testId="select-cohort-channel" />
            </div>
            <button onClick={runCohortQuery} disabled={cohortLoading}
              className={cn("rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground", cohortLoading && "opacity-50")}
              data-testid="button-run-cohort">
              {cohortLoading ? "Building cohorts… (the company-wide rules can take a few minutes on a cold start)" : "Build cohorts"}
            </button>
            {cohortResult && (
              <button onClick={exportCohortPdf} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40" data-testid="button-export-cohort-pdf">
                <Printer className="h-3 w-3" /> PDF
              </button>
            )}
          </div>

          {cohortError && <div className="rounded-lg border border-border bg-card p-3 text-sm text-destructive" data-testid="cohort-error">{cohortError}</div>}

          {cohortResult && (
            <div className="space-y-3">
              {/* Basis — channel label + rule detail ABOVE any figure */}
              <div className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-xs" data-testid="cohort-basis-strip">
                <p className="font-semibold">{cohortResult.basis.channelLabel}</p>
                <p className="text-muted-foreground"><span className="font-medium text-foreground">Rule:</span> {cohortResult.basis.ruleDetail}</p>
                {cohortResult.basis.readings.map((r, i) => (
                  <p key={i} className="flex items-start gap-1.5 text-muted-foreground"><Info className="mt-0.5 h-3 w-3 shrink-0" />{r}</p>
                ))}
              </div>
              <div id="cohort-print-root" className="space-y-3">
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full text-xs" data-testid="table-cohorts">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Cohort</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Population</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Value</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Measure</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cohortResult.cohorts.map((c) => (
                        <tr key={c.name} className="border-b border-border/30">
                          <td className="px-3 py-2 font-medium">{c.name}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{c.population.toLocaleString("en-IN")}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {c.value == null ? <span className="italic text-muted-foreground font-sans">—</span>
                              : c.valueLabel.includes("₹") ? fmtValue(c.value, true)
                              : trunc2IN(c.value)}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{c.valueLabel}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.note ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {cohortResult.difference && (
                  <div className="rounded-lg border border-border bg-card p-3 text-xs" data-testid="cohort-difference">
                    <span className="font-semibold">Difference: </span>
                    {cohortResult.difference.value == null ? "n/a" : trunc2IN(cohortResult.difference.value)}
                    {" "}({cohortResult.difference.label}) — <span className="text-muted-foreground">{cohortResult.difference.sampleNote}</span>
                  </div>
                )}
                {cohortResult.correlation && (
                  <div className="rounded-lg border border-border bg-card p-3 text-xs" data-testid="cohort-correlation">
                    <span className="font-semibold">Correlation: </span>
                    {cohortResult.correlation.suppressed ? <span className="italic">suppressed</span> : `r = ${cohortResult.correlation.r} (n = ${cohortResult.correlation.n})`}
                    {" — "}<span className="text-muted-foreground">{cohortResult.correlation.note}</span>
                  </div>
                )}
                {cohortResult.suggestions && cohortResult.suggestions.length > 0 && (
                  <div className="rounded-lg border border-border bg-card p-3 text-xs space-y-2" data-testid="cohort-suggestions">
                    <p className="font-semibold">Suggested actions</p>
                    {cohortResult.suggestions.map((sg) => (
                      <div key={sg.rank} className="rounded-md border border-border/60 p-2.5" data-testid={`cohort-suggestion-${sg.rank}`}>
                        <p className="font-semibold">#{sg.rank} · {sg.action}</p>
                        <p className="mt-0.5 text-muted-foreground"><span className="font-medium text-foreground">Evidence: </span>{sg.evidence}</p>
                        {sg.caveats.length > 0 && <p className="mt-0.5 text-amber-800 dark:text-amber-300"><span className="font-medium">Both readings carry: </span>{sg.caveats.join(" ")}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {cohortResult.notes.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-1">
                    {cohortResult.notes.map((n, i) => <p key={i} className="text-muted-foreground">• {n}</p>)}
                  </div>
                )}
              </div>
            </div>
          )}
          {!cohortResult && !cohortError && !cohortLoading && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Pick a rule and press Build cohorts. A cohort is a rule — it re-evaluates as data changes, so the same question stays answered.
            </div>
          )}
        </div>
      )}

      {view === "compare" && (<>
      {/* ── Selection ── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div className="flex flex-col gap-1">
            <FieldLabel>Compare</FieldLabel>
            <div className="flex items-center gap-2">
              <SelectBox value={entityType} options={ENTITY_TYPES} onChange={setEntityType} testId="select-entity-type" />
              {entityType !== "company" && (
                <EntityPicker
                  options={entityOptions.filter((o) => !entities.includes(o))}
                  searchable={optionsSearchable}
                  onSearch={(q) => { clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => loadOptions(q), 300); }}
                  onPick={(v) => setEntities((es) => [...es, v])}
                  disabled={lockEntities}
                  disabledReason={LOCK_MSG}
                />
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>Across</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <SelectBox value={pbFy} options={FYS} onChange={setPbFy} testId="select-period-fy" />
              <SelectBox value={pbKind} options={["ytd", "quarter", "month", "fy", "custom"] as const} onChange={(v) => setPbKind(v)} testId="select-period-kind" />
              {pbKind === "quarter" && <SelectBox value={String(pbQuarter)} options={["1", "2", "3", "4"]} labels={{ "1": "Q1", "2": "Q2", "3": "Q3", "4": "Q4" }} onChange={(v) => setPbQuarter(Number(v))} />}
              {pbKind === "month" && <SelectBox value={String(pbMonth)} options={FISCAL_MONTHS.map((_, i) => String(i + 1))} labels={Object.fromEntries(FISCAL_MONTHS.map((m, i) => [String(i + 1), m]))} onChange={(v) => setPbMonth(Number(v))} />}
              {pbKind === "custom" && (<>
                <SelectBox value={String(pbFrom)} options={FISCAL_MONTHS.map((_, i) => String(i + 1))} labels={Object.fromEntries(FISCAL_MONTHS.map((m, i) => [String(i + 1), m]))} onChange={(v) => setPbFrom(Number(v))} />
                <span className="text-xs text-muted-foreground">to</span>
                <SelectBox value={String(pbTo)} options={FISCAL_MONTHS.map((_, i) => String(i + 1))} labels={Object.fromEntries(FISCAL_MONTHS.map((m, i) => [String(i + 1), m]))} onChange={(v) => setPbTo(Number(v))} />
              </>)}
              <button onClick={addPeriod} disabled={lockPeriods} title={lockPeriods ? LOCK_MSG : undefined}
                className={cn("flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs", lockPeriods ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/40")}
                data-testid="button-add-period">
                <Plus className="h-3 w-3" /> add period
              </button>
            </div>
          </div>
        </div>

        {(entities.length > 0 || periods.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {entities.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Entities:</span>
                {entities.map((e) => <Chip key={e} onRemove={() => setEntities((es) => es.filter((x) => x !== e))} testId={`chip-entity-${e}`}>{e}{contextHead && ` (head: ${contextHead})`}</Chip>)}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Periods:</span>
              {periods.map((p, i) => <Chip key={i} onRemove={periods.length > 1 || entities.length > 0 ? () => setPeriods((ps) => ps.filter((_, j) => j !== i)) : undefined}>{periodLabel(p)}</Chip>)}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-t border-border/60 pt-3">
          <div className="flex flex-col gap-1">
            <FieldLabel>Measures (valid for {entityType})</FieldLabel>
            <div className="flex max-w-2xl flex-wrap gap-1.5">
              {measureDefs.map((m) => (
                <button key={m.id}
                  onClick={() => setMeasures((ms) => ms.includes(m.id) ? ms.filter((x) => x !== m.id) : [...ms, m.id])}
                  className={cn("rounded-md border px-2 py-1 text-[11px]",
                    measures.includes(m.id) ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/40")}
                  data-testid={`toggle-measure-${m.id}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>Channel</FieldLabel>
            <SelectBox value={channel} options={CHANNELS} onChange={(v) => setChannel(v)} testId="select-channel" />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>Normalise</FieldLabel>
            <SelectBox value={normalise} options={NORMALISE} labels={NORMALISE_LABEL} onChange={(v) => setNormalise(v)} testId="select-normalise" />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>Population</FieldLabel>
            <SelectBox value={population} options={["activeOnly", "includeLeft"] as const} labels={{ activeOnly: "Active only", includeLeft: "Include LEFT" }} onChange={(v) => setPopulation(v)} testId="select-population" />
          </div>
          <button onClick={() => run()} disabled={!canRun || loading}
            className={cn("rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground", (!canRun || loading) && "opacity-50")}
            data-testid="button-run-comparison">
            {loading ? "Comparing…" : "Compare"}
          </button>
          {result && (
            <div className="flex gap-2">
              <button onClick={exportExcel} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40" data-testid="button-export-comparison-excel">
                <Download className="h-3 w-3" /> Excel
              </button>
              <button onClick={exportPdf} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted/40" data-testid="button-export-comparison-pdf">
                <Printer className="h-3 w-3" /> PDF
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-border bg-card p-3 text-sm" data-testid="error-panel">
          <p className="text-destructive">{error.message}</p>
          {error.validMeasures && (
            <p className="mt-1 text-xs text-muted-foreground">
              Valid measures for {entityType}: {error.validMeasures.map((m) => m.label).join(", ")}
            </p>
          )}
        </div>
      )}

      {/* ── Basis strip — always above any figure ── */}
      {result && <BasisStrip result={result} />}

      {/* ── Blocked: the refusal is a finding, not a failure ── */}
      {result?.blocked && (
        <div className="rounded-lg border border-blue-300/50 bg-blue-500/5 p-4" data-testid="blocked-panel">
          <p className="flex items-start gap-2 text-sm text-blue-900 dark:text-blue-200">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>This comparison would mislead, so it is not shown.</strong> {result.reason}</span>
          </p>
          {disambiguation && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-muted-foreground">Several people share this name — pick the one you mean:</p>
              <div className="flex flex-wrap gap-2">
                {disambiguation.map((c, i) => (
                  <button key={i} onClick={() => { setContextHead(c.stateHead); run(c.stateHead); }}
                    className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs hover:bg-muted/40"
                    data-testid={`button-disambiguate-${i}`}>
                    {c.name} — head {c.stateHead}{c.headquarter ? `, HQ ${c.headquarter}` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {ok && (
        <div id="comparison-print-root" className="space-y-4">
          {/* Mode A — trajectory: rows per measure, columns per period */}
          {!modeB && !modeC && (
            <div className="overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs" data-testid="table-trajectory">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Measure</th>
                    {ok.basis.periods.map((p, i) => (
                      <th key={i} className="px-3 py-2 text-right font-medium text-muted-foreground">{p.label}<div className="text-[10px] font-normal">{p.completeness}</div></th>
                    ))}
                    {ok.basis.periods.length > 1 && <th className="px-3 py-2 text-right font-medium text-muted-foreground">Change</th>}
                    {ok.basis.periods.length > 1 && <th className="px-3 py-2 text-left font-medium text-muted-foreground">Trend<div className="text-[10px] font-normal">zero-based</div></th>}
                  </tr>
                </thead>
                <tbody>
                  {ok.matrix.map((row, ri) => {
                    const money = defsById.get(row.measure)?.money ?? false;
                    const nums = row.cells.map((c) => (typeof c.value === "number" && !c.suppressed ? c.value : null));
                    const first = nums.find((v) => v != null) ?? null;
                    const last = [...nums].reverse().find((v) => v != null) ?? null;
                    const change = first != null && last != null && first !== last ? last - first : first != null && last != null ? 0 : null;
                    return (
                      <tr key={ri} className="border-b border-border/30">
                        <td className="px-3 py-2">
                          <div className="font-medium">{row.measureLabel}</div>
                          {row.entity !== "company" && <div className="text-[10px] text-muted-foreground">{row.entity}</div>}
                          {row.source && <div className="text-[10px] text-muted-foreground">src: {row.source}</div>}
                        </td>
                        {row.cells.map((c, ci) => <td key={ci} className="px-3 py-2 text-right"><CellRender cell={c} money={money} /></td>)}
                        {ok.basis.periods.length > 1 && (
                          <td className={cn("px-3 py-2 text-right font-mono tabular-nums", change != null && (change >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"))}>
                            {change == null ? <span className="text-muted-foreground italic font-sans">n/a</span> : `${change >= 0 ? "▲ +" : "▼ "}${fmtValue(change, money)}`}
                          </td>
                        )}
                        {ok.basis.periods.length > 1 && <td className="px-3 py-2"><Sparkline values={nums} /></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Mode B — peer: rows per entity, columns per measure */}
          {modeB && (
            <>
              <div className="overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs" data-testid="table-peer">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Entity</th>
                      {measures.map((mid) => {
                        const def = defsById.get(mid);
                        const reason = sortDisabled(mid);
                        return (
                          <th key={mid} className="px-3 py-2 text-right font-medium text-muted-foreground">
                            <button
                              onClick={() => { if (reason) return; setSortDesc(sortCol === mid ? !sortDesc : true); setSortCol(mid); }}
                              disabled={!!reason}
                              title={reason ?? "Sort by this column"}
                              className={cn(reason ? "cursor-not-allowed opacity-40" : "hover:text-foreground", sortCol === mid && "text-foreground underline")}
                              data-testid={`sort-${mid}`}>
                              {def?.label ?? mid}{sortCol === mid ? (sortDesc ? " ↓" : " ↑") : ""}
                            </button>
                            {reason && <div className="max-w-[160px] text-[9px] font-normal normal-case">{reason}</div>}
                          </th>
                        );
                      })}
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedRows.map((r) => (
                      <tr key={r.entity} className="border-b border-border/30">
                        <td className="px-3 py-2 font-medium">{r.entity}</td>
                        {measures.map((mid) => (
                          <td key={mid} className="px-3 py-2 text-right">
                            <CellRender cell={r.cells.get(mid) ?? { value: null }} money={defsById.get(mid)?.money ?? false} />
                          </td>
                        ))}
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {rowFlags(r).map((f) => <span key={f} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-300">{f}</span>)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {notRankedRows.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 p-3" data-testid="not-ranked-block">
                  <p className="mb-2 text-xs font-semibold">Not ranked</p>
                  {notRankedRows.map((r) => (
                    <div key={r.entity} className="flex flex-wrap items-baseline gap-2 border-t border-border/40 py-1.5 text-xs first:border-t-0">
                      <span className="font-medium">{r.entity}</span>
                      <span className="italic text-muted-foreground">
                        {[...r.cells.values()].map((c) => c.note).find(Boolean) ?? "excluded from ranking"}
                      </span>
                      <span className="flex gap-1">{rowFlags(r).map((f) => <span key={f} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{f}</span>)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Mode C — matrix: entities × periods, one measure at a time */}
          {modeC && (() => {
            const mIds = [...new Set(ok.matrix.map((r) => r.measure))];
            const mSel = matrixMeasure && mIds.includes(matrixMeasure) ? matrixMeasure : mIds[0];
            const rows = ok.matrix.filter((r) => r.measure === mSel);
            const money = defsById.get(mSel)?.money ?? false;
            const quad = ok.quadrants?.find((q) => q.measure === mSel);
            return (
              <div className="space-y-4">
                {mIds.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">Matrix shows one measure at a time:</span>
                    {mIds.map((mid) => (
                      <button key={mid} onClick={() => setMatrixMeasure(mid)}
                        className={cn("rounded-md border px-2 py-1 text-[11px]", mid === mSel ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/40")}
                        data-testid={`matrix-measure-${mid}`}>
                        {defsById.get(mid)?.label ?? mid}
                      </button>
                    ))}
                  </div>
                )}
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full text-xs" data-testid="table-matrix">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Entity</th>
                        {ok.basis.periods.map((pp, i) => (
                          <th key={i} className="px-3 py-2 text-right font-medium text-muted-foreground">{pp.label}<div className="text-[10px] font-normal">{pp.completeness}</div></th>
                        ))}
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Level<div className="text-[10px] font-normal">latest value</div></th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Direction<div className="text-[10px] font-normal">slope, complete periods only</div></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const t = row.trend;
                        return (
                          <tr key={row.entity} className="border-b border-border/30">
                            <td className="px-3 py-2">
                              <div className="font-medium">{row.entity}</div>
                              <div className="flex flex-wrap gap-1">{(row.flags ?? []).map((f) => <span key={f} className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-800 dark:text-amber-300">{f}</span>)}</div>
                            </td>
                            {row.cells.map((c, ci) => {
                              const prev = ci > 0 ? row.cells[ci - 1] : null;
                              const cv = c.real ?? c.value; const pv = prev ? (prev.real ?? prev.value) : null;
                              const delta = typeof cv === "number" && typeof pv === "number" ? cv - pv : null;
                              return (
                                <td key={ci} className="px-3 py-2 text-right">
                                  <CellRender cell={c} money={money} />
                                  {delta != null && (
                                    <div className={cn("text-[10px] font-mono tabular-nums", delta >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                                      {delta >= 0 ? "▲ +" : "▼ "}{fmtValue(delta, money)}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-3 py-2 text-right font-mono tabular-nums">
                              {t?.level == null ? <span className="italic text-muted-foreground font-sans">—</span> : (<>
                                {fmtValue(t.level, money)}
                                {t.levelIsPartial && <div className="text-[9px] font-sans text-muted-foreground">partial period</div>}
                              </>)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {t?.direction == null
                                ? <span className="block max-w-[180px] text-left text-[10px] italic text-muted-foreground" title={t?.directionBasis ?? undefined}>{t?.directionBasis ?? "—"}</span>
                                : (<>
                                    <span className={cn("font-mono tabular-nums", t.direction >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400")}>
                                      {t.direction >= 0 ? "↗ +" : "↘ "}{fmtValue(t.direction, money)}
                                    </span>
                                    {t.excludedPeriods.length > 0 && (
                                      <div className="max-w-[180px] text-left text-[9px] text-muted-foreground">
                                        excluded: {t.excludedPeriods.map((x) => x.label).join(", ")}
                                      </div>
                                    )}
                                  </>)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Quadrants — falling-from-high FIRST: the story nobody sees today */}
                {quad && (
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="quadrant-panel">
                    <p className="mb-1 text-xs font-semibold">Quadrants — {quad.measureLabel}</p>
                    <p className="mb-2 text-[11px] text-muted-foreground">{quad.splitRule} (split at {fmtValue(quad.levelSplit, money)})</p>
                    {quad.groups.length === 0 && <p className="text-xs italic text-muted-foreground">{quad.splitRule}</p>}
                    <div className="grid gap-2 sm:grid-cols-2">
                      {quad.groups.map((g) => (
                        <div key={g.quadrant} className={cn("rounded-md border p-2.5", g.quadrant === "high-falling" ? "border-red-400/60 bg-red-500/5" : "border-border/60")} data-testid={`quadrant-${g.quadrant}`}>
                          <p className={cn("text-[11px] font-semibold", g.quadrant === "high-falling" && "text-red-800 dark:text-red-300")}>{g.label}</p>
                          {g.entities.length === 0 ? <p className="mt-1 text-[11px] italic text-muted-foreground">none</p> : (
                            <ul className="mt-1 space-y-0.5">
                              {g.entities.map((e) => (
                                <li key={e.entity} className="flex justify-between gap-2 text-[11px]">
                                  <span>{e.entity}</span>
                                  <span className="font-mono tabular-nums text-muted-foreground">{fmtValue(e.level, money)} / {e.direction >= 0 ? "+" : ""}{fmtValue(e.direction, money)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                    {quad.noDirection.length > 0 && (
                      <div className="mt-2 border-t border-border/40 pt-2 text-[11px] text-muted-foreground" data-testid="quadrant-no-direction">
                        <span className="font-medium text-foreground">Shown without a direction: </span>
                        {quad.noDirection.map((x) => `${x.entity} (${x.reason})`).join("; ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* C4: suggested actions — rendered verbatim from the API, never derived here */}
          {ok.suggestions && ok.suggestions.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3" data-testid="suggestions-panel">
              <p className="mb-1 text-xs font-semibold">Suggested actions</p>
              <p className="mb-2 text-[11px] text-muted-foreground">Ranked by the server from the quadrant and roster facts above — every suggestion carries its evidence; nothing is inferred on this page.</p>
              <div className="space-y-2">
                {ok.suggestions.map((sg) => (
                  <div key={sg.rank} className={cn("rounded-md border p-2.5", sg.kind === "high-falling" ? "border-red-400/60 bg-red-500/5" : sg.kind === "low-falling" ? "border-orange-400/50 bg-orange-500/5" : "border-amber-400/50 bg-amber-500/5")} data-testid={`suggestion-${sg.rank}`}>
                    <p className="text-[11px] font-semibold">#{sg.rank} · {sg.action}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Evidence: </span>{sg.evidence}</p>
                    {sg.caveats.length > 0 && (
                      <p className="mt-0.5 text-[11px] text-amber-800 dark:text-amber-300"><span className="font-medium">Caveat: </span>{sg.caveats.join(" ")}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Roster changes — a head's direction can move purely from membership */}
          {ok.rosterChanges && ok.rosterChanges.length > 0 && (
            <div className="rounded-lg border border-amber-400/50 bg-amber-500/5 p-3" data-testid="roster-changes-panel">
              <p className="mb-2 text-xs font-semibold text-amber-900 dark:text-amber-200">Roster changed between the compared years</p>
              {ok.rosterChanges.map((rc, i) => (
                <div key={i} className="border-t border-amber-400/20 py-1.5 text-[11px] first:border-t-0">
                  <span className="font-medium">{rc.entity}</span> — FY{rc.fromFy} → FY{rc.toFy}:
                  {rc.joiners.length > 0 && <span> joined: {rc.joiners.join(", ")}.</span>}
                  {rc.leavers.length > 0 && <span> left: {rc.leavers.join(", ")}.</span>}
                  <span className="text-muted-foreground"> {rc.note}</span>
                </div>
              ))}
            </div>
          )}

          {/* Like-for-like — headline vs targeted-only, untargeted named */}
          {ok.likeForLike && ok.likeForLike.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3" data-testid="like-for-like-block">
              <p className="mb-2 text-xs font-semibold">Achievement — headline vs like-for-like</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 pr-3 text-left font-medium">Entity</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Headline</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Like-for-like (targeted only)</th>
                    <th className="py-1.5 text-left font-medium">Untargeted members (excluded from like-for-like)</th>
                  </tr>
                </thead>
                <tbody>
                  {ok.likeForLike.map((l) => (
                    <tr key={l.entity} className="border-b border-border/30">
                      <td className="py-1.5 pr-3 font-medium">{l.entity}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{l.headlineAchievement == null ? "—" : `${trunc2IN(l.headlineAchievement)}%`}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{l.likeForLikeAchievement == null ? "—" : `${trunc2IN(l.likeForLikeAchievement)}%`}</td>
                      <td className="py-1.5">{l.untargetedMembers.length > 0 ? l.untargetedMembers.join(", ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!result && !error && !loading && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Pick what to compare, add periods or peers, choose measures, then press Compare.<br />
          <span className="text-xs">One entity across many periods shows a trajectory. Many entities in one period shows a peer view. Both together shows the matrix — level and direction at once.</span>
        </div>
      )}
      </>)}
    </div>
  );
}
