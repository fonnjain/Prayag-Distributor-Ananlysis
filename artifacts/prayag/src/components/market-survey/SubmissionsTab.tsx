// SubmissionsTab — Tab 4 of Market Survey page.
// Shows all recorded submissions grouped by survey type, then by survey_id (visit).
// Supports filters, inline 24h edit, and XLSX export.

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL;
const API  = (path: string) => `${BASE}api/${path}`;

// ── Types ─────────────────────────────────────────────────────────────────

interface SurveyLine {
  id: number;
  segment: string;
  prayagItemCode: string | null;
  itemName: string | null;
  currentMrp: number | null;
  competitorBrand: string;
  competitorProduct: string | null;
  netPrice: number;
  mrp: number | null;
  discountPct: number | null;
  entryMode: string;
  unit: string;
  packSize: string | null;
  reasons: string[];
  monthlyVolume: number | null;
  note: string | null;
  createdAt: string;
  editable: boolean;
  // richer-capture fields (null = not recorded)
  creditDaysCompetitor: number | null;
  creditGivenBy: string | null;
  creditDaysPrayag: number | null;
  competitorSchemeType: string | null;
  competitorSchemeValue: string | null;
  deliveryDaysCompetitor: number | null;
  deliveryDaysPrayag: number | null;
  shelfShare: string | null;
  paymentTermsNote: string | null;
  competitorVisitFrequency: string | null;
  competitorMoq: string | null;
  buyingSince: string | null;
  wouldSwitch: string | null;
  switchCondition: string | null;
}

interface Survey {
  surveyId: string;
  submittedAt: string;
  recordedBy: string;
  retailer: string;
  customerId: string | null;
  isPendingProspect: boolean;
  state: string | null;
  district: string | null;
  editableUntil: string;
  lines: SurveyLine[];
}

interface Group {
  surveyType: string;
  label: string;
  rowCount: number;
  combinedValue: number | null;
  surveys: Survey[];
}

interface SubmissionsData {
  total: number;
  typeCounts: Record<string, number>;
  groups: Group[];
}

interface StateHead { key: string; name: string }
interface MetaResponse { segments: string[] }

// ── Constants ─────────────────────────────────────────────────────────────

const REASON_OPTIONS = [
  { value: "price",        label: "Price" },
  { value: "availability", label: "Availability" },
  { value: "credit_terms", label: "Credit Terms" },
  { value: "relationship", label: "Relationship" },
  { value: "scheme",       label: "Scheme / Incentive" },
  { value: "quality",      label: "Quality" },
];

const ENTRY_MODE_LABELS: Record<string, string> = {
  net_direct: "Net direct",
  mrp_discount: "MRP − discount%",
};

const TYPE_LABELS: Record<string, string> = {
  existing_sku:  "Existing customer, existing SKU",
  new_sku:       "Existing customer, new SKU",
  new_customer:  "New customer",
  unclassified:  "Unclassified (pre-rebuild rows)",
};

// ── Tiny helpers ──────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  return n == null ? "—" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function fmtLock(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`;
}

// ── EditForm ──────────────────────────────────────────────────────────────

interface EditFormProps {
  line: SurveyLine;
  recorderName: string;
  onSaved: () => void;
  onCancel: () => void;
}

