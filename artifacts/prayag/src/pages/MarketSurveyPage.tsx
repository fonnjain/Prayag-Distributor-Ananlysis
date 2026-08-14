// Market Survey — record competitor prices observed during retailer visits.
// Form (left) + Display panels (right): Per Product, By Brand, Coverage, My Recent.
//
// The API key stored in localStorage is used as the Authorization: Bearer header.
// recorded_by is derived from the key on the server; it is not a typed field.

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL; // trailing slash guaranteed by Vite
const API  = (path: string) => `${BASE}api/${path}`;

// ── Types ─────────────────────────────────────────────────────────────────

interface MetaResponse {
  segments:    string[];
  knownBrands: { brand: string; surveyCount: number }[];
  states:      { canon: string; parent: string }[];
  recorder:    string | null;
}
interface CustomerRow { id: string; company: string; state: string | null; district: string | null }
interface ProductRow  { itemCode: string; itemName: string | null; segment: string; currentMrp: number | null }
interface SurveyRow {
  id: number; surveyedAt: string; recordedBy: string;
  isExistingBuyer: boolean; customerId: string | null; customerCompany: string | null;
  prospectName: string | null; state: string | null; district: string | null;
  segment: string; prayagItemCode: string | null;
  competitorBrand: string; competitorProduct: string | null;
  netPrice: number; mrp: number | null; discountPct: number | null;
  entryMode: string; unit: string; reasons: string[];
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

const REASON_OPTIONS = [
  { value: "price",         label: "Better price" },
  { value: "availability",  label: "Better availability" },
  { value: "credit_terms",  label: "Better credit terms" },
  { value: "relationship",  label: "Stronger relationship" },
  { value: "scheme",        label: "Better scheme" },
  { value: "quality",       label: "Perceived quality" },
];
const UNIT_OPTIONS = ["piece", "box", "carton", "kg", "litre", "set"];

// ── API helpers ───────────────────────────────────────────────────────────

function makeHeaders(apiKey: string, withBody = false) {
  const h: Record<string, string> = {};
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

async function apiFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API(path), {
    ...init,
    headers: { ...makeHeaders(apiKey, !!init?.body), ...init?.headers },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

// ── Simple autocomplete hook ──────────────────────────────────────────────

function useAutocomplete<T>(
  fetchFn: (q: string) => Promise<T[]>,
  minChars = 2,
) {
  const [query, setQuery]   = useState("");
  const [items, setItems]   = useState<T[]>([]);
  const [open, setOpen]     = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (value.length < minChars) { setItems([]); setOpen(false); return; }
      timerRef.current = setTimeout(async () => {
        try {
          const results = await fetchFn(value);
          setItems(results);
          setOpen(results.length > 0);
        } catch { setItems([]); setOpen(false); }
      }, 300);
    },
    [fetchFn, minChars],
  );

  const reset = () => { setQuery(""); setItems([]); setOpen(false); };
  return { query, onChange, items, open, setOpen, reset };
}

// ── Sub-components ────────────────────────────────────────────────────────

function ApiKeyBanner({ apiKey, setApiKey, recorder }: {
  apiKey: string; setApiKey: (k: string) => void; recorder: string | null;
}) {
  const [editing, setEditing] = useState(!apiKey);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
      <span className="font-medium text-muted-foreground shrink-0">🔑</span>
      {editing ? (
        <>
          <input
            className="flex-1 bg-transparent outline-none font-mono text-xs"
            placeholder="Paste your API key here…"
            defaultValue={apiKey}
            onBlur={(e) => {
              const v = e.target.value.trim();
              setApiKey(v);
              if (v) setEditing(false);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            autoFocus
          />
        </>
      ) : (
        <>
          <span className="flex-1 font-medium">
            Recording as: <span className="text-foreground">{recorder ?? "unknown"}</span>
          </span>
          <button
            className="text-xs text-muted-foreground underline"
            onClick={() => setEditing(true)}
          >
            change key
          </button>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}

function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      {...props}
    />
  );
}

function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

function IndicativeBadge() {
  return (
    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
      indicative only
    </span>
  );
}

// ── Survey Form ───────────────────────────────────────────────────────────

interface FormState {
  isExistingBuyer: boolean | null;
  customerId: string;
  customerCompany: string;
  prospectName: string;
  prospectState: string;
  prospectDistrict: string;
  segment: string;
  prayagItemCode: string;
  prayagItemName: string;
  competitorBrand: string;
  competitorProduct: string;
  entryMode: "net_direct" | "mrp_discount";
  netPrice: string;
  mrp: string;
  discountPct: string;
  unit: string;
  packSize: string;
  reasons: string[];
  monthlyVolume: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  isExistingBuyer: null,
  customerId: "", customerCompany: "",
  prospectName: "", prospectState: "", prospectDistrict: "",
  segment: "", prayagItemCode: "", prayagItemName: "",
  competitorBrand: "", competitorProduct: "",
  entryMode: "net_direct",
  netPrice: "", mrp: "", discountPct: "",
  unit: "piece", packSize: "",
  reasons: [], monthlyVolume: "", note: "",
};

function computeNet(mrp: string, discountPct: string): number | null {
  const m = parseFloat(mrp);
  const d = parseFloat(discountPct);
  if (!isFinite(m) || m <= 0) return null;
  if (!isFinite(d) || d < 0 || d >= 100) return null;
  return Math.round(m * (1 - d / 100) * 100) / 100;
}

function SurveyForm({ apiKey, meta, onSubmitted }: {
  apiKey: string;
  meta: MetaResponse | undefined;
  onSubmitted: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // Customer autocomplete
  const custAC = useAutocomplete<CustomerRow>(
    async (q) => {
      const res = await fetch(API(`market-survey/customers?q=${encodeURIComponent(q)}`));
      return ((await res.json()) as { rows: CustomerRow[] }).rows;
    },
  );

  // Product autocomplete (filtered to segment)
  const prodAC = useAutocomplete<ProductRow>(
    async (q) => {
      const seg = form.segment ? `&segment=${encodeURIComponent(form.segment)}` : "";
      const res = await fetch(API(`market-survey/products?q=${encodeURIComponent(q)}${seg}`));
      return ((await res.json()) as { rows: ProductRow[] }).rows;
    },
  );

  const computedNet = form.entryMode === "mrp_discount"
    ? computeNet(form.mrp, form.discountPct)
    : null;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!apiKey) throw new Error("API key required");
      const body: Record<string, unknown> = {
        isExistingBuyer: form.isExistingBuyer,
        segment:         form.segment,
        competitorBrand: form.competitorBrand,
        entryMode:       form.entryMode,
        unit:            form.unit,
        reasons:         form.reasons,
      };
      if (form.isExistingBuyer) {
        body.customerId = form.customerId;
      } else {
        body.prospectName = form.prospectName;
        body.state        = form.prospectState || undefined;
        body.district     = form.prospectDistrict || undefined;
      }
      if (form.prayagItemCode) body.prayagItemCode    = form.prayagItemCode;
      if (form.competitorProduct) body.competitorProduct = form.competitorProduct;
      if (form.packSize)        body.packSize          = form.packSize;
      if (form.note)            body.note              = form.note;
      if (form.monthlyVolume)   body.monthlyVolume     = parseFloat(form.monthlyVolume);

      if (form.entryMode === "net_direct") {
        body.netPrice = parseFloat(form.netPrice);
      } else {
        body.mrp        = parseFloat(form.mrp);
        body.discountPct = parseFloat(form.discountPct);
      }

      return apiFetch<{ id: number; netPrice: number; recordedBy: string }>(
        "market-survey",
        apiKey,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: (data) => {
      setSuccess(`Saved (id ${data.id}) — net price ₹${data.netPrice.toFixed(2)} by ${data.recordedBy}`);
      setError(null);
      setForm(EMPTY_FORM);
      custAC.reset();
      prodAC.reset();
      qc.invalidateQueries({ queryKey: ["ms-list"] });
      qc.invalidateQueries({ queryKey: ["ms-summary"] });
      qc.invalidateQueries({ queryKey: ["ms-by-brand"] });
      qc.invalidateQueries({ queryKey: ["ms-coverage"] });
      qc.invalidateQueries({ queryKey: ["ms-meta"] });
      onSubmitted();
    },
    onError: (e: Error) => {
      setError(e.message);
      setSuccess(null);
    },
  });

  const canSubmit =
    form.isExistingBuyer !== null &&
    (form.isExistingBuyer ? !!form.customerId : !!form.prospectName) &&
    !!form.segment && !!form.competitorBrand &&
    (form.entryMode === "net_direct"
      ? !!form.netPrice && parseFloat(form.netPrice) > 0
      : !!form.mrp && !!form.discountPct && computedNet !== null) &&
    !!apiKey && !mutation.isPending;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }}
    >
      {/* 1. RESPONDENT */}
      <Section title="1 · Respondent">
        <Field label="Buyer type" required>
          <div className="flex gap-3">
            {[true, false].map((v) => (
              <label key={String(v)} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={form.isExistingBuyer === v}
                  onChange={() => {
                    set({ isExistingBuyer: v, customerId: "", customerCompany: "",
                          prospectName: "", prospectState: "", prospectDistrict: "" });
                    custAC.reset();
                  }}
                />
                <span className="text-sm">{v ? "Existing Prayag buyer" : "New prospect"}</span>
              </label>
            ))}
          </div>
        </Field>

