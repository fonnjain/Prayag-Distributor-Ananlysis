// Market Survey — record competitor prices observed during retailer visits.
//
// Three survey types (tabs):
//   Tab 1 — existing_sku:   retailer buys this item from us AND from a competitor
//   Tab 2 — new_sku:        retailer buys from us, but this item only from competitor
//   Tab 3 — new_customer:   retailer buys nothing from us yet
//
// Multiple item lines per submission (one retailer, many products).
// Recorder identity: self-reported name stored in localStorage ("prayag_ms_recorder").
// No API key required. Do NOT feed competitor prices into MRP calculations.

import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import SubmissionsTab from "../components/market-survey/SubmissionsTab";
import AnalyticsTab from "../components/market-survey/AnalyticsTab";

const BASE = import.meta.env.BASE_URL;
const API  = (path: string) => `${BASE}api/${path}`;
const LS_RECORDER = "prayag_ms_recorder";
try { localStorage.removeItem("prayag_api_key"); } catch { /* clear stale key */ }

// ── Types ──────────────────────────────────────────────────────────────────

type SurveyType = "existing_sku" | "new_sku" | "new_customer";
type MainTab = SurveyType | "submissions" | "analytics";
function isEntryTab(t: MainTab): t is SurveyType { return t !== "submissions" && t !== "analytics"; }

interface StateHead { key: string; name: string }
interface HierarchyState { canon: string; parent: string; isSplit: boolean }
interface CustomerRow { id: string; company: string; state: string | null; district: string | null }
interface ItemRow { itemCode: string; itemName: string | null; currentMrp: number | null; effectiveFrom: string | null }
interface MetaResponse { segments: string[]; knownBrands: { brand: string; surveyCount: number }[] }
interface PurchaseLookup {
  found: boolean;           // any secondary_sku_line rows for this retailer in last 12 months
  skuLineCount: number;     // customer-level line count (secondary_sku_line)
  skuTotalQty: number;      // customer-level qty (secondary_sku_line)
  monthCount: number;       // distinct months with purchases
  itemFound: boolean;       // this specific item_code found in secondary_sku_line
  itemLineCount: number;    // item-level line count
  itemQty: number;          // item-level qty
  customerName: string;
  prayagItemCode: string | null;
  months: string[];
}

interface SurveyRow {
  id: number; surveyedAt: string; recordedBy: string;
  isExistingBuyer: boolean; customerId: string | null; customerCompany: string | null;
  prospectName: string | null; state: string | null; district: string | null;
  segment: string; prayagItemCode: string | null;
  competitorBrand: string; competitorProduct: string | null;
  netPrice: number; unit: string; reasons: string[];
  note: string | null; createdAt: string; editable: boolean;
  surveyType: string | null;
}
interface SummaryRow {
  itemCode: string; segment: string; itemName: string | null;
  currentMrp: number | null; n: number; indicativeOnly: boolean;
  medianCompetitorNet: number; minNet: number; maxNet: number;
}
interface BrandRow { brand: string; n: number; segments: string[]; minNet: number; maxNet: number; medianNet: number }
interface ProspectRow {
  id: number; name: string; contact: string; contactPerson: string | null;
  district: string; state: string; type: string;
  submittedBy: string; submittedAt: string; status: string;
}

interface ItemLine {
  lineId: string;
  segment: string;
  prayagItemCode: string; prayagItemName: string | null; currentMrp: number | null;
  competitorBrand: string; competitorProduct: string;
  entryMode: "net_direct" | "mrp_discount";
  netPrice: string; mrp: string; discountPct: string;
  unit: string; packSize: string; note: string;
  // Priority set (visible by default in the entry form)
  creditDaysCompetitor: string; creditGivenBy: string; creditDaysPrayag: string;
  competitorSchemeType: string; competitorSchemeValue: string;
  deliveryDaysCompetitor: string; deliveryDaysPrayag: string; shelfShare: string;
  // More detail (collapsed by default)
  paymentTermsNote: string; competitorVisitFrequency: string;
  competitorMoq: string; buyingSince: string; wouldSwitch: string; switchCondition: string;
}

interface RetailerState {
  stateHeadKey: string; stateHeadName: string;
  selectedState: string;
  distributorId: string; distributorName: string;
  retailerId: string; retailerName: string;
  pendingProspectId: number | null;
  showNewDist: boolean; showNewRetailer: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────

const UNIT_OPTIONS = ["piece", "box", "carton", "kg", "litre", "set"];

const SURVEY_TABS: { type: SurveyType; label: string; desc: string }[] = [
  { type: "existing_sku",  label: "Existing SKU",  desc: "He buys this item from us AND from someone else." },
  { type: "new_sku",       label: "New SKU",        desc: "He buys from us, but buys this item from someone else." },
  { type: "new_customer",  label: "New Customer",   desc: "He buys nothing from us yet." },
];

const EMPTY_RETAILER: RetailerState = {
  stateHeadKey: "", stateHeadName: "", selectedState: "",
  distributorId: "", distributorName: "",
  retailerId: "", retailerName: "", pendingProspectId: null,
  showNewDist: false, showNewRetailer: false,
};

let _lineCounter = 0;
function makeEmptyLine(): ItemLine {
  return {
    lineId: `line-${++_lineCounter}`,
    segment: "", prayagItemCode: "", prayagItemName: null, currentMrp: null,
    competitorBrand: "", competitorProduct: "",
    entryMode: "net_direct", netPrice: "", mrp: "", discountPct: "",
    unit: "piece", packSize: "", note: "",
    // Priority set
    creditDaysCompetitor: "", creditGivenBy: "", creditDaysPrayag: "",
    competitorSchemeType: "", competitorSchemeValue: "",
    deliveryDaysCompetitor: "", deliveryDaysPrayag: "", shelfShare: "",
    // More detail
    paymentTermsNote: "", competitorVisitFrequency: "",
    competitorMoq: "", buyingSince: "", wouldSwitch: "", switchCondition: "",
  };
}

function computeNet(mrp: string, d: string): number | null {
  const m = parseFloat(mrp), dp = parseFloat(d);
  if (!isFinite(m) || m <= 0 || !isFinite(dp) || dp < 0 || dp >= 100) return null;
  return Math.round(m * (1 - dp / 100) * 100) / 100;
}

// ── Tiny helpers ──────────────────────────────────────────────────────────

function fmtDate(iso: string) { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
function fmtDateLong(iso: string) { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }

// ── UI atoms ──────────────────────────────────────────────────────────────

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}{required && <span className="ml-0.5 text-destructive">*</span>}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
function Inp({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${className}`} {...props} />;
}
function Sel({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed ${className}`} {...props}>
      {children}
    </select>
  );
}
function Divider() { return <div className="border-t my-6" />; }
function Warn({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{children}</div>;
}

// ── Recorder banner ────────────────────────────────────────────────────────

function RecorderBanner({ name, onChange }: { name: string; onChange: (n: string) => void }) {
  const [editing, setEditing] = useState(!name);
  const [draft, setDraft] = useState(name);
  if (editing) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-amber-50 px-4 py-2 text-sm">
        <span className="text-amber-700 font-medium shrink-0">Who are you?</span>
        <input className="flex-1 bg-transparent outline-none text-sm" placeholder="Your name (saved locally)"
          value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onChange(draft.trim()); setEditing(false); } }}
          autoFocus />
        <button className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
          disabled={!draft.trim()} onClick={() => { const v = draft.trim(); if (v) { onChange(v); setEditing(false); } }}>
          Save
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
      <span className="flex-1 text-muted-foreground">Recording as <span className="font-medium text-foreground">{name}</span></span>
      <button className="text-xs text-muted-foreground underline" onClick={() => { setDraft(name); setEditing(true); }}>change</button>
    </div>
  );
}

