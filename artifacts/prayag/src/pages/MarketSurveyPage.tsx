// Market Survey — record competitor prices observed during retailer visits.
//
// Recorder identity: self-reported name stored in localStorage (no API key required).
// Form: full-width single scroll, 4 numbered sections.
// Results: collapsed to one line when empty; expands when data exists.
//
// Cascade: State Head → State → Distributor → Retailer / + New prospect
// Products: Segment dropdown → searchable Item Code → shows our MRP inline
//
// New distributors/retailers go to market_survey_prospect (pending review),
// NOT directly to customer_master. DO NOT feed competitor prices into MRP
// calculations or pricing recommendations.

import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL;
const API  = (path: string) => `${BASE}api/${path}`;
const LS_RECORDER = "prayag_ms_recorder";
// The old market-survey page stored a shared API key under "prayag_api_key".
// Clear it on load so stale credentials do not linger on field devices.
try { localStorage.removeItem("prayag_api_key"); } catch { /* ignore */ }

// ── Types ─────────────────────────────────────────────────────────────────

interface StateHead { key: string; name: string }
interface HierarchyState { canon: string; parent: string; isSplit: boolean }
interface CustomerRow { id: string; company: string; state: string | null; district: string | null }
interface ItemRow {
  itemCode: string; itemName: string | null;
  currentMrp: number | null; effectiveFrom: string | null;
}
interface MetaResponse {
  segments: string[];
  knownBrands: { brand: string; surveyCount: number }[];
}
interface SurveyRow {
  id: number; surveyedAt: string; recordedBy: string;
  isExistingBuyer: boolean; customerId: string | null; customerCompany: string | null;
  prospectName: string | null; state: string | null; district: string | null;
  segment: string; prayagItemCode: string | null;
  competitorBrand: string; competitorProduct: string | null;
  netPrice: number; unit: string; reasons: string[];
  note: string | null; createdAt: string; editable: boolean;
}
interface SummaryRow {
  itemCode: string; segment: string; itemName: string | null;
  currentMrp: number | null; n: number; indicativeOnly: boolean;
  medianCompetitorNet: number; minNet: number; maxNet: number;
}
interface BrandRow {
  brand: string; n: number; segments: string[];
  minNet: number; maxNet: number; medianNet: number;
}
interface ProspectRow {
  id: number; name: string; contact: string; contactPerson: string | null;
  district: string; state: string; type: string;
  submittedBy: string; submittedAt: string; status: string;
}

const REASON_OPTIONS = [
  { value: "price",         label: "Better price" },
  { value: "availability",  label: "Better availability" },
  { value: "credit_terms",  label: "Better credit terms" },
  { value: "relationship",  label: "Stronger relationship" },
  { value: "scheme",        label: "Better scheme" },
  { value: "quality",       label: "Perceived quality" },
];
const UNIT_OPTIONS = ["piece", "box", "carton", "kg", "litre", "set"];

// ── Tiny helpers ──────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
function fmtDateLong(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// ── Form atoms ─────────────────────────────────────────────────────────────

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Inp({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm
                  focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
function Sel({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm
                  focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50
                  disabled:cursor-not-allowed ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}
function SectionHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
        {n}
      </span>
      <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  );
}
function Divider() {
  return <div className="border-t my-6" />;
}

// ── Recorder banner ───────────────────────────────────────────────────────

function RecorderBanner({ name, onChange }: { name: string; onChange: (n: string) => void }) {
  const [editing, setEditing] = useState(!name);
  const [draft, setDraft] = useState(name);

  if (editing) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-amber-50 px-4 py-2 text-sm">
        <span className="text-amber-700 font-medium shrink-0">Who are you?</span>
        <input
          className="flex-1 bg-transparent outline-none text-sm"
          placeholder="Your name (saved locally)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = draft.trim();
              if (v) { onChange(v); setEditing(false); }
            }
          }}
          autoFocus
        />
        <button
          className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
          disabled={!draft.trim()}
          onClick={() => { const v = draft.trim(); if (v) { onChange(v); setEditing(false); } }}
        >
          Save
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
      <span className="flex-1 text-muted-foreground">
        Recording as <span className="font-medium text-foreground">{name}</span>
      </span>
      <button
        className="text-xs text-muted-foreground underline"
        onClick={() => { setDraft(name); setEditing(true); }}
      >
        change
      </button>
    </div>
  );
}

// ── Inline new-prospect panel ──────────────────────────────────────────────