        {form.isExistingBuyer === true && (
          <Field label="Customer" required>
            <div className="relative">
              <Input
                placeholder="Search customer name or ID…"
                value={custAC.query}
                onChange={(e) => {
                  if (form.customerId) set({ customerId: "", customerCompany: "" });
                  custAC.onChange(e.target.value);
                }}
              />
              {form.customerId && (
                <div className="mt-1 flex items-center gap-2 text-sm text-green-700">
                  <span>✓</span>
                  <span className="font-medium">{form.customerCompany}</span>
                  <span className="text-muted-foreground">{form.customerId}</span>
                  <button type="button" className="ml-auto text-xs underline" onClick={() => {
                    set({ customerId: "", customerCompany: "" }); custAC.reset();
                  }}>clear</button>
                </div>
              )}
              {custAC.open && !form.customerId && (
                <ul className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                  {custAC.items.map((c) => (
                    <li
                      key={c.id}
                      className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
                      onMouseDown={() => {
                        set({ customerId: c.id, customerCompany: c.company });
                        custAC.reset();
                      }}
                    >
                      <span className="font-medium">{c.company}</span>
                      <span className="ml-2 text-muted-foreground text-xs">{c.id} · {c.state}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>
        )}

        {form.isExistingBuyer === false && (
          <>
            <Field label="Prospect name" required>
              <Input
                placeholder="Business name as known locally"
                value={form.prospectName}
                onChange={(e) => set({ prospectName: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-0.5">
                This will NOT create a customer master record — it will be flagged for review.
              </p>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <Select value={form.prospectState} onChange={(e) => set({ prospectState: e.target.value })}>
                  <option value="">— select —</option>
                  {meta?.states.map((s) => (
                    <option key={s.canon} value={s.canon}>{s.canon}</option>
                  ))}
                </Select>
              </Field>
              <Field label="District">
                <Input
                  placeholder="District"
                  value={form.prospectDistrict}
                  onChange={(e) => set({ prospectDistrict: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
      </Section>

      {/* 2. WHAT THEY BUY */}
      <Section title="2 · What they buy">
        <Field label="Segment" required>
          <Select
            value={form.segment}
            onChange={(e) => set({ segment: e.target.value, prayagItemCode: "", prayagItemName: "" })}
          >
            <option value="">— select segment —</option>
            {meta?.segments.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>

        <Field label="Prayag product (optional)">
          <div className="relative">
            <Input
              placeholder="Search by code or name…"
              value={prodAC.query}
              onChange={(e) => {
                if (form.prayagItemCode) set({ prayagItemCode: "", prayagItemName: "" });
                prodAC.onChange(e.target.value);
              }}
              disabled={!form.segment}
            />
            {form.prayagItemCode && (
              <div className="mt-1 flex items-center gap-2 text-sm text-green-700">
                <span>✓</span>
                <span className="font-medium">{form.prayagItemCode}</span>
                <span className="text-muted-foreground">{form.prayagItemName}</span>
                <button type="button" className="ml-auto text-xs underline" onClick={() => {
                  set({ prayagItemCode: "", prayagItemName: "" }); prodAC.reset();
                }}>clear</button>
              </div>
            )}
            {prodAC.open && !form.prayagItemCode && (
              <ul className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md max-h-40 overflow-y-auto">
                {prodAC.items.map((p) => (
                  <li
                    key={`${p.segment}/${p.itemCode}`}
                    className="cursor-pointer px-3 py-2 text-sm hover:bg-accent"
                    onMouseDown={() => {
                      set({ prayagItemCode: p.itemCode, prayagItemName: p.itemName ?? p.itemCode });
                      prodAC.reset();
                    }}
                  >
                    <span className="font-medium">{p.itemCode}</span>
                    {p.itemName && <span className="ml-2 text-muted-foreground">{p.itemName}</span>}
                    {p.currentMrp && <span className="ml-auto float-right text-xs">MRP ₹{p.currentMrp}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        <Field label="Competitor brand" required>
          <div className="relative">
            <Input
              placeholder="e.g. Astral, Finolex, Supreme…"
              value={form.competitorBrand}
              onChange={(e) => set({ competitorBrand: e.target.value })}
              list="brand-suggestions"
            />
            <datalist id="brand-suggestions">
              {meta?.knownBrands.map((b) => (
                <option key={b.brand} value={b.brand}>
                  {b.surveyCount} survey{b.surveyCount !== 1 ? "s" : ""}
                </option>
              ))}
            </datalist>
            {form.competitorBrand && meta?.knownBrands.find(
              (b) => b.brand.toLowerCase() === form.competitorBrand.toLowerCase()
            ) && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {meta.knownBrands.find(
                  (b) => b.brand.toLowerCase() === form.competitorBrand.toLowerCase()
                )!.surveyCount} existing surveys for this brand
              </div>
            )}
          </div>
        </Field>

        <Field label="Competitor product name / code (optional)">
          <Input
            placeholder="Their product description or code if known"
            value={form.competitorProduct}
            onChange={(e) => set({ competitorProduct: e.target.value })}
          />
        </Field>
      </Section>

      {/* 3. THE PRICE */}
      <Section title="3 · The price">
        <Field label="How are you entering the price?" required>
          <div className="flex gap-4">
            {(["net_direct", "mrp_discount"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={form.entryMode === m}
                  onChange={() => set({ entryMode: m, netPrice: "", mrp: "", discountPct: "" })}
                />
                <span className="text-sm">
                  {m === "net_direct" ? "Net price the retailer pays" : "MRP + discount %"}
                </span>
              </label>
            ))}
          </div>
        </Field>

        {form.entryMode === "net_direct" ? (
          <Field label="Net price (₹ per unit)" required>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={form.netPrice}
              onChange={(e) => set({ netPrice: e.target.value })}
            />
          </Field>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="MRP (₹)" required>
                <Input
                  type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={form.mrp}
                  onChange={(e) => set({ mrp: e.target.value })}
                />
              </Field>
              <Field label="Discount (%)" required>
                <Input
                  type="number" min="0" max="99.99" step="0.01" placeholder="0.00"
                  value={form.discountPct}
                  onChange={(e) => set({ discountPct: e.target.value })}
                />
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
            <Select value={form.unit} onChange={(e) => set({ unit: e.target.value })}>
              {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label="Pack size (if different)">
            <Input
              placeholder="e.g. 10 pcs/box"
              value={form.packSize}
              onChange={(e) => set({ packSize: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      {/* 4. CONTEXT */}
      <Section title="4 · Context (optional)">
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

        <Field label="Approximate monthly volume">
          <Input
            type="number" min="0" step="1" placeholder="units per month"
            value={form.monthlyVolume}
            onChange={(e) => set({ monthlyVolume: e.target.value })}
          />
        </Field>

        <Field label="Notes">
          <textarea
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            rows={2}
            placeholder="Anything else worth capturing"
            value={form.note}
            onChange={(e) => set({ note: e.target.value })}
          />
        </Field>
      </Section>

      {/* Submit */}
      {error   && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {success && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground
                   hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mutation.isPending ? "Saving…" : "Submit Survey"}
      </button>

      {!apiKey && (
        <p className="text-xs text-muted-foreground text-center">
          Add your API key above to submit surveys.
        </p>
      )}
    </form>
  );
}

// ── Display tabs ──────────────────────────────────────────────────────────

type DisplayTab = "recent" | "summary" | "brands" | "coverage";

function MyRecentTab({ apiKey }: { apiKey: string }) {
  const recorder = useQuery<MetaResponse>({
    queryKey: ["ms-meta", apiKey],
    queryFn: () => apiFetch<MetaResponse>("market-survey/meta", apiKey),
    enabled: !!apiKey,
  });
  const name = recorder.data?.recorder;

  const { data, isPending } = useQuery<{ rows: SurveyRow[] }>({
    queryKey: ["ms-list", apiKey, name],
    queryFn: () =>
      apiFetch<{ rows: SurveyRow[] }>(
        `market-survey?recorder=${encodeURIComponent(name ?? "")}&limit=30`,
        apiKey,
      ),
    enabled: !!apiKey && !!name,
  });

  if (!apiKey) return <p className="text-sm text-muted-foreground p-4">Enter your API key to see your recent submissions.</p>;
  if (isPending) return <p className="text-sm text-muted-foreground p-4">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-4">No surveys recorded yet.</p>;

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
              {new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              {r.editable && <span className="ml-1 text-amber-600">(editable)</span>}
            </span>
          </div>
          <div className="text-muted-foreground">
            <span className="text-foreground font-medium">₹{r.netPrice.toFixed(2)}</span>
            {" / "}{r.unit} · {r.segment}
            {r.prayagItemCode && <span className="ml-1">[{r.prayagItemCode}]</span>}
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
  competitorBrand: string;
  mrp: number | null;
  netPriceDerived: number | null;
  discountPctAssumed: number | null;
  fetchedAt: string;
}

function SummaryTab({ apiKey }: { apiKey: string }) {
  const { data, isPending } = useQuery<{ rows: SummaryRow[] }>({
    queryKey: ["ms-summary"],
    queryFn: () => apiFetch<{ rows: SummaryRow[] }>("market-survey/summary", apiKey),
  });

  // Competitor snapshot — small dataset (≤150 rows), join client-side
  const { data: cpData } = useQuery<{ rows: CpRow[]; snapshotFetchedAt: string | null }>({
    queryKey: ["cp-rows-mapped"],
    queryFn: () => fetch(`${BASE}api/competitor-price?mappedOnly=true`).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  // Build Map: prayagItemCode → competitor row (first match per code)
  const cpByCode = new Map<string, CpRow>();
  for (const cp of cpData?.rows ?? []) {
    if (cp.prayagItemCode && !cpByCode.has(cp.prayagItemCode)) {
      cpByCode.set(cp.prayagItemCode, cp);
    }
  }

  const cpFetchedAt = cpData?.snapshotFetchedAt
    ? new Date(cpData.snapshotFetchedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;

  if (isPending) return <p className="text-sm text-muted-foreground p-4">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-4">No data yet — submit surveys with a Prayag product code to see comparisons here.</p>;

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
                <td className="py-2 font-medium">
                  {r.itemCode}
                  {r.indicativeOnly && <IndicativeBadge />}
                </td>
                <td className="py-2 text-muted-foreground">{r.segment}</td>
                <td className="py-2 text-right">{r.currentMrp != null ? `₹${r.currentMrp}` : "—"}</td>
                {/* Competitor columns */}
                <td className="py-2 text-right">
                  {cp ? (
                    <span title={`${cp.competitorBrand} · snapshot ${cpFetchedAt ?? "unknown"}`}>
                      {cp.mrp != null ? `₹${cp.mrp.toFixed(2)}` : "—"}
                    </span>
                  ) : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-2 text-right">
                  {cp?.netPriceDerived != null ? (
                    <span className="text-muted-foreground" title={`Derived: ${cp.discountPctAssumed}% off MRP — not a street price`}>
                      ₹{cp.netPriceDerived.toFixed(2)}
                    </span>
                  ) : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-2 text-right font-medium">₹{r.medianCompetitorNet.toFixed(2)}</td>
                <td className="py-2 text-right text-muted-foreground">
                  {r.minNet === r.maxNet ? "—" : `₹${r.minNet.toFixed(0)}–${r.maxNet.toFixed(0)}`}
                </td>
                <td className="py-2 text-right">{r.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground px-1">
        "Indicative only" = fewer than 5 surveys. Comp. net is derived at 40% off Sparsh Pearl MRP — not an observed street price.
        {cpFetchedAt && <span className="ml-1">Competitor snapshot: {cpFetchedAt}.</span>}
        Map codes on the <a href="/mrp/competition" className="underline">Competition Prices</a> page.
      </p>
    </div>
  );
}

function BrandsTab({ apiKey }: { apiKey: string }) {
  const { data, isPending } = useQuery<{ rows: BrandRow[] }>({
    queryKey: ["ms-by-brand"],
    queryFn: () => apiFetch<{ rows: BrandRow[] }>("market-survey/by-brand", apiKey),
  });

  if (isPending) return <p className="text-sm text-muted-foreground p-4">Loading…</p>;
  if (!data?.rows.length) return <p className="text-sm text-muted-foreground p-4">No surveys recorded yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-2 text-left">Brand</th>
            <th className="py-2 text-left">Segments</th>
            <th className="py-2 text-right">Median net</th>
            <th className="py-2 text-right">Range</th>
            <th className="py-2 text-right">n</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.rows.map((r) => (
            <tr key={r.brand} className="hover:bg-muted/40">
              <td className="py-2 font-medium">{r.brand}</td>
              <td className="py-2 text-muted-foreground">{r.segments.join(", ")}</td>
              <td className="py-2 text-right font-medium">₹{r.medianNet.toFixed(2)}</td>
              <td className="py-2 text-right text-muted-foreground">
                {r.minNet === r.maxNet ? "—" : `₹${r.minNet.toFixed(0)}–${r.maxNet.toFixed(0)}`}
              </td>
              <td className="py-2 text-right">
                {r.n < 5 && <IndicativeBadge />}
                {r.n}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoverageTab({ apiKey }: { apiKey: string }) {
  const { data, isPending } = useQuery<{
    thresholdForAdequacy: number;
    gapSegments: { segment: string; total: number; hasGap: boolean }[];
  }>({
    queryKey: ["ms-coverage"],
    queryFn: () =>
      apiFetch<{ thresholdForAdequacy: number; gapSegments: { segment: string; total: number; hasGap: boolean }[] }>(
        "market-survey/coverage",
        apiKey,
      ),
  });

  if (isPending) return <p className="text-sm text-muted-foreground p-4">Loading…</p>;

  const gaps = data?.gapSegments ?? [];
  if (!gaps.length) return <p className="text-sm text-green-700 p-4">All segments have ≥5 surveys. Good coverage!</p>;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground text-xs">
        Segments with fewer than {data?.thresholdForAdequacy ?? 5} surveys total. Prioritise these areas.
      </p>
      <div className="divide-y">
        {gaps.map((g) => (
          <div key={g.segment} className="flex items-center gap-3 py-2">
            <div className="flex-1 font-medium">{g.segment}</div>
            <div className="text-muted-foreground">{g.total} survey{g.total !== 1 ? "s" : ""}</div>
            <div className="w-32 rounded-full bg-muted h-1.5">
              <div
                className="h-1.5 rounded-full bg-amber-500"
                style={{ width: `${Math.min(100, (g.total / (data?.thresholdForAdequacy ?? 5)) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

const LS_KEY = "prayag_api_key";

export default function MarketSurveyPage() {
  const [apiKey, setApiKey] = useState<string>(() => {
    try { return localStorage.getItem(LS_KEY) ?? ""; } catch { return ""; }
  });
  const [tab, setTab] = useState<DisplayTab>("summary");

  const persistKey = (k: string) => {
    setApiKey(k);
    try { localStorage.setItem(LS_KEY, k); } catch { /* ignore */ }
  };

  const { data: meta } = useQuery<MetaResponse>({
    queryKey: ["ms-meta", apiKey],
    queryFn: () => apiFetch<MetaResponse>("market-survey/meta", apiKey),
    staleTime: 2 * 60 * 1000,
  });

  // Reset to "My Recent" after a successful submit
  const onSubmitted = () => setTab("recent");

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="border-b px-6 py-4 space-y-2 shrink-0">
        <h1 className="text-xl font-semibold">Market Survey</h1>
        <p className="text-sm text-muted-foreground">
          Record what retailers buy from competitors and at what price.
          This data stays separate from MRP calculations and scheme data until reviewed.
        </p>
        <ApiKeyBanner apiKey={apiKey} setApiKey={persistKey} recorder={meta?.recorder ?? null} />
      </div>

      {/* Main — form left, display right */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Form panel */}
        <div className="w-full max-w-md shrink-0 overflow-y-auto border-r p-6">
          <SurveyForm apiKey={apiKey} meta={meta} onSubmitted={onSubmitted} />
        </div>

        {/* Display panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Tab bar */}
          <div className="border-b px-4 shrink-0">
            <nav className="flex gap-1">
              {([
                ["summary",  "Per Product"],
                ["brands",   "By Brand"],
                ["coverage", "Coverage Gaps"],
                ["recent",   "My Recent"],
              ] as [DisplayTab, string][]).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    tab === id
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "summary"  && <SummaryTab  apiKey={apiKey} />}
            {tab === "brands"   && <BrandsTab   apiKey={apiKey} />}
            {tab === "coverage" && <CoverageTab apiKey={apiKey} />}
            {tab === "recent"   && <MyRecentTab apiKey={apiKey} />}
          </div>
        </div>
      </div>
    </div>
  );
}