// ── New prospect panel ────────────────────────────────────────────────────

interface ProspectDraft { name: string; contact: string; contactPerson: string; address: string; district: string; area: string; pincode: string; gst: string }
const EMPTY_DRAFT: ProspectDraft = { name: "", contact: "", contactPerson: "", address: "", district: "", area: "", pincode: "", gst: "" };

function NewProspectPanel({ type, state, forDistributorId, submittedBy, onCreated, onCancel }: {
  type: "Distributor" | "Retailer"; state: string; forDistributorId?: string;
  submittedBy: string; onCreated: (id: number, name: string) => void; onCancel: () => void;
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
      const r = await fetch(API("market-survey/prospect"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: d.name.trim(), contact: d.contact.trim(), contactPerson: d.contactPerson.trim() || null,
          address: d.address.trim() || null, district: d.district.trim(), state, area: d.area.trim() || null,
          pincode: d.pincode.trim() || null, gst: d.gst.trim() || null, type,
          forDistributorId: forDistributorId || null, submittedBy }) });
      if (!r.ok) { const b = await r.json(); throw new Error(b.error ?? `HTTP ${r.status}`); }
      const { id } = await r.json() as { id: number };
      onCreated(id, d.name.trim());
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); setPending(false); }
  };
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">New {type} — pending review</div>
      <p className="text-xs text-amber-700">Goes to the Review Queue for manual approval — does not create a customer record immediately.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required><Inp placeholder={`${type} name`} value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Contact number" required><Inp placeholder="Mobile / phone" value={d.contact} onChange={(e) => set({ contact: e.target.value })} /></Field>
        <Field label="Contact person"><Inp placeholder="Owner / manager" value={d.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} /></Field>
        <Field label="District" required><Inp placeholder="District" value={d.district} onChange={(e) => set({ district: e.target.value })} /></Field>
        <Field label="Area / locality"><Inp placeholder="Colony or area" value={d.area} onChange={(e) => set({ area: e.target.value })} /></Field>
        <Field label="Pincode"><Inp placeholder="6-digit pincode" value={d.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Field>
      </div>
      <p className="text-xs text-muted-foreground">State: <strong>{state || "(not set)"}</strong></p>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <button className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          disabled={!canSubmit || pending} onClick={submit}>
          {pending ? "Saving…" : `Add ${type} to Review Queue`}
        </button>
        <button className="text-xs underline text-muted-foreground" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

// ── Item code picker ──────────────────────────────────────────────────────

function ItemCodePicker({ items, value, onChange, disabled }: {
  items: ItemRow[]; value: string; disabled?: boolean;
  onChange: (code: string, name: string | null, mrp: number | null, eff: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const chosen = items.find((i) => i.itemCode === value);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 60);
    return items.filter((i) => i.itemCode.toLowerCase().includes(t) || (i.itemName ?? "").toLowerCase().includes(t)).slice(0, 60);
  }, [items, q]);

  if (value && chosen) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="font-medium font-mono">{chosen.itemCode}</span>
          {chosen.itemName && <span className="text-muted-foreground truncate">{chosen.itemName}</span>}
          <button type="button" className="ml-auto text-xs text-muted-foreground underline"
            onClick={() => { onChange("", null, null, null); setQ(""); }}>clear</button>
        </div>
        {chosen.currentMrp != null && (
          <div className="flex items-center gap-2 rounded-md bg-blue-50 border border-blue-100 px-3 py-1.5 text-sm">
            <span className="text-blue-700 font-medium">Our MRP: ₹{chosen.currentMrp.toFixed(2)}</span>
            {chosen.effectiveFrom && <span className="text-blue-500 text-xs">(effective {fmtDateLong(chosen.effectiveFrom)})</span>}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <Inp placeholder={disabled ? "Select a segment first" : `Search ${items.length} codes…`}
        value={q} disabled={disabled}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && !disabled && filtered.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border bg-popover shadow-md">
          {filtered.map((i) => (
            <li key={`${i.itemCode}-${i.itemName}`} className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
              onMouseDown={() => { onChange(i.itemCode, i.itemName, i.currentMrp, i.effectiveFrom); setQ(""); setOpen(false); }}>
              <span className="font-mono font-medium">{i.itemCode}</span>
              {i.itemName && <span className="ml-2 text-muted-foreground text-xs">{i.itemName}</span>}
              {i.currentMrp != null && <span className="float-right text-xs text-blue-600">MRP ₹{i.currentMrp.toFixed(2)}</span>}
            </li>
          ))}
          {q && filtered.length === 60 && <li className="px-3 py-1 text-xs text-muted-foreground italic">First 60 — type more to narrow</li>}
        </ul>
      )}
    </div>
  );
}

// ── Item line card ────────────────────────────────────────────────────────