interface ProspectDraft {
  name: string; contact: string; contactPerson: string;
  address: string; district: string; area: string;
  pincode: string; gst: string;
}
const EMPTY_DRAFT: ProspectDraft = {
  name: "", contact: "", contactPerson: "",
  address: "", district: "", area: "", pincode: "", gst: "",
};

function NewProspectPanel({
  type, state, forDistributorId, submittedBy, onCreated, onCancel,
}: {
  type: "Distributor" | "Retailer";
  state: string;
  forDistributorId?: string;
  submittedBy: string;
  onCreated: (id: number, name: string) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<ProspectDraft>(EMPTY_DRAFT);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (p: Partial<ProspectDraft>) => setD((prev) => ({ ...prev, ...p }));

  const canSubmit = !!d.name.trim() && !!d.contact.trim() && !!d.district.trim() && !!submittedBy;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true); setErr(null);
    try {
      const r = await fetch(API("market-survey/prospect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: d.name.trim(), contact: d.contact.trim(),
          contactPerson: d.contactPerson.trim() || null,
          address: d.address.trim() || null,
          district: d.district.trim(),
          state,
          area: d.area.trim() || null,
          pincode: d.pincode.trim() || null,
          gst: d.gst.trim() || null,
          type,
          forDistributorId: forDistributorId || null,
          submittedBy,
        }),
      });
      if (!r.ok) {
        const b = await r.json();
        throw new Error(b.error ?? `HTTP ${r.status}`);
      }
      const { id } = (await r.json()) as { id: number };
      onCreated(id, d.name.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setPending(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
        New {type} — pending review
      </div>
      <p className="text-xs text-amber-700">
        This will NOT create a customer record immediately — it goes to the Review Queue
        for manual approval. The survey is saved regardless.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required>
          <Inp placeholder={`${type} name`} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Contact number" required>
          <Inp placeholder="Mobile / phone" value={d.contact} onChange={(e) => set({ contact: e.target.value })} />
        </Field>
        <Field label="Contact person">
          <Inp placeholder="Owner / manager name" value={d.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} />
        </Field>
        <Field label="District" required>
          <Inp placeholder="District" value={d.district} onChange={(e) => set({ district: e.target.value })} />
        </Field>
        <Field label="Area / locality">
          <Inp placeholder="Colony or area" value={d.area} onChange={(e) => set({ area: e.target.value })} />
        </Field>
        <Field label="Pincode">
          <Inp placeholder="6-digit pincode" value={d.pincode} onChange={(e) => set({ pincode: e.target.value })} />
        </Field>
        <Field label="Address">
          <Inp placeholder="Street address" value={d.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="GST number (optional)">
          <Inp placeholder="GSTIN" value={d.gst} onChange={(e) => set({ gst: e.target.value })} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">State: <strong>{state}</strong> (from cascade — not re-asked)</p>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <button
          className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          disabled={!canSubmit || pending}
          onClick={submit}
        >
          {pending ? "Saving…" : `Add ${type} to Review Queue`}
        </button>
        <button className="text-xs underline text-muted-foreground" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

// ── Searchable item code dropdown ─────────────────────────────────────────

function ItemCodePicker({
  items, value, onChange, disabled,
}: {
  items: ItemRow[];
  value: string;
  onChange: (code: string, name: string | null, mrp: number | null, effectiveFrom: string | null) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const chosen = items.find((i) => i.itemCode === value);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 60);
    return items.filter(
      (i) =>
        i.itemCode.toLowerCase().includes(t) ||
        (i.itemName ?? "").toLowerCase().includes(t),
    ).slice(0, 60);
  }, [items, q]);

  if (value && chosen) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="font-medium font-mono">{chosen.itemCode}</span>
          {chosen.itemName && <span className="text-muted-foreground truncate">{chosen.itemName}</span>}
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline"
            onClick={() => { onChange("", null, null, null); setQ(""); }}
          >
            clear
          </button>
        </div>
        {chosen.currentMrp != null && (
          <div className="flex items-center gap-2 rounded-md bg-blue-50 border border-blue-100 px-3 py-1.5 text-sm">
            <span className="text-blue-700 font-medium">Our MRP: ₹{chosen.currentMrp.toFixed(2)}</span>
            {chosen.effectiveFrom && (
              <span className="text-blue-500 text-xs">
                (effective {fmtDateLong(chosen.effectiveFrom)})
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <Inp
        placeholder={disabled ? "Select a segment first" : `Search ${items.length} codes…`}
        value={q}
        disabled={disabled}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && !disabled && filtered.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border bg-popover shadow-md">
          {filtered.map((i) => (
            <li
              key={`${i.itemCode}-${i.itemName}`}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
              onMouseDown={() => {
                onChange(i.itemCode, i.itemName, i.currentMrp, i.effectiveFrom);
                setQ(""); setOpen(false);
              }}
            >
              <span className="font-mono font-medium">{i.itemCode}</span>
              {i.itemName && <span className="ml-2 text-muted-foreground text-xs">{i.itemName}</span>}
              {i.currentMrp != null && (
                <span className="float-right text-xs text-blue-600">MRP ₹{i.currentMrp.toFixed(2)}</span>
              )}
            </li>
          ))}
          {q && filtered.length === 60 && (
            <li className="px-3 py-1 text-xs text-muted-foreground italic">Showing first 60 — type more to narrow</li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── Display tabs ──────────────────────────────────────────────────────────

function IndicativeBadge() {
  return (
    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
      indicative only
    </span>
  );
}

function MyRecentTab({ recorderName }: { recorderName: string }) {
  const { data, isPending } = useQuery<{ rows: SurveyRow[] }>({
    queryKey: ["ms-list", recorderName],
    queryFn: () =>
      fetch(API(`market-survey?recorder=${encodeURIComponent(recorderName)}&limit=30`)).then((r) => r.json()),
    enabled: !!recorderName,
  });

  if (!recorderName) return <p className="text-sm text-muted-foreground p-4">Set your name above to see recent submissions.</p>;
  if (isPending) return <p className="text-sm text-muted-foreground p-4">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-4">No surveys recorded yet as {recorderName}.</p>;

  return (
    <div className="divide-y text-sm">
      {data.rows.map((r) => (
        <div key={r.id} className="py-3 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="font-medium">{r.competitorBrand}</span>
              {r.competitorProduct && <span className="text-muted-foreground ml-1">· {r.competitorProduct}</span>}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {fmtDate(r.createdAt)}
              {r.editable && <span className="ml-1 text-amber-600">(editable)</span>}
            </span>
          </div>
          <div className="text-muted-foreground">
            <span className="text-foreground font-medium">₹{r.netPrice.toFixed(2)}</span>
            {" / "}{r.unit} · {r.segment}
            {r.prayagItemCode && <span className="ml-1 font-mono text-xs">[{r.prayagItemCode}]</span>}
          </div>
          <div className="text-muted-foreground text-xs">
            {r.isExistingBuyer ? r.customerCompany : r.prospectName}
            {r.state && <span> · {r.state}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

interface CpRow {
  prayagItemCode: string | null;
  mrp: number | null; netPriceDerived: number | null;
  discountPctAssumed: number | null;
}

function SummaryTab() {
  const { data, isPending } = useQuery<{ rows: SummaryRow[] }>({
    queryKey: ["ms-summary"],
    queryFn: () => fetch(API("market-survey/summary")).then((r) => r.json()),
  });
  const { data: cpData } = useQuery<{ rows: CpRow[]; snapshotFetchedAt: string | null }>({
    queryKey: ["cp-rows-mapped"],
    queryFn: () => fetch(`${BASE}api/competitor-price?mappedOnly=true`).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });
  const cpByCode = new Map<string, CpRow>();
  for (const cp of cpData?.rows ?? []) {
    if (cp.prayagItemCode && !cpByCode.has(cp.prayagItemCode)) cpByCode.set(cp.prayagItemCode, cp);
  }
  const cpAt = cpData?.snapshotFetchedAt ? fmtDateLong(cpData.snapshotFetchedAt) : null;

  if (isPending) return <p className="text-sm text-muted-foreground p-2">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-2">No data with mapped Prayag codes yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-2 text-left">Code</th>
            <th className="py-2 text-left">Segment</th>
            <th className="py-2 text-right">Our MRP</th>
            <th className="py-2 text-right">Comp. MRP</th>
            <th className="py-2 text-right">Comp. net <span className="font-normal">(derived)</span></th>
            <th className="py-2 text-right">Survey median</th>
            <th className="py-2 text-right">Range</th>
            <th className="py-2 text-right">n</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.rows.map((r) => {
            const cp = cpByCode.get(r.itemCode);
            return (
              <tr key={`${r.segment}/${r.itemCode}`} className="hover:bg-muted/40">
                <td className="py-1.5 font-mono font-medium">
                  {r.itemCode}{r.indicativeOnly && <IndicativeBadge />}
                </td>
                <td className="py-1.5 text-muted-foreground">{r.segment}</td>
                <td className="py-1.5 text-right">{r.currentMrp != null ? `₹${r.currentMrp}` : "—"}</td>
                <td className="py-1.5 text-right">
                  {cp?.mrp != null ? `₹${cp.mrp.toFixed(2)}` : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-1.5 text-right">
                  {cp?.netPriceDerived != null
                    ? <span className="text-muted-foreground">₹{cp.netPriceDerived.toFixed(2)}</span>
                    : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-1.5 text-right font-medium">₹{r.medianCompetitorNet.toFixed(2)}</td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {r.minNet === r.maxNet ? "—" : `₹${r.minNet.toFixed(0)}–${r.maxNet.toFixed(0)}`}
                </td>
                <td className="py-1.5 text-right">{r.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Indicative = fewer than 5 surveys. Comp. net derived at 40% off Sparsh Pearl MRP — not observed.
        {cpAt && <span className="ml-1">Snapshot: {cpAt}.</span>}
      </p>
    </div>
  );
}

function BrandsTab() {
  const { data, isPending } = useQuery<{ rows: BrandRow[] }>({
    queryKey: ["ms-by-brand"],
    queryFn: () => fetch(API("market-survey/by-brand")).then((r) => r.json()),
  });
  if (isPending) return <p className="text-sm text-muted-foreground p-2">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-2">No surveys yet.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="py-2 text-left">Brand</th>
          <th className="py-2 text-left">Segments</th>
          <th className="py-2 text-right">Surveys</th>
          <th className="py-2 text-right">Median net</th>
          <th className="py-2 text-right">Range</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {data.rows.map((r) => (
          <tr key={r.brand} className="hover:bg-muted/40">
            <td className="py-1.5 font-medium">{r.brand}</td>
            <td className="py-1.5 text-muted-foreground text-xs">{r.segments.join(", ")}</td>
            <td className="py-1.5 text-right">{r.n}</td>
            <td className="py-1.5 text-right">₹{r.medianNet.toFixed(2)}</td>
            <td className="py-1.5 text-right text-muted-foreground">
              {r.minNet === r.maxNet ? "—" : `₹${r.minNet.toFixed(0)}–${r.maxNet.toFixed(0)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type DisplayTab = "recent" | "summary" | "brands";

// ── Form state ────────────────────────────────────────────────────────────

interface FormState {
  // Cascade
  stateHeadKey: string; stateHeadName: string;
  selectedState: string;
  distributorId: string; distributorName: string;
  retailerId: string; retailerName: string;
  pendingProspectId: number | null;
  // new-prospect panels
  showNewDist: boolean; showNewRetailer: boolean;
  // Product
  segment: string;
  prayagItemCode: string; prayagItemName: string | null;
  currentMrp: number | null; mrpEffectiveFrom: string | null;
  itemSearch: string;
  competitorBrand: string; competitorProduct: string;
  // Price
  entryMode: "net_direct" | "mrp_discount";
  netPrice: string; mrp: string; discountPct: string;
  unit: string; packSize: string;
  // Context
  reasons: string[]; monthlyVolume: string; note: string;
}

const EMPTY: FormState = {
  stateHeadKey: "", stateHeadName: "",
  selectedState: "",
  distributorId: "", distributorName: "",
  retailerId: "", retailerName: "",
  pendingProspectId: null,
  showNewDist: false, showNewRetailer: false,
  segment: "",
  prayagItemCode: "", prayagItemName: null,
  currentMrp: null, mrpEffectiveFrom: null, itemSearch: "",
  competitorBrand: "", competitorProduct: "",
  entryMode: "net_direct",
  netPrice: "", mrp: "", discountPct: "",
  unit: "piece", packSize: "",
  reasons: [], monthlyVolume: "", note: "",
};

function computeNet(mrp: string, d: string): number | null {
  const m = parseFloat(mrp), dp = parseFloat(d);
  if (!isFinite(m) || m <= 0 || !isFinite(dp) || dp < 0 || dp >= 100) return null;
  return Math.round(m * (1 - dp / 100) * 100) / 100;
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function MarketSurveyPage() {
  const [recorderName, setRecorderNameState] = useState<string>(() => {
    try { return localStorage.getItem(LS_RECORDER) ?? ""; } catch { return ""; }
  });
  const setRecorderName = useCallback((name: string) => {
    setRecorderNameState(name);
    try { localStorage.setItem(LS_RECORDER, name); } catch { /* */ }
  }, []);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [displayTab, setDisplayTab] = useState<DisplayTab>("recent");
  const qc = useQueryClient();

  const set = useCallback((p: Partial<FormState>) => setForm((f) => ({ ...f, ...p })), []);

  // ── Server data ─────────────────────────────────────────────────────────

  const stateHeadsQ = useQuery<{ rows: StateHead[] }>({
    queryKey: ["ms-state-heads"],
    queryFn: () => fetch(API("market-survey/state-heads")).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  const statesQ = useQuery<{ states: HierarchyState[] }>({
    queryKey: ["ms-cascade-states"],
    queryFn: () => fetch(API("market-survey/cascade-states")).then((r) => r.json()),
    staleTime: 60 * 60_000,
  });

  const distsQ = useQuery<{ rows: CustomerRow[]; total: number }>({
    queryKey: ["ms-distributors", form.selectedState],
    queryFn: () =>
      fetch(API(`market-survey/distributors?state=${encodeURIComponent(form.selectedState)}`)).then((r) => r.json()),
    enabled: !!form.selectedState,
    staleTime: 5 * 60_000,
  });

  const retailersQ = useQuery<{ rows: CustomerRow[]; total: number }>({
    queryKey: ["ms-retailers", form.distributorId],
    queryFn: () =>
      fetch(API(`market-survey/retailers?distributorId=${encodeURIComponent(form.distributorId)}`)).then((r) => r.json()),
    enabled: !!form.distributorId,
    staleTime: 5 * 60_000,
  });

  const metaQ = useQuery<MetaResponse>({
    queryKey: ["ms-meta"],
    queryFn: () => fetch(API("market-survey/meta")).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  const itemsQ = useQuery<{ rows: ItemRow[]; total: number }>({
    queryKey: ["ms-items", form.segment],
    queryFn: () =>
      fetch(API(`market-survey/items?segment=${encodeURIComponent(form.segment)}`)).then((r) => r.json()),
    enabled: !!form.segment,
    staleTime: 30 * 60_000,
  });

  // Effective states (expand parent to its splits)
  const allHierStates = statesQ.data?.states ?? [];
  const effectiveStates = useMemo(() => {
    if (!form.selectedState) return [];
    const chosen = allHierStates.find((s) => s.canon === form.selectedState);
    if (!chosen) return [form.selectedState];
    // Check if this state has children
    const children = allHierStates.filter((s) => s.parent === chosen.canon && s.canon !== chosen.canon);
    return children.length > 0 ? children.map((c) => c.canon) : [form.selectedState];
  }, [form.selectedState, allHierStates]);

  // ── Cascade helpers ─────────────────────────────────────────────────────

  const distsCount = distsQ.data?.total ?? 0;
  const retailCount = retailersQ.data?.total ?? 0;

  // Retailer identity: existing customer OR a submitted pending prospect
  const hasRetailer = !!form.retailerId || form.pendingProspectId != null;
  const retailerLabel = form.pendingProspectId != null
    ? `${form.retailerName} (pending approval)`
    : form.retailerName;

  // ── Submit ──────────────────────────────────────────────────────────────

  const canSubmit =
    !!recorderName &&
    (!!form.retailerId || form.pendingProspectId != null) &&
    !!form.segment && !!form.competitorBrand &&
    (form.entryMode === "net_direct"
      ? !!form.netPrice && parseFloat(form.netPrice) > 0
      : computeNet(form.mrp, form.discountPct) !== null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!canSubmit) throw new Error("Form is not complete");

      const body: Record<string, unknown> = {
        recorderName,
        isExistingBuyer: !!form.retailerId,
        segment:         form.segment,
        competitorBrand: form.competitorBrand,
        entryMode:       form.entryMode,
        unit:            form.unit,
        reasons:         form.reasons,
        state:           form.selectedState || undefined,
      };

      if (form.retailerId) {
        body.customerId = form.retailerId;
      } else if (form.pendingProspectId != null) {
        body.prospectName    = form.retailerName;
        body.pendingProspectId = form.pendingProspectId;
        body.state           = form.selectedState || undefined;
      }

      if (form.prayagItemCode)   body.prayagItemCode    = form.prayagItemCode;
      if (form.competitorProduct) body.competitorProduct = form.competitorProduct;
      if (form.packSize)         body.packSize          = form.packSize;
      if (form.note)             body.note              = form.note;
      if (form.monthlyVolume)    body.monthlyVolume     = parseFloat(form.monthlyVolume);
      if (form.distributorId)    body.district          = distsQ.data?.rows.find((d) => d.id === form.distributorId)?.district ?? undefined;

      if (form.entryMode === "net_direct") {
        body.netPrice = parseFloat(form.netPrice);
      } else {
        body.mrp        = parseFloat(form.mrp);
        body.discountPct = parseFloat(form.discountPct);
      }

      const r = await fetch(API("market-survey"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ id: number; netPrice: number; recordedBy: string }>;
    },
    onSuccess: (data) => {
      setSuccess(`Saved (id ${data.id}) — net ₹${data.netPrice.toFixed(2)} by ${data.recordedBy}`);
      setError(null);
      setForm(EMPTY);
      qc.invalidateQueries({ queryKey: ["ms-list"] });
      qc.invalidateQueries({ queryKey: ["ms-summary"] });
      qc.invalidateQueries({ queryKey: ["ms-by-brand"] });
      qc.invalidateQueries({ queryKey: ["ms-meta"] });
      setDisplayTab("recent");
    },
    onError: (e: Error) => { setError(e.message); setSuccess(null); },
  });

  // Does any data exist?
  const summaryQ = useQuery<{ rows: SummaryRow[] }>({
    queryKey: ["ms-summary"],
    queryFn: () => fetch(API("market-survey/summary")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  const hasData = (summaryQ.data?.rows.length ?? 0) > 0;

  const computedNet = form.entryMode === "mrp_discount" ? computeNet(form.mrp, form.discountPct) : null;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto w-full">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold">Market Survey</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Record competitor prices observed during retailer visits.
          Data is for internal analysis only — never feeds directly into pricing.
        </p>
      </div>

      {/* Recorder */}
      <RecorderBanner name={recorderName} onChange={setRecorderName} />

      {/* ─── FORM ──────────────────────────────────────────────────────── */}
      <form
        className="rounded-lg border bg-card p-6 space-y-0"
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }}
      >
        {/* ── Section 1: Scope cascade ─── */}
        <SectionHeader n={1} title="Retailer" />

        <div className="space-y-4">
          {/* State Head */}
          <Field label="State Head">
            <Sel
              value={form.stateHeadKey}
              onChange={(e) => {
                const head = stateHeadsQ.data?.rows.find((h) => h.key === e.target.value);
                set({
                  stateHeadKey: e.target.value,
                  stateHeadName: head?.name ?? "",
                  selectedState: "", distributorId: "", distributorName: "",
                  retailerId: "", retailerName: "", pendingProspectId: null,
                  showNewDist: false, showNewRetailer: false,
                });
              }}
            >
              <option value="">— select state head —</option>
              {(stateHeadsQ.data?.rows ?? []).map((h) => (
                <option key={h.key} value={h.key}>{h.name}</option>
              ))}
            </Sel>
          </Field>

          {/* State */}
          <Field
            label={`State${distsCount && form.selectedState ? ` · ${distsCount} distributor${distsCount !== 1 ? "s" : ""} in ${effectiveStates.join(" + ")}` : ""}`}
          >
            <Sel
              value={form.selectedState}
              onChange={(e) => {
                set({
                  selectedState: e.target.value,
                  distributorId: "", distributorName: "",
                  retailerId: "", retailerName: "", pendingProspectId: null,
                  showNewDist: false, showNewRetailer: false,
                });
              }}
            >
              <option value="">— select state —</option>
              {(statesQ.data?.states ?? []).map((s) => (
                <option key={s.canon} value={s.canon}>
                  {s.canon}{s.isSplit ? "" : " (all)"}
                </option>
              ))}
            </Sel>
          </Field>

          {/* Distributor */}
          <Field
            label={`Distributor${form.selectedState && !form.showNewDist ? (distsQ.isLoading ? " (loading…)" : distsCount === 0 ? " (none in this state)" : ` (${distsCount})`) : ""}`}
          >
            {form.showNewDist ? (
              <NewProspectPanel
                type="Distributor"
                state={form.selectedState}
                submittedBy={recorderName}
                onCreated={(id, name) => {
                  set({
                    distributorId: "", distributorName: name,
                    pendingProspectId: id, showNewDist: false,
                    retailerId: "", retailerName: "", showNewRetailer: false,
                  });
                }}
                onCancel={() => set({ showNewDist: false })}
              />
            ) : (
              <Sel
                disabled={!form.selectedState || distsQ.isLoading}
                value={form.distributorId}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    set({
                      distributorId: "", distributorName: "",
                      showNewDist: true,
                      retailerId: "", retailerName: "", pendingProspectId: null, showNewRetailer: false,
                    });
                    return;
                  }
                  const dist = distsQ.data?.rows.find((d) => d.id === e.target.value);
                  set({
                    distributorId: e.target.value,
                    distributorName: dist?.company ?? "",
                    retailerId: "", retailerName: "", pendingProspectId: null,
                    showNewRetailer: false,
                  });
                }}
              >
                <option value="">
                  {!form.selectedState
                    ? "Select a state first"
                    : distsQ.isLoading
                    ? "Loading…"
                    : distsCount === 0
                    ? "No distributors in this state"
                    : "— select distributor —"}
                </option>
                {(distsQ.data?.rows ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.company}{d.district ? ` · ${d.district}` : ""}
                  </option>
                ))}
                {!!form.selectedState && <option value="__new__">+ New distributor</option>}
              </Sel>
            )}
          </Field>

          {/* Retailer */}
          {!form.showNewDist && (
            <Field
              label={`Retailer${form.distributorId ? ` (${retailCount} linked to this distributor)` : ""}`}
              required
            >
              {form.showNewRetailer ? (
                <NewProspectPanel
                  type="Retailer"
                  state={form.selectedState}
                  forDistributorId={form.distributorId || undefined}
                  submittedBy={recorderName}
                  onCreated={(id, name) => {
                    set({ retailerId: "", retailerName: name, pendingProspectId: id, showNewRetailer: false });
                  }}
                  onCancel={() => set({ showNewRetailer: false })}
                />
              ) : form.retailerId || form.pendingProspectId != null ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                  <span className="flex-1">{retailerLabel}</span>
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground"
                    onClick={() => set({ retailerId: "", retailerName: "", pendingProspectId: null })}
                  >
                    clear
                  </button>
                </div>
              ) : (
                <Sel
                  disabled={!form.distributorId || retailersQ.isLoading}
                  value={form.retailerId}
                  onChange={(e) => {
                    if (e.target.value === "__new__") {
                      set({ showNewRetailer: true, retailerId: "", retailerName: "", pendingProspectId: null });
                      return;
                    }
                    const ret = retailersQ.data?.rows.find((r) => r.id === e.target.value);
                    set({ retailerId: e.target.value, retailerName: ret?.company ?? "" });
                  }}
                >
                  <option value="">
                    {!form.distributorId
                      ? "Select a distributor first"
                      : retailersQ.isLoading
                      ? "Loading…"
                      : retailCount === 0
                      ? "No retailers linked — use + New"
                      : "— select retailer —"}
                  </option>
                  {(retailersQ.data?.rows ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.company}{r.district ? ` · ${r.district}` : ""}
                    </option>
                  ))}
                  {!!form.distributorId && <option value="__new__">+ New retailer</option>}
                </Sel>
              )}
              {retailCount > 0 && !form.retailerId && !form.showNewRetailer && form.pendingProspectId == null && (
                <p className="text-xs text-muted-foreground">
                  A retailer can appear under multiple distributors — they show under every distributor they're linked to.
                </p>
              )}
            </Field>
          )}
        </div>

        <Divider />

        {/* ── Section 2: What they buy ─── */}
        <SectionHeader n={2} title="What they buy" />

        <div className="space-y-4">
          {/* Segment */}
          <Field label="Segment" required>
            <Sel
              value={form.segment}
              onChange={(e) =>
                set({ segment: e.target.value, prayagItemCode: "", prayagItemName: null, currentMrp: null, mrpEffectiveFrom: null })
              }
            >
              <option value="">— select segment —</option>
              {(metaQ.data?.segments ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </Sel>
          </Field>

          {/* Item Code */}
          <Field
            label={`Prayag item code (optional)${form.segment && itemsQ.data ? ` · ${itemsQ.data.total} in ${form.segment}` : ""}`}
          >
            <ItemCodePicker
              items={itemsQ.data?.rows ?? []}
              value={form.prayagItemCode}
              disabled={!form.segment}
              onChange={(code, name, mrp, eff) =>
                set({ prayagItemCode: code, prayagItemName: name, currentMrp: mrp, mrpEffectiveFrom: eff })
              }
            />
          </Field>

          {/* Competitor brand */}
          <Field label="Competitor brand" required>
            <div className="relative">
              <Inp
                placeholder="e.g. Astral, Finolex, Supreme…"
                value={form.competitorBrand}
                onChange={(e) => set({ competitorBrand: e.target.value })}
                list="ms-brand-list"
              />
              <datalist id="ms-brand-list">
                {(metaQ.data?.knownBrands ?? []).map((b) => (
                  <option key={b.brand} value={b.brand} />
                ))}
              </datalist>
            </div>
          </Field>

          {/* Competitor product */}
          <Field label="Competitor product / code (optional)">
            <Inp
              placeholder="Their product description or code"
              value={form.competitorProduct}
              onChange={(e) => set({ competitorProduct: e.target.value })}
            />
          </Field>
        </div>

        <Divider />

        {/* ── Section 3: Price ─── */}
        <SectionHeader n={3} title="The price" />

        <div className="space-y-4">
          <Field label="How are you entering the price?" required>
            <div className="flex gap-4">
              {(["net_direct", "mrp_discount"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={form.entryMode === m}
                    onChange={() => set({ entryMode: m, netPrice: "", mrp: "", discountPct: "" })}
                  />
                  <span className="text-sm">{m === "net_direct" ? "Net price the retailer pays" : "MRP + discount %"}</span>
                </label>
              ))}
            </div>
          </Field>

          {form.entryMode === "net_direct" ? (
            <Field label="Net price (₹ per unit)" required>
              <Inp
                type="number" min="0.01" step="0.01" placeholder="0.00"
                value={form.netPrice}
                onChange={(e) => set({ netPrice: e.target.value })}
              />
            </Field>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="MRP (₹)" required>
                  <Inp type="number" min="0.01" step="0.01" placeholder="0.00"
                    value={form.mrp} onChange={(e) => set({ mrp: e.target.value })} />
                </Field>
                <Field label="Discount (%)" required>
                  <Inp type="number" min="0" max="99.99" step="0.01" placeholder="0.00"
                    value={form.discountPct} onChange={(e) => set({ discountPct: e.target.value })} />
                </Field>
              </div>
              {computedNet !== null && (
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  Net price: <span className="font-semibold">₹{computedNet.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit">
              <Sel value={form.unit} onChange={(e) => set({ unit: e.target.value })}>
                {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
              </Sel>
            </Field>
            <Field label="Pack size (if different)">
              <Inp placeholder="e.g. 10 pcs/box" value={form.packSize}
                onChange={(e) => set({ packSize: e.target.value })} />
            </Field>
          </div>
        </div>

        <Divider />

        {/* ── Section 4: Context (optional) ─── */}
        <SectionHeader n={4} title="Context (optional)" />

        <div className="space-y-4">
          <Field label="Why does the retailer buy from them?">
            <div className="grid grid-cols-2 gap-y-2 gap-x-4">
              {REASON_OPTIONS.map((r) => (
                <label key={r.value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.reasons.includes(r.value)}
                    onChange={(e) =>
                      set({
                        reasons: e.target.checked
                          ? [...form.reasons, r.value]
                          : form.reasons.filter((v) => v !== r.value),
                      })
                    }
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Approximate monthly volume">
              <Inp type="number" min="0" step="1" placeholder="units per month"
                value={form.monthlyVolume} onChange={(e) => set({ monthlyVolume: e.target.value })} />
            </Field>
            <div /> {/* spacer */}
          </div>

          <Field label="Notes">
            <textarea
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm
                         focus:outline-none focus:ring-2 focus:ring-ring"
              rows={2}
              placeholder="Anything else worth capturing"
              value={form.note}
              onChange={(e) => set({ note: e.target.value })}
            />
          </Field>
        </div>

        {/* Submit */}
        <div className="mt-6 space-y-3">
          {error   && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          {success && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}

          {!recorderName && (
            <p className="text-xs text-amber-700">Set your name at the top to submit surveys.</p>
          )}

          <button
            type="submit"
            disabled={!canSubmit || mutation.isPending}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground
                       hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : "Submit Survey"}
          </button>
        </div>
      </form>

      {/* ─── RESULTS PANEL ─────────────────────────────────────────────── */}
      {!hasData ? (
        <p className="text-sm text-muted-foreground text-center py-2">
          Submit a survey with a Prayag product code to see competitor comparisons here.
        </p>
      ) : (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          {/* Tab bar */}
          <div className="flex gap-1 border-b pb-2">
            {(["summary", "brands", "recent"] as DisplayTab[]).map((t) => {
              const label = t === "summary" ? "Per Product" : t === "brands" ? "By Brand" : "My Recent";
              return (
                <button
                  key={t}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                    displayTab === t
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                  onClick={() => setDisplayTab(t)}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          {displayTab === "summary"  && <SummaryTab />}
          {displayTab === "brands"   && <BrandsTab />}
          {displayTab === "recent"   && <MyRecentTab recorderName={recorderName} />}
        </div>
      )}
    </div>
  );
}
