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
type CellValue = { value: number | string | null; real?: number | null; realIndex?: number | null; realIndexName?: string | null; note?: string | null; suppressed?: boolean };
type MatrixRow = { entity: string; measure: string; measureLabel: string; source: string | null; excludeFromRanking?: boolean; flags?: string[]; rankEligible?: boolean; rankBlockReason?: string | null; cells: CellValue[] };
type BasisBlock = {
  entityType?: string; basis?: string; channel?: string; channelLabel?: string;
  population?: string; normalise?: string;
  periods?: { label: string; fy: string; completeness: string; months: string[] }[];
  sources?: Record<string, string>;
};
type OkResponse = {
  blocked: false; basis: Required<BasisBlock>; guards: GuardResult[]; matrix: MatrixRow[];
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
  if (money) return `₹${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} Cr`;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
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
  const path = pts.filter(Boolean).map((p, i) => `${i === 0 ? "M" : "L"}${p![0].toFixed(1)},${p![1].toFixed(1)}`).join(" ");
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
  const modeA = periods.length > 1;
  const modeB = entities.length > 1;
  const lockPeriods = modeB;   // Mode C belongs to C3
  const lockEntities = modeA;
  const LOCK_MSG = "Level and direction together (many entities × many periods) is the matrix view — it arrives in the next phase. Clear one axis to multi-select the other.";

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
        {(lockPeriods || lockEntities) && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground"><Info className="mt-0.5 h-3 w-3 shrink-0" />{LOCK_MSG}</p>
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
          {!modeB && (
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
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{l.headlineAchievement == null ? "—" : `${l.headlineAchievement.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{l.likeForLikeAchievement == null ? "—" : `${l.likeForLikeAchievement.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`}</td>
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
          <span className="text-xs">One entity across many periods shows a trajectory. Many entities in one period shows a peer view.</span>
        </div>
      )}
    </div>
  );
}