function ItemLineCard({ line, lineIndex, totalLines, segments, knownBrands, retailerId, surveyType, onChange, onRemove }: {
  line: ItemLine; lineIndex: number; totalLines: number;
  segments: string[]; knownBrands: { brand: string }[];
  retailerId: string; surveyType: SurveyType;
  onChange: (p: Partial<ItemLine>) => void;
  onRemove: () => void;
}) {
  const [moreDetail, setMoreDetail] = useState(false);
  const itemsQ = useQuery<{ rows: ItemRow[]; total: number }>({
    queryKey: ["ms-items", line.segment],
    queryFn: () => fetch(API(`market-survey/items?segment=${encodeURIComponent(line.segment)}`)).then((r) => r.json()),
    enabled: !!line.segment,
    staleTime: 30 * 60_000,
  });

  const lookupEnabled = !!retailerId && !!line.prayagItemCode && surveyType !== "new_customer";
  const lookupQ = useQuery<PurchaseLookup>({
    queryKey: ["ms-purchase-lookup", retailerId, line.prayagItemCode],
    queryFn: () =>
      fetch(API(`market-survey/purchase-lookup?customerId=${encodeURIComponent(retailerId)}&prayagItemCode=${encodeURIComponent(line.prayagItemCode)}`))
        .then((r) => r.json()),
    enabled: lookupEnabled,
    staleTime: 5 * 60_000,
  });

  const lookup = lookupQ.data;
  const computedNet = line.entryMode === "mrp_discount" ? computeNet(line.mrp, line.discountPct) : null;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      {totalLines > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Item {lineIndex + 1}</span>
          <button type="button" onClick={onRemove} className="text-xs text-destructive underline">Remove</button>
        </div>
      )}

      {/* Segment + item code */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Segment" required>
          <Sel value={line.segment}
            onChange={(e) => onChange({ segment: e.target.value, prayagItemCode: "", prayagItemName: null, currentMrp: null })}>
            <option value="">— select —</option>
            {segments.map((s) => <option key={s} value={s}>{s}</option>)}
          </Sel>
        </Field>
        <Field label={`Prayag item code${surveyType === "new_customer" ? " (optional)" : ""}`} required={surveyType !== "new_customer"}>
          <ItemCodePicker
            items={itemsQ.data?.rows ?? []}
            value={line.prayagItemCode}
            disabled={!line.segment}
            onChange={(code, name, mrp, eff) => onChange({ prayagItemCode: code, prayagItemName: name, currentMrp: mrp })}
          />
        </Field>
      </div>

      {/* Purchase lookup — customer info + tab warnings */}
      {lookupEnabled && lookup && (
        <div className="space-y-1">
          {/* Customer-level info block: quiet, one line, source labelled */}
          {lookup.found ? (
            <p className="text-xs text-muted-foreground px-1">
              {lookup.customerName} — {lookup.skuLineCount} line{lookup.skuLineCount !== 1 ? "s" : ""} across {lookup.monthCount} of 12 months in secondary SKU records ({lookup.skuTotalQty.toFixed(0)} pieces).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground px-1">
              {lookup.customerName} — no secondary SKU records in the last 12 months.
            </p>
          )}
          {/* Tab 1 warning: item not found → may belong in Tab 2 */}
          {surveyType === "existing_sku" && !lookup.itemFound && (
            <Warn>⚠ No purchase of {lookup.prayagItemCode} found in secondary SKU records in the last 12 months. This survey may belong in Tab 2 (New SKU). Submit anyway if you are certain.</Warn>
          )}
          {/* Tab 2 warning: item found → may belong in Tab 1 */}
          {surveyType === "new_sku" && lookup.itemFound && (
            <Warn>⚠ {lookup.prayagItemCode} was purchased in secondary SKU records in the last 12 months ({lookup.itemLineCount} line{lookup.itemLineCount !== 1 ? "s" : ""}, {lookup.itemQty.toFixed(0)} pieces). This survey may belong in Tab 1 (Existing SKU). Submit anyway if you are certain.</Warn>
          )}
        </div>
      )}
      {lookupEnabled && lookupQ.isLoading && (
        <p className="text-xs text-muted-foreground">Checking purchase history…</p>
      )}

      {/* Competitor */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Competitor brand" required>
          <div>
            <Inp placeholder="e.g. Astral, Finolex…" value={line.competitorBrand}
              onChange={(e) => onChange({ competitorBrand: e.target.value })}
              list={`brand-list-${line.lineId}`} />
            <datalist id={`brand-list-${line.lineId}`}>
              {knownBrands.map((b) => <option key={b.brand} value={b.brand} />)}
            </datalist>
          </div>
        </Field>
        <Field label="Competitor product (optional)">
          <Inp placeholder="Their product or code" value={line.competitorProduct}
            onChange={(e) => onChange({ competitorProduct: e.target.value })} />
        </Field>
      </div>

      {/* Price */}
      <div className="space-y-3">
        <div className="flex gap-4">
          {(["net_direct", "mrp_discount"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="radio" checked={line.entryMode === m}
                onChange={() => onChange({ entryMode: m, netPrice: "", mrp: "", discountPct: "" })} />
              {m === "net_direct" ? "Net price" : "MRP + discount %"}
            </label>
          ))}
        </div>
        {line.entryMode === "net_direct" ? (
          <Field label="Net price (₹ per unit)" required>
            <Inp type="number" min="0.01" step="0.01" placeholder="0.00"
              value={line.netPrice} onChange={(e) => onChange({ netPrice: e.target.value })} />
          </Field>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <Field label="MRP (₹)" required>
                <Inp type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={line.mrp} onChange={(e) => onChange({ mrp: e.target.value })} />
              </Field>
              <Field label="Discount (%)" required>
                <Inp type="number" min="0" max="99.99" step="0.01" placeholder="0.00"
                  value={line.discountPct} onChange={(e) => onChange({ discountPct: e.target.value })} />
              </Field>
            </div>
            {computedNet !== null && (
              <div className="rounded-md bg-muted px-3 py-1.5 text-sm">Net: <span className="font-semibold">₹{computedNet.toFixed(2)}</span></div>
            )}
          </div>
        )}
      </div>

      {/* Unit + pack size */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Unit">
          <Sel value={line.unit} onChange={(e) => onChange({ unit: e.target.value })}>
            {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Sel>
        </Field>
        <Field label="Pack size (optional)">
          <Inp placeholder="e.g. 10 pcs/box" value={line.packSize}
            onChange={(e) => onChange({ packSize: e.target.value })} />
        </Field>
      </div>

      {/* Note */}
      <Field label="Note (optional)">
        <Inp placeholder="Anything specific about this item" value={line.note}
          onChange={(e) => onChange({ note: e.target.value })} />
      </Field>

      {/* ── Priority context (visible by default) ── */}
      <div className="border-t pt-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Credit terms</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Competitor credit (days)">
            <Inp type="number" min="0" step="1" placeholder="e.g. 30"
              value={line.creditDaysCompetitor}
              onChange={(e) => onChange({ creditDaysCompetitor: e.target.value })} />
          </Field>
          <Field label="Credit given by">
            <Sel value={line.creditGivenBy} onChange={(e) => onChange({ creditGivenBy: e.target.value })}>
              <option value="">— not recorded —</option>
              <option value="distributor">Their distributor</option>
              <option value="competitor_company">Competitor company</option>
              <option value="unknown">Unknown</option>
            </Sel>
          </Field>
          <Field label="Prayag credit (days)">
            <Inp type="number" min="0" step="1" placeholder="e.g. 30"
              value={line.creditDaysPrayag}
              onChange={(e) => onChange({ creditDaysPrayag: e.target.value })} />
          </Field>
        </div>

        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Competitor scheme</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Scheme type">
            <Sel value={line.competitorSchemeType} onChange={(e) => onChange({ competitorSchemeType: e.target.value })}>
              <option value="">— not recorded —</option>
              <option value="percentage">Percentage off</option>
              <option value="free_goods">Free goods</option>
              <option value="slab">Slab scheme</option>
              <option value="none">No scheme</option>
              <option value="unknown">Unknown</option>
            </Sel>
          </Field>
          <Field label='Scheme value' hint='"6%", "10+1", "5% above ₹2L"'>
            <Inp placeholder="Describe the offer"
              value={line.competitorSchemeValue}
              onChange={(e) => onChange({ competitorSchemeValue: e.target.value })} />
          </Field>
        </div>

        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Delivery speed</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Competitor delivery (days)">
            <Inp type="number" min="0" step="1" placeholder="e.g. 2"
              value={line.deliveryDaysCompetitor}
              onChange={(e) => onChange({ deliveryDaysCompetitor: e.target.value })} />
          </Field>
          <Field label="Prayag delivery (days)">
            <Inp type="number" min="0" step="1" placeholder="e.g. 7"
              value={line.deliveryDaysPrayag}
              onChange={(e) => onChange({ deliveryDaysPrayag: e.target.value })} />
          </Field>
        </div>

        <Field label="Shelf share — how is this shelf split?">
          <Sel value={line.shelfShare} onChange={(e) => onChange({ shelfShare: e.target.value })}>
            <option value="">— not recorded —</option>
            <option value="mostly_prayag">Mostly Prayag (&gt;50%)</option>
            <option value="even_split">Even split (~50/50)</option>
            <option value="mostly_competitor">Mostly competitor (&gt;50%)</option>
            <option value="only_competitor">Only competitor (Prayag absent)</option>
          </Sel>
        </Field>
      </div>

      {/* ── More detail (collapsed by default) ── */}
      {moreDetail ? (
        <div className="border-t pt-3 space-y-3">
          <button type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setMoreDetail(false)}>
            Hide detail ▲
          </button>
          <Field label="Payment terms note" hint="Cash discount, part-payment, cheque cycle…">
            <Inp placeholder="Free text"
              value={line.paymentTermsNote}
              onChange={(e) => onChange({ paymentTermsNote: e.target.value })} />
          </Field>
          <Field label="Competitor visit frequency">
            <Sel value={line.competitorVisitFrequency}
              onChange={(e) => onChange({ competitorVisitFrequency: e.target.value })}>
              <option value="">— not recorded —</option>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="rarely">Rarely</option>
              <option value="never">Never</option>
            </Sel>
          </Field>
          <Field label="Competitor minimum order" hint="A smaller MOQ is a real advantage for a small shop">
            <Inp placeholder='e.g. "1 box", "₹500"'
              value={line.competitorMoq}
              onChange={(e) => onChange({ competitorMoq: e.target.value })} />
          </Field>
          <Field label="Buying from competitor since" hint="Six months is recoverable; six years usually is not">
            <Inp placeholder='e.g. "2019", "about 2 years"'
              value={line.buyingSince}
              onChange={(e) => onChange({ buyingSince: e.target.value })} />
          </Field>
          <Field label="Would switch to Prayag?">
            <Sel value={line.wouldSwitch} onChange={(e) => onChange({ wouldSwitch: e.target.value })}>
              <option value="">— not recorded —</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
              <option value="maybe">Maybe</option>
              <option value="unknown">Unknown</option>
            </Sel>
          </Field>
          <Field label="What would it take to switch?" hint="The most useful field on the form">
            <Inp placeholder="Free text — what condition would make them switch?"
              value={line.switchCondition}
              onChange={(e) => onChange({ switchCondition: e.target.value })} />
          </Field>
        </div>
      ) : (
        <div className="border-t pt-2">
          <button type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setMoreDetail(true)}>
            More detail ▼ — payment terms, visit frequency, buying since, would switch…
          </button>
        </div>
      )}
    </div>
  );
}