function EditForm({ line, recorderName, onSaved, onCancel }: EditFormProps) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    competitorBrand:   line.competitorBrand,
    competitorProduct: line.competitorProduct ?? "",
    entryMode:         line.entryMode as "net_direct" | "mrp_discount",
    netPrice:          line.netPrice.toString(),
    mrp:               line.mrp?.toString() ?? "",
    discountPct:       line.discountPct?.toString() ?? "",
    monthlyVolume:     line.monthlyVolume?.toString() ?? "",
    note:              line.note ?? "",
    reasons:           [...line.reasons],
  });

  const computedNet = draft.entryMode === "mrp_discount"
    ? (parseFloat(draft.mrp) * (1 - parseFloat(draft.discountPct) / 100))
    : null;

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        recorderName,
        competitorBrand: draft.competitorBrand,
        competitorProduct: draft.competitorProduct || null,
        entryMode: draft.entryMode,
        reasons: draft.reasons,
        note: draft.note || null,
        monthlyVolume: draft.monthlyVolume ? parseFloat(draft.monthlyVolume) : null,
      };
      if (draft.entryMode === "net_direct") {
        body.netPrice = parseFloat(draft.netPrice);
      } else {
        body.mrp        = parseFloat(draft.mrp);
        body.discountPct = parseFloat(draft.discountPct);
      }
      const r = await fetch(API(`market-survey/${line.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error ?? "Save failed"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ms-submissions"] });
      onSaved();
    },
  });

  const toggleReason = (v: string) =>
    setDraft((d) => ({ ...d, reasons: d.reasons.includes(v) ? d.reasons.filter((r) => r !== v) : [...d.reasons, v] }));

  return (
    <div className="mt-2 p-3 rounded border bg-muted/40 space-y-3 text-sm">
      {mut.error && <p className="text-destructive text-xs">{String(mut.error)}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground font-medium">Competitor Brand</span>
          <input className="w-full rounded border px-2 py-1 text-sm bg-background"
            value={draft.competitorBrand}
            onChange={(e) => setDraft((d) => ({ ...d, competitorBrand: e.target.value }))} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground font-medium">Competitor Product</span>
          <input className="w-full rounded border px-2 py-1 text-sm bg-background"
            value={draft.competitorProduct}
            onChange={(e) => setDraft((d) => ({ ...d, competitorProduct: e.target.value }))} />
        </label>
      </div>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground font-medium">Entry Mode</span>
        <div className="flex gap-3">
          {(["net_direct", "mrp_discount"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name={`em-${line.id}`} checked={draft.entryMode === m}
                onChange={() => setDraft((d) => ({ ...d, entryMode: m }))} />
              <span className="text-xs">{ENTRY_MODE_LABELS[m]}</span>
            </label>
          ))}
        </div>
      </div>

      {draft.entryMode === "net_direct" ? (
        <label className="space-y-1 block">
          <span className="text-xs text-muted-foreground font-medium">Net Price (₹)</span>
          <input type="number" min="0" step="0.01"
            className="w-32 rounded border px-2 py-1 text-sm bg-background"
            value={draft.netPrice}
            onChange={(e) => setDraft((d) => ({ ...d, netPrice: e.target.value }))} />
        </label>
      ) : (
        <div className="flex gap-3 items-end">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground font-medium">Competitor MRP (₹)</span>
            <input type="number" min="0" step="0.01"
              className="w-28 rounded border px-2 py-1 text-sm bg-background"
              value={draft.mrp}
              onChange={(e) => setDraft((d) => ({ ...d, mrp: e.target.value }))} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground font-medium">Discount%</span>
            <input type="number" min="0" max="100" step="0.1"
              className="w-20 rounded border px-2 py-1 text-sm bg-background"
              value={draft.discountPct}
              onChange={(e) => setDraft((d) => ({ ...d, discountPct: e.target.value }))} />
          </label>
          {computedNet != null && !isNaN(computedNet) && (
            <span className="text-xs text-muted-foreground pb-1">→ Net {fmt(computedNet)}</span>
          )}
        </div>
      )}

      <label className="space-y-1 block">
        <span className="text-xs text-muted-foreground font-medium">Monthly Volume (units)</span>
        <input type="number" min="0" step="1"
          className="w-32 rounded border px-2 py-1 text-sm bg-background"
          value={draft.monthlyVolume}
          onChange={(e) => setDraft((d) => ({ ...d, monthlyVolume: e.target.value }))} />
      </label>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground font-medium">Reasons (why customer prefers competitor)</span>
        <div className="flex flex-wrap gap-2">
          {REASON_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1 cursor-pointer text-xs">
              <input type="checkbox" checked={draft.reasons.includes(value)}
                onChange={() => toggleReason(value)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <label className="space-y-1 block">
        <span className="text-xs text-muted-foreground font-medium">Note</span>
        <textarea rows={2}
          className="w-full rounded border px-2 py-1 text-sm bg-background resize-none"
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
      </label>

      <div className="flex gap-2">
        <button type="button" disabled={mut.isPending}
          onClick={() => mut.mutate()}
          className="rounded px-3 py-1 text-xs bg-primary text-primary-foreground font-medium disabled:opacity-60">
          {mut.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded px-3 py-1 text-xs border text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── LineRow ───────────────────────────────────────────────────────────────

function LineRow({
  line, recorderName, singleLine,
}: { line: SurveyLine; recorderName: string; singleLine: boolean }) {
  const [editing, setEditing] = useState(false);
  const lockInfo = fmtLock(new Date(line.createdAt).getTime() + 24 * 3600_000 > Date.now()
    ? new Date(new Date(line.createdAt).getTime() + 24 * 3600_000).toISOString()
    : "");

  return (
    <div className={`${singleLine ? "" : "pl-4 border-l ml-2"}`}>
      <div className="grid grid-cols-[1fr_auto] gap-2 py-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
          {line.segment && (
            <span className="text-xs rounded bg-muted px-1.5 py-0.5 font-medium">{line.segment}</span>
          )}
          {line.prayagItemCode && (
            <span className="text-xs text-muted-foreground">
              Code: <span className="font-mono">{line.prayagItemCode}</span>
              {line.itemName ? ` · ${line.itemName}` : ""}
            </span>
          )}
          {line.currentMrp != null && (
            <span className="text-xs text-muted-foreground">Our MRP: {fmt(line.currentMrp)}</span>
          )}
          <span className="font-medium text-sm">
            {line.competitorBrand}
            {line.competitorProduct ? ` · ${line.competitorProduct}` : ""}
          </span>
          <span className="text-sm font-semibold tabular-nums">{fmt(line.netPrice)}</span>
          {line.entryMode === "mrp_discount" && line.mrp != null && (
            <span className="text-xs text-muted-foreground">
              (MRP {fmt(line.mrp)}, {line.discountPct?.toFixed(1)}% off)
            </span>
          )}
          {line.unit !== "piece" && <span className="text-xs text-muted-foreground">/{line.unit}</span>}
          {line.packSize && <span className="text-xs text-muted-foreground">Pack: {line.packSize}</span>}
          {line.monthlyVolume != null && (
            <span className="text-xs text-muted-foreground">Vol: {line.monthlyVolume}/mo</span>
          )}
          {line.reasons.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Reasons: {line.reasons.join(", ")}
            </span>
          )}
          {line.note && <span className="text-xs text-muted-foreground italic">{line.note}</span>}
          {/* Priority context — shown only when recorded */}
          {(line.creditDaysCompetitor != null || line.creditDaysPrayag != null || !!line.creditGivenBy) && (
            <span className="text-xs text-muted-foreground">
              {"Credit: "}
              {line.creditDaysCompetitor != null ? `comp ${line.creditDaysCompetitor}d` : ""}
              {line.creditDaysCompetitor != null && line.creditDaysPrayag != null ? " / " : ""}
              {line.creditDaysPrayag != null ? `Prayag ${line.creditDaysPrayag}d` : ""}
              {line.creditGivenBy ? ` (${line.creditGivenBy.replace("_", " ")})` : ""}
            </span>
          )}
          {(line.deliveryDaysCompetitor != null || line.deliveryDaysPrayag != null) && (
            <span className="text-xs text-muted-foreground">
              {"Delivery: "}
              {line.deliveryDaysCompetitor != null ? `comp ${line.deliveryDaysCompetitor}d` : ""}
              {line.deliveryDaysCompetitor != null && line.deliveryDaysPrayag != null ? " / " : ""}
              {line.deliveryDaysPrayag != null ? `Prayag ${line.deliveryDaysPrayag}d` : ""}
            </span>
          )}
          {!!line.competitorSchemeType && (
            <span className="text-xs text-muted-foreground">
              {"Scheme: "}{line.competitorSchemeType}
              {line.competitorSchemeValue ? ` — ${line.competitorSchemeValue}` : ""}
            </span>
          )}
          {!!line.shelfShare && (
            <span className="text-xs text-muted-foreground">Shelf: {line.shelfShare.replace(/_/g, " ")}</span>
          )}
          {!!line.wouldSwitch && (
            <span className="text-xs text-muted-foreground">Would switch: {line.wouldSwitch}</span>
          )}
        </div>
        <div className="flex items-start gap-1.5 shrink-0">
          {line.editable ? (
            <>
              {lockInfo && <span className="text-[10px] text-muted-foreground whitespace-nowrap">{lockInfo}</span>}
              {!editing && (
                <button type="button"
                  onClick={() => setEditing(true)}
                  className="text-[11px] rounded border px-2 py-0.5 text-muted-foreground hover:text-foreground">
                  Edit
                </button>
              )}
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground" title="Edit window closed after 24h">🔒</span>
          )}
        </div>
      </div>
      {editing && (
        <EditForm
          line={line} recorderName={recorderName}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// ── SurveyCard ────────────────────────────────────────────────────────────

function SurveyCard({ survey, recorderName }: { survey: Survey; recorderName: string }) {
  return (
    <div className="rounded border bg-card px-4 py-3 space-y-1">
      {/* Retailer heading */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-medium text-sm">
          {survey.retailer}
          {survey.isPendingProspect && (
            <span className="ml-1.5 text-[10px] rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 font-semibold">PENDING</span>
          )}
        </span>
        {survey.state && (
          <span className="text-xs text-muted-foreground">
            {survey.state}{survey.district ? ` · ${survey.district}` : ""}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{fmtDate(survey.submittedAt)}</span>
        <span className="text-xs text-muted-foreground" title="Self-declared — not verified">
          ⚠ {survey.recordedBy}
        </span>
      </div>
      {/* Lines */}
      <div className="space-y-0.5 mt-1">
        {survey.lines.map((line) => (
          <LineRow key={line.id} line={line} recorderName={recorderName} singleLine={survey.lines.length === 1} />
        ))}
      </div>
    </div>
  );
}

// ── GroupSection ──────────────────────────────────────────────────────────

function GroupSection({ group, recorderName }: { group: Group; recorderName: string }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-2">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left">
        <span className="text-sm font-semibold">{TYPE_LABELS[group.surveyType] ?? group.surveyType}</span>
        <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{group.rowCount} line{group.rowCount !== 1 ? "s" : ""}</span>
        {group.combinedValue != null && (
          <span className="text-xs text-muted-foreground">
            · combined vol value {fmt(group.combinedValue)}
          </span>
        )}
        <span className="ml-auto text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-2">
          {group.surveys.map((s) => (
            <SurveyCard key={s.surveyId} survey={s} recorderName={recorderName} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Filters ───────────────────────────────────────────────────────────────

interface Filters {
  stateHead: string; state: string; segment: string;
  brand: string; recorder: string; dateFrom: string; dateTo: string;
}

const EMPTY_FILTERS: Filters = {
  stateHead: "", state: "", segment: "", brand: "", recorder: "", dateFrom: "", dateTo: "",
};

function buildQueryString(f: Filters) {
  const p = new URLSearchParams();
  if (f.stateHead) p.set("stateHead", f.stateHead);
  if (f.state)     p.set("state",     f.state);
  if (f.segment)   p.set("segment",   f.segment);
  if (f.brand)     p.set("brand",     f.brand);
  if (f.recorder)  p.set("recorder",  f.recorder);
  if (f.dateFrom)  p.set("dateFrom",  f.dateFrom);
  if (f.dateTo)    p.set("dateTo",    f.dateTo);
  return p.toString();
}

// ── Main ──────────────────────────────────────────────────────────────────

interface SubmissionsTabProps { recorderName: string }

export default function SubmissionsTab({ recorderName }: SubmissionsTabProps) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const stateHeadsQ = useQuery<{ rows: StateHead[] }>({
    queryKey: ["ms-state-heads"],
    queryFn: () => fetch(API("market-survey/state-heads")).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  const metaQ = useQuery<MetaResponse>({
    queryKey: ["ms-meta"],
    queryFn: () => fetch(API("market-survey/meta")).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  const qs = buildQueryString(applied);
  const dataQ = useQuery<SubmissionsData>({
    queryKey: ["ms-submissions", qs],
    queryFn: () => fetch(API(`market-survey/submissions${qs ? "?" + qs : ""}`)).then((r) => r.json()),
    staleTime: 30_000,
  });

  const applyFilters = useCallback(() => setApplied({ ...filters }), [filters]);
  const clearFilters = useCallback(() => { setFilters(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }, []);

  const handleExport = useCallback(() => {
    const url = API(`market-survey/export${qs ? "?" + qs : ""}`);
    const a = document.createElement("a");
    a.href = url; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  }, [qs]);

  const activeFilterCount = Object.values(applied).filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Filters {activeFilterCount > 0 && <span className="ml-1 text-xs rounded-full bg-primary/10 text-primary px-2 py-0.5">{activeFilterCount} active</span>}</span>
          <div className="flex gap-2">
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters}
                className="text-xs text-muted-foreground hover:text-foreground border rounded px-2 py-0.5">
                Clear all
              </button>
            )}
            <button type="button" onClick={handleExport}
              className="text-xs border rounded px-3 py-0.5 text-muted-foreground hover:text-foreground">
              ↓ Export XLSX
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {/* State Head */}
          <label className="space-y-0.5">
            <span className="text-xs text-muted-foreground">State Head</span>
            <select className="w-full rounded border px-2 py-1 text-sm bg-background"
              value={filters.stateHead}
              onChange={(e) => setFilters((f) => ({ ...f, stateHead: e.target.value }))}>
              <option value="">— any —</option>
              {(stateHeadsQ.data?.rows ?? []).map((h) => (
                <option key={h.key} value={h.name}>{h.name}</option>
              ))}
            </select>
          </label>

          {/* Segment */}
          <label className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Segment</span>
            <select className="w-full rounded border px-2 py-1 text-sm bg-background"
              value={filters.segment}
              onChange={(e) => setFilters((f) => ({ ...f, segment: e.target.value }))}>
              <option value="">— any —</option>
              {(metaQ.data?.segments ?? []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          {/* Competitor Brand */}
          <label className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Competitor Brand</span>
            <input className="w-full rounded border px-2 py-1 text-sm bg-background"
              placeholder="e.g. Astral"
              value={filters.brand}
              onChange={(e) => setFilters((f) => ({ ...f, brand: e.target.value }))} />
          </label>

          {/* State */}
          <label className="space-y-0.5">
            <span className="text-xs text-muted-foreground">State</span>
            <input className="w-full rounded border px-2 py-1 text-sm bg-background"
              placeholder="e.g. RAJASTHAN"
              value={filters.state}
              onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))} />
          </label>

          {/* Recorder */}
          <label className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Recorder</span>
            <input className="w-full rounded border px-2 py-1 text-sm bg-background"
              placeholder="exact name"
              value={filters.recorder}
              onChange={(e) => setFilters((f) => ({ ...f, recorder: e.target.value }))} />
          </label>

          {/* Date range */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Date range</span>
            <div className="flex gap-1 items-center">
              <input type="date" className="rounded border px-2 py-1 text-sm bg-background w-full"
                value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} />
              <span className="text-xs text-muted-foreground">–</span>
              <input type="date" className="rounded border px-2 py-1 text-sm bg-background w-full"
                value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} />
            </div>
          </div>
        </div>

        <button type="button" onClick={applyFilters}
          className="rounded px-4 py-1.5 text-sm bg-primary text-primary-foreground font-medium">
          Apply Filters
        </button>
      </div>

      {/* Results */}
      {dataQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {dataQ.error && <p className="text-sm text-destructive">Failed to load submissions.</p>}

      {dataQ.data && (
        <>
          <p className="text-xs text-muted-foreground">
            {dataQ.data.total} row{dataQ.data.total !== 1 ? "s" : ""} recorded
            {activeFilterCount > 0 ? " (filtered)" : " total"}
          </p>

          {dataQ.data.groups.length === 0 && (
            <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground text-sm">
              No submissions match the current filters.
            </div>
          )}

          <div className="space-y-6">
            {dataQ.data.groups.map((g) => (
              <GroupSection key={g.surveyType} group={g} recorderName={recorderName} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