// ── Display tabs ──────────────────────────────────────────────────────────

function IndicativeBadge() {
  return <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">indicative only</span>;
}

function MyRecentTab({ recorderName }: { recorderName: string }) {
  const { data, isPending } = useQuery<{ rows: SurveyRow[] }>({
    queryKey: ["ms-list", recorderName],
    queryFn: () => fetch(API(`market-survey?recorder=${encodeURIComponent(recorderName)}&limit=30`)).then((r) => r.json()),
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
              {r.surveyType && r.surveyType !== "unclassified" && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                  {r.surveyType === "existing_sku" ? "Tab 1" : r.surveyType === "new_sku" ? "Tab 2" : "Tab 3"}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.createdAt)}</span>
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

function SummaryTab() {
  const { data, isPending } = useQuery<{ rows: SummaryRow[] }>({
    queryKey: ["ms-summary"],
    queryFn: () => fetch(API("market-survey/summary")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  if (isPending) return <p className="text-sm text-muted-foreground p-2">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-2">No data yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-muted-foreground border-b">
          <th className="text-left py-2 pr-3">Code</th>
          <th className="text-left py-2 pr-3">Segment</th>
          <th className="text-right py-2 pr-3">Our MRP</th>
          <th className="text-right py-2 pr-3">Competitor median</th>
          <th className="text-right py-2 pr-3">Min / Max</th>
          <th className="text-right py-2">n</th>
        </tr></thead>
        <tbody className="divide-y">
          {data.rows.map((r) => (
            <tr key={`${r.itemCode}-${r.segment}`} className="hover:bg-muted/20">
              <td className="py-2 pr-3 font-mono font-medium">{r.itemCode}</td>
              <td className="py-2 pr-3 text-muted-foreground">{r.segment}</td>
              <td className="py-2 pr-3 text-right">{r.currentMrp != null ? `₹${r.currentMrp.toFixed(2)}` : "—"}</td>
              <td className="py-2 pr-3 text-right font-medium">₹{r.medianCompetitorNet.toFixed(2)}{r.indicativeOnly && <IndicativeBadge />}</td>
              <td className="py-2 pr-3 text-right text-muted-foreground">₹{r.minNet.toFixed(2)} / ₹{r.maxNet.toFixed(2)}</td>
              <td className="py-2 text-right text-muted-foreground">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BrandsTab() {
  const { data, isPending } = useQuery<{ rows: BrandRow[] }>({
    queryKey: ["ms-by-brand"],
    queryFn: () => fetch(API("market-survey/by-brand")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  if (isPending) return <p className="text-sm text-muted-foreground p-2">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-2">No data yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-muted-foreground border-b">
          <th className="text-left py-2 pr-3">Brand</th>
          <th className="text-left py-2 pr-3">Segments</th>
          <th className="text-right py-2 pr-3">Median net</th>
          <th className="text-right py-2">Surveys</th>
        </tr></thead>
        <tbody className="divide-y">
          {data.rows.map((r) => (
            <tr key={r.brand} className="hover:bg-muted/20">
              <td className="py-2 pr-3 font-medium">{r.brand}</td>
              <td className="py-2 pr-3 text-muted-foreground">{r.segments.join(", ")}</td>
              <td className="py-2 pr-3 text-right">₹{r.medianNet.toFixed(2)}</td>
              <td className="py-2 text-right text-muted-foreground">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pending prospects table ────────────────────────────────────────────────

function PendingProspects() {
  const qc = useQueryClient();
  const { data, isPending } = useQuery<{ rows: ProspectRow[] }>({
    queryKey: ["ms-prospects"],
    queryFn: () => fetch(API("market-survey/prospects?status=pending")).then((r) => r.json()),
    staleTime: 60_000,
  });
  const act = async (id: number, status: "approved" | "rejected") => {
    await fetch(API(`market-survey/prospect/${id}`), { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    qc.invalidateQueries({ queryKey: ["ms-prospects"] });
  };
  if (isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground">No pending prospects.</p>;
  return (
    <div className="overflow-x-auto text-sm">
      <table className="w-full text-xs">
        <thead><tr className="text-muted-foreground border-b">
          <th className="text-left py-2 pr-3">Name</th><th className="text-left py-2 pr-3">Type</th>
          <th className="text-left py-2 pr-3">Location</th><th className="text-left py-2 pr-3">Submitted by (self-declared)</th>
          <th className="text-left py-2">Actions</th>
        </tr></thead>
        <tbody className="divide-y">
          {data.rows.map((r) => (
            <tr key={r.id} className="hover:bg-muted/20">
              <td className="py-2 pr-3 font-medium">{r.name}<br/><span className="text-muted-foreground font-normal">{r.contact}</span></td>
              <td className="py-2 pr-3">{r.type}</td>
              <td className="py-2 pr-3 text-muted-foreground">{r.district}, {r.state}</td>
              <td className="py-2 pr-3 text-muted-foreground">{r.submittedBy}</td>
              <td className="py-2">
                <button onClick={() => act(r.id, "approved")} className="text-xs text-green-700 underline mr-2">Approve</button>
                <button onClick={() => act(r.id, "rejected")} className="text-xs text-destructive underline">Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

type DisplayTab = "recent" | "summary" | "brands";

export default function MarketSurveyPage() {
  const [recorderName, setRecorderNameState] = useState<string>(() => {
    try { return localStorage.getItem(LS_RECORDER) ?? ""; } catch { return ""; }
  });
  const setRecorderName = useCallback((name: string) => {
    setRecorderNameState(name);
    try { localStorage.setItem(LS_RECORDER, name); } catch { /* */ }
  }, []);

  const [mainTab, setMainTab]         = useState<MainTab>("existing_sku");
  const surveyType                    = isEntryTab(mainTab) ? mainTab : "existing_sku";
  const [retailer, setRetailer]       = useState<RetailerState>(EMPTY_RETAILER);
  const setR = useCallback((p: Partial<RetailerState>) => setRetailer((prev) => ({ ...prev, ...p })), []);
  const [lines, setLines]             = useState<ItemLine[]>(() => [makeEmptyLine()]);
  const [prospectSearch, setProspectSearch] = useState("");
  const [prospectNameDraft, setProspectNameDraft] = useState("");
  const [showFullProspectForm, setShowFullProspectForm] = useState(false);
  const switchEntryTab = useCallback((type: SurveyType) => {
    setMainTab(type);
    setRetailer(EMPTY_RETAILER);
    setProspectNameDraft(""); setProspectSearch(""); setShowFullProspectForm(false);
  }, []);

  const [error,   setError]   = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [displayTab, setDisplayTab] = useState<DisplayTab>("recent");
  const qc = useQueryClient();

  // ── Server data ───────────────────────────────────────────────────────

  const stateHeadsQ = useQuery<{ rows: StateHead[] }>({ queryKey: ["ms-state-heads"],
    queryFn: () => fetch(API("market-survey/state-heads")).then((r) => r.json()), staleTime: 10 * 60_000 });

  const statesQ = useQuery<{ states: HierarchyState[] }>({
    queryKey: ["ms-cascade-states", retailer.stateHeadName],
    queryFn: () => {
      const url = retailer.stateHeadName
        ? API(`market-survey/cascade-states?stateHead=${encodeURIComponent(retailer.stateHeadName)}`)
        : API("market-survey/cascade-states");
      return fetch(url).then((r) => r.json());
    },
    staleTime: 60 * 60_000,
  });

  const distsQ = useQuery<{ rows: CustomerRow[]; total: number }>({
    queryKey: ["ms-distributors", retailer.selectedState],
    queryFn: () => fetch(API(`market-survey/distributors?state=${encodeURIComponent(retailer.selectedState)}`)).then((r) => r.json()),
    enabled: !!retailer.selectedState && surveyType !== "new_customer",
    staleTime: 5 * 60_000,
  });

  const retailersQ = useQuery<{ rows: CustomerRow[]; total: number }>({
    queryKey: ["ms-retailers", retailer.distributorId],
    queryFn: () => fetch(API(`market-survey/retailers?distributorId=${encodeURIComponent(retailer.distributorId)}`)).then((r) => r.json()),
    enabled: !!retailer.distributorId,
    staleTime: 5 * 60_000,
  });

  const metaQ = useQuery<MetaResponse>({ queryKey: ["ms-meta"],
    queryFn: () => fetch(API("market-survey/meta")).then((r) => r.json()), staleTime: 10 * 60_000 });

  // Tab 3: customer check by name
  const custCheckQ = useQuery<{ rows: CustomerRow[] }>({
    queryKey: ["ms-cust-check", prospectSearch],
    queryFn: () => fetch(API(`market-survey/customers?q=${encodeURIComponent(prospectSearch)}`)).then((r) => r.json()),
    enabled: surveyType === "new_customer" && prospectSearch.length >= 2,
    staleTime: 30_000,
  });

  const summaryQ = useQuery<{ rows: SummaryRow[] }>({ queryKey: ["ms-summary"],
    queryFn: () => fetch(API("market-survey/summary")).then((r) => r.json()), staleTime: 5 * 60_000 });
  const hasData = (summaryQ.data?.rows.length ?? 0) > 0;

  const allHierStates = statesQ.data?.states ?? [];
  const effectiveStates = useMemo(() => {
    if (!retailer.selectedState) return [];
    const chosen = allHierStates.find((s) => s.canon === retailer.selectedState);
    if (!chosen) return [retailer.selectedState];
    const children = allHierStates.filter((s) => s.parent === chosen.canon && s.canon !== chosen.canon);
    return children.length > 0 ? children.map((c) => c.canon) : [retailer.selectedState];
  }, [retailer.selectedState, allHierStates]);

  const distsCount  = distsQ.data?.total ?? 0;
  const retailCount = retailersQ.data?.total ?? 0;
  const hasRetailer = surveyType === "new_customer"
    ? !!prospectNameDraft.trim() || retailer.pendingProspectId != null
    : !!retailer.retailerId || retailer.pendingProspectId != null;

  const retailerLabel = retailer.pendingProspectId != null
    ? `${retailer.retailerName} (pending approval)`
    : retailer.retailerName;

  // ── Line helpers ──────────────────────────────────────────────────────

  const updateLine = useCallback((lineId: string, p: Partial<ItemLine>) => {
    setLines((prev) => prev.map((l) => l.lineId === lineId ? { ...l, ...p } : l));
  }, []);
  const removeLine = useCallback((lineId: string) => {
    setLines((prev) => prev.filter((l) => l.lineId !== lineId));
  }, []);
  const addLine = useCallback(() => { setLines((prev) => [...prev, makeEmptyLine()]); }, []);

  // ── Validation ────────────────────────────────────────────────────────

  function lineValid(l: ItemLine): boolean {
    if (!l.segment || !l.competitorBrand.trim()) return false;
    if (surveyType !== "new_customer" && !l.prayagItemCode) return false;
    if (l.entryMode === "net_direct") return !!l.netPrice && parseFloat(l.netPrice) > 0;
    return computeNet(l.mrp, l.discountPct) !== null;
  }
  const allLinesValid = lines.length > 0 && lines.every(lineValid);
  const canSubmit = !!recorderName && hasRetailer && allLinesValid;

  // ── Submit ────────────────────────────────────────────────────────────

  const mutation = useMutation({
    mutationFn: async () => {
      if (!canSubmit) throw new Error("Form is not complete");

      const body: Record<string, unknown> = {
        recorderName,
        surveyType,
        state: retailer.selectedState || undefined,
        lines: lines.map((l) => {
          const base: Record<string, unknown> = {
            segment: l.segment, competitorBrand: l.competitorBrand.trim(),
            competitorProduct: l.competitorProduct || undefined,
            entryMode: l.entryMode, unit: l.unit,
            packSize: l.packSize || undefined, note: l.note || undefined,
          };
          if (l.prayagItemCode) base.prayagItemCode = l.prayagItemCode;
          if (l.entryMode === "net_direct") { base.netPrice = parseFloat(l.netPrice); }
          else { base.mrp = parseFloat(l.mrp); base.discountPct = parseFloat(l.discountPct); }
          // Priority set (omit if empty)
          if (l.creditDaysCompetitor)   base.creditDaysCompetitor   = parseInt(l.creditDaysCompetitor, 10);
          if (l.creditGivenBy)          base.creditGivenBy          = l.creditGivenBy;
          if (l.creditDaysPrayag)       base.creditDaysPrayag       = parseInt(l.creditDaysPrayag, 10);
          if (l.competitorSchemeType)   base.competitorSchemeType   = l.competitorSchemeType;
          if (l.competitorSchemeValue)  base.competitorSchemeValue  = l.competitorSchemeValue;
          if (l.deliveryDaysCompetitor) base.deliveryDaysCompetitor = parseInt(l.deliveryDaysCompetitor, 10);
          if (l.deliveryDaysPrayag)     base.deliveryDaysPrayag     = parseInt(l.deliveryDaysPrayag, 10);
          if (l.shelfShare)             base.shelfShare             = l.shelfShare;
          // More detail (omit if empty)
          if (l.paymentTermsNote)         base.paymentTermsNote         = l.paymentTermsNote;
          if (l.competitorVisitFrequency) base.competitorVisitFrequency = l.competitorVisitFrequency;
          if (l.competitorMoq)            base.competitorMoq            = l.competitorMoq;
          if (l.buyingSince)              base.buyingSince              = l.buyingSince;
          if (l.wouldSwitch)              base.wouldSwitch              = l.wouldSwitch;
          if (l.switchCondition)          base.switchCondition          = l.switchCondition;
          return base;
        }),
      };

      if (surveyType !== "new_customer") {
        body.customerId = retailer.retailerId;
        body.district = retailer.distributorId
          ? (distsQ.data?.rows.find((d) => d.id === retailer.distributorId)?.district ?? undefined)
          : undefined;
      } else {
        body.prospectName = prospectNameDraft.trim() || retailer.retailerName || undefined;
        if (retailer.pendingProspectId) body.pendingProspectId = retailer.pendingProspectId;
      }

      const r = await fetch(API("market-survey"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`); }
      return r.json() as Promise<{ surveyId: string; rows: { id: number; netPrice: number }[]; rowCount: number; recordedBy: string }>;
    },
    onSuccess: (data) => {
      setSuccess(`${data.rowCount} item${data.rowCount !== 1 ? "s" : ""} saved (survey ${data.surveyId.slice(0, 8)}…) by ${data.recordedBy}`);
      setError(null);
      setRetailer(EMPTY_RETAILER);
      setLines([makeEmptyLine()]);
      setProspectNameDraft(""); setProspectSearch(""); setShowFullProspectForm(false);
      qc.invalidateQueries({ queryKey: ["ms-list"] });
      qc.invalidateQueries({ queryKey: ["ms-summary"] });
      qc.invalidateQueries({ queryKey: ["ms-by-brand"] });
      qc.invalidateQueries({ queryKey: ["ms-meta"] });
      setDisplayTab("recent");
    },
    onError: (e: Error) => { setError(e.message); setSuccess(null); },
  });

  // ── Render ────────────────────────────────────────────────────────────

  const segments   = metaQ.data?.segments ?? [];
  const knownBrands = metaQ.data?.knownBrands ?? [];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-semibold">Market Survey</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Record competitor prices observed during retailer visits. Data is for internal analysis only.
        </p>
      </div>

      {/* ── Top-level tabs (3 entry types + Submissions + Analytics) ── */}
      <div className="flex gap-1 flex-wrap border-b pb-3">
        {SURVEY_TABS.map(({ type, label }) => (
          <button key={type} type="button"
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              mainTab === type ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => switchEntryTab(type)}>
            {label}
          </button>
        ))}
        <div className="flex-1 min-w-4" />
        {(["submissions", "analytics"] as const).map((t) => (
          <button key={t} type="button"
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              mainTab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => setMainTab(t)}>
            {t === "submissions" ? "Submissions" : "Analytics"}
          </button>
        ))}
      </div>

      {isEntryTab(mainTab) && (<>
      <RecorderBanner name={recorderName} onChange={setRecorderName} />

      <form className="space-y-0" onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }}>

        {/* ── Section 1: Retailer ── */}
        <div className="rounded-lg border bg-card p-6 mt-4 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Section 1 — Retailer</div>

          {surveyType !== "new_customer" ? (
            /* Tab 1 / Tab 2: full cascade */
            <div className="space-y-4">
              <Field label="State Head">
                <Sel value={retailer.stateHeadKey}
                  onChange={(e) => {
                    const head = stateHeadsQ.data?.rows.find((h) => h.key === e.target.value);
                    setR({ stateHeadKey: e.target.value, stateHeadName: head?.name ?? "",
                      selectedState: "", distributorId: "", distributorName: "",
                      retailerId: "", retailerName: "", pendingProspectId: null,
                      showNewDist: false, showNewRetailer: false });
                  }}>
                  <option value="">— select state head —</option>
                  {(stateHeadsQ.data?.rows ?? []).map((h) => <option key={h.key} value={h.key}>{h.name}</option>)}
                </Sel>
              </Field>

              <Field label={`State${distsCount && retailer.selectedState ? ` · ${distsCount} distributor${distsCount !== 1 ? "s" : ""} in ${effectiveStates.join(" + ")}` : ""}`}>
                <Sel value={retailer.selectedState}
                  onChange={(e) => setR({ selectedState: e.target.value, distributorId: "", distributorName: "",
                    retailerId: "", retailerName: "", pendingProspectId: null, showNewDist: false, showNewRetailer: false })}>
                  <option value="">— select state —</option>
                  {allHierStates.map((s) => <option key={s.canon} value={s.canon}>{s.canon}{s.isSplit ? "" : " (all)"}</option>)}
                </Sel>
              </Field>

              <Field label={`Distributor${retailer.selectedState && !retailer.showNewDist ? (distsQ.isLoading ? " (loading…)" : distsCount === 0 ? " (none in this state)" : ` (${distsCount})`) : ""}`}>
                {retailer.showNewDist ? (
                  <NewProspectPanel type="Distributor" state={retailer.selectedState} submittedBy={recorderName}
                    onCreated={(id, name) => setR({ distributorId: "", distributorName: name, pendingProspectId: id, showNewDist: false, retailerId: "", retailerName: "", showNewRetailer: false })}
                    onCancel={() => setR({ showNewDist: false })} />
                ) : (
                  <Sel disabled={!retailer.selectedState || distsQ.isLoading} value={retailer.distributorId}
                    onChange={(e) => {
                      if (e.target.value === "__new__") { setR({ distributorId: "", distributorName: "", showNewDist: true, retailerId: "", retailerName: "", pendingProspectId: null, showNewRetailer: false }); return; }
                      const dist = distsQ.data?.rows.find((d) => d.id === e.target.value);
                      setR({ distributorId: e.target.value, distributorName: dist?.company ?? "", retailerId: "", retailerName: "", pendingProspectId: null, showNewRetailer: false });
                    }}>
                    <option value="">{!retailer.selectedState ? "Select a state first" : distsQ.isLoading ? "Loading…" : distsCount === 0 ? "No distributors in this state" : "— select distributor —"}</option>
                    {(distsQ.data?.rows ?? []).map((d) => <option key={d.id} value={d.id}>{d.company}{d.district ? ` · ${d.district}` : ""}</option>)}
                    {!!retailer.selectedState && <option value="__new__">+ New distributor</option>}
                  </Sel>
                )}
              </Field>

              {!retailer.showNewDist && (
                <Field label={`Retailer${retailer.distributorId ? ` (${retailCount} linked)` : ""}`} required>
                  {retailer.showNewRetailer ? (
                    <NewProspectPanel type="Retailer" state={retailer.selectedState} forDistributorId={retailer.distributorId || undefined}
                      submittedBy={recorderName}
                      onCreated={(id, name) => setR({ retailerId: "", retailerName: name, pendingProspectId: id, showNewRetailer: false })}
                      onCancel={() => setR({ showNewRetailer: false })} />
                  ) : retailer.retailerId || retailer.pendingProspectId != null ? (
                    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                      <span className="flex-1">{retailerLabel}</span>
                      <button type="button" className="text-xs underline text-muted-foreground"
                        onClick={() => setR({ retailerId: "", retailerName: "", pendingProspectId: null })}>clear</button>
                    </div>
                  ) : (
                    <Sel disabled={!retailer.distributorId || retailersQ.isLoading} value={retailer.retailerId}
                      onChange={(e) => {
                        if (e.target.value === "__new__") { setR({ showNewRetailer: true, retailerId: "", retailerName: "", pendingProspectId: null }); return; }
                        const ret = retailersQ.data?.rows.find((r) => r.id === e.target.value);
                        setR({ retailerId: e.target.value, retailerName: ret?.company ?? "" });
                      }}>
                      <option value="">{!retailer.distributorId ? "Select a distributor first" : retailersQ.isLoading ? "Loading…" : retailCount === 0 ? "No retailers linked — use + New" : "— select retailer —"}</option>
                      {(retailersQ.data?.rows ?? []).map((r) => <option key={r.id} value={r.id}>{r.company}{r.district ? ` · ${r.district}` : ""}</option>)}
                      {!!retailer.distributorId && <option value="__new__">+ New retailer</option>}
                    </Sel>
                  )}
                </Field>
              )}
            </div>
          ) : (
            /* Tab 3: new customer */
            <div className="space-y-4">
              {/* Customer check */}
              <Field label="Check if they already exist in our system">
                <Inp placeholder="Type retailer name to search…" value={prospectSearch}
                  onChange={(e) => setProspectSearch(e.target.value)} />
                {custCheckQ.data?.rows.length ? (
                  <div className="mt-1 space-y-1">
                    {custCheckQ.data.rows.map((c) => (
                      <Warn key={c.id}>
                        ⚠ <strong>{c.company}</strong> ({c.id}) exists in customer_master{c.state ? ` — ${c.state}` : ""}. They already buy from us — consider Tab 1 or Tab 2.
                      </Warn>
                    ))}
                  </div>
                ) : prospectSearch.length >= 2 && custCheckQ.data?.rows.length === 0 ? (
                  <p className="mt-1 text-xs text-green-700">Not found in customer_master — proceed as new customer.</p>
                ) : null}
              </Field>

              {/* State + retailer name */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="State" required>
                  <Sel value={retailer.selectedState}
                    onChange={(e) => setR({ selectedState: e.target.value, pendingProspectId: null })}>
                    <option value="">— select state —</option>
                    {allHierStates.map((s) => <option key={s.canon} value={s.canon}>{s.canon}</option>)}
                  </Sel>
                </Field>
                <Field label="Retailer name" required>
                  <Inp placeholder="Prospect / shop name"
                    value={retailer.pendingProspectId != null ? retailer.retailerName : prospectNameDraft}
                    disabled={retailer.pendingProspectId != null}
                    onChange={(e) => setProspectNameDraft(e.target.value)} />
                </Field>
              </div>

              {retailer.pendingProspectId != null ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                  <span className="flex-1 text-green-700">{retailer.retailerName} added to Review Queue</span>
                  <button type="button" className="text-xs underline text-muted-foreground"
                    onClick={() => { setR({ pendingProspectId: null, retailerName: "" }); setShowFullProspectForm(false); }}>clear</button>
                </div>
              ) : !showFullProspectForm ? (
                <button type="button" className="text-xs text-primary underline"
                  onClick={() => setShowFullProspectForm(true)}>
                  + Add to Review Queue (captures contact, district, etc.)
                </button>
              ) : (
                <NewProspectPanel type="Retailer" state={retailer.selectedState} submittedBy={recorderName}
                  onCreated={(id, name) => { setR({ pendingProspectId: id, retailerName: name }); setProspectNameDraft(name); setShowFullProspectForm(false); }}
                  onCancel={() => setShowFullProspectForm(false)} />
              )}
            </div>
          )}
        </div>

        {/* ── Section 2: Item lines ── */}
        <div className="mt-4 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Section 2 — Items observed ({lines.length})
          </div>
          {lines.map((line, idx) => (
            <ItemLineCard
              key={line.lineId}
              line={line}
              lineIndex={idx}
              totalLines={lines.length}
              segments={segments}
              knownBrands={knownBrands}
              retailerId={retailer.retailerId}
              surveyType={surveyType}
              onChange={(p) => updateLine(line.lineId, p)}
              onRemove={() => removeLine(line.lineId)}
            />
          ))}
          <button type="button" onClick={addLine}
            className="w-full rounded-lg border-2 border-dashed border-border py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
            + Add another item
          </button>
        </div>

        {/* ── Submit ── */}
        <div className="mt-6 space-y-3">
          {error   && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          {success && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}
          {!recorderName && <p className="text-xs text-amber-700">Set your name at the top to submit.</p>}
          <button type="submit" disabled={!canSubmit || mutation.isPending}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
            {mutation.isPending ? "Saving…" : `Submit Survey${lines.length > 1 ? ` (${lines.length} items)` : ""}`}
          </button>
        </div>
      </form>

      {/* ── Results panel ── */}
      {!hasData ? (
        <p className="text-sm text-muted-foreground text-center py-2">Submit a survey with a Prayag product code to see competitor comparisons here.</p>
      ) : (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex gap-1 border-b pb-2">
            {(["summary", "brands", "recent"] as DisplayTab[]).map((t) => {
              const label = t === "summary" ? "Per Product" : t === "brands" ? "By Brand" : "My Recent";
              return (
                <button key={t}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors ${displayTab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                  onClick={() => setDisplayTab(t)}>
                  {label}
                </button>
              );
            })}
          </div>
          {displayTab === "summary" && <SummaryTab />}
          {displayTab === "brands"  && <BrandsTab />}
          {displayTab === "recent"  && <MyRecentTab recorderName={recorderName} />}
        </div>
      )}
      </>)}
      {mainTab === "submissions" && <SubmissionsTab recorderName={recorderName} />}
      {mainTab === "analytics"   && <AnalyticsTab />}
    </div>
  );
}
