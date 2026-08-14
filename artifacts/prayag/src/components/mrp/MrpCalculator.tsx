// MRP Back-Calculator — works backwards from target retailer price → MRP.
//
// Chain:  target retailer buying price
//           ÷ (1 − distributor margin)   → distributor buying price
//           ÷ (1 − primary discount)     → back-calculated MRP
//
// Primary discount: volume-weighted from margin_fact (GP Margin workbooks).
// Distributor margin: defaulted from secondary register, always user-editable.
// mrp_history is NEVER written by this calculator — it is a proposal tool only.
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search, AlertTriangle, Info, Loader2, ChevronDown,
  TrendingUp, TrendingDown, Calculator, ShieldAlert,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types ──────────────────────────────────────────────────────────────────
interface IdentitySample {
  month: string;
  mrp: number;
  discountFrac: number;
  impliedSale: number;
  avgSale: number;
  diffRupees: number;
}

interface CalculatorData {
  itemCode: string;
  itemName: string | null;
  segment: string;
  series: string | null;
  isAmbiguousCode: boolean;
  availableSegments?: string[];
  currentMrp: number | null;
  mrpEffectiveFrom: string | null;
  primaryDiscount: {
    hasData: boolean;
    weightedDiscount: number | null;
    totalQty: number | null;
    monthsCovered: number;
    months: string[];
    identitySamples: IdentitySample[];
  };
  bomCost: { hasData: boolean; weightedValue: number | null };
  realisedDiscount: {
    hasData: boolean;
    value: number | null;
    totalQty: number | null;
    monthsCovered: number;
  };
  discountGapPoints: number | null;
  discountGapFlagged: boolean;
  distributorMarginDefault: {
    source: "secondary" | "assumed";
    value: number | null;
    note: string;
  };
}

interface AmbiguousError {
  error: string;
  availableSegments: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null) return "—";
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function pct(n: number | null | undefined, dp = 1): string {
  if (n == null) return "—";
  return (n * 100).toFixed(dp) + "%";
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const SEGMENT_COLORS: Record<string, string> = {
  "PTMT": "bg-blue-100 text-blue-800",
  "CP": "bg-amber-100 text-amber-800",
  "Pipe & Fitting": "bg-green-100 text-green-800",
  "Sanitaryware": "bg-purple-100 text-purple-800",
  "Hardware": "bg-slate-100 text-slate-700",
  "QUAA & FERN": "bg-rose-100 text-rose-800",
};

// ── Sub-components ─────────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
      {children}
    </p>
  );
}

function DataRow({
  label,
  value,
  sub,
  flag,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  flag?: boolean;
  highlight?: "good" | "warn" | "neutral";
}) {
  const color = highlight === "good" ? "text-emerald-700" : highlight === "warn" ? "text-amber-700" : "text-slate-800";
  return (
    <div className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0">
      <div>
        <span className="text-sm text-slate-600">{label}</span>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
      </div>
      <span className={`text-sm font-semibold ml-4 text-right ${color} ${flag ? "text-amber-700" : ""}`}>
        {value}
        {flag && <AlertTriangle className="inline h-3.5 w-3.5 ml-1 text-amber-600" />}
      </span>
    </div>
  );
}

function ChainStep({
  label,
  value,
  op,
  operand,
  result,
  highlight,
}: {
  label: string;
  value: string;
  op?: string;
  operand?: string;
  result?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${highlight ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"}`}>
      <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-blue-700" : "text-slate-800"}`}>{value}</p>
      {op && operand && result && (
        <p className="text-xs text-slate-500 mt-0.5">
          {op} {operand} → <span className="font-medium">{result}</span>
        </p>
      )}
    </div>
  );
}

// ── Competitor panel ───────────────────────────────────────────────────────
// Shows competitor rows mapped to this Prayag code from the local snapshot.
// Three explicit states: no-row, unmapped (row exists but not linked), fetch-error.
// Every figure carries brand, fetch date, and the word "derived" on the net price.

interface CompetitorRowEntry {
  id: number; competitorBrand: string; competitorName: string | null;
  category: string; mrp: number | null; netPriceDerived: number | null;
  discountPctAssumed: number | null; fetchedAt: string;
}
interface CompetitorForCode {
  code: string; rows: CompetitorRowEntry[];
  snapshotFetchedAt: string | null; lastError: string | null;
}

function CompetitorPanel({ code }: { code: string }) {
  const { data, isError, isPending } = useQuery<CompetitorForCode>({
    queryKey: ["competitor-for-code", code],
    queryFn: () =>
      fetch(`${BASE}/api/competitor-price/for-code/${encodeURIComponent(code)}`).then((r) => r.json()),
    staleTime: 10 * 60_000,
  });

  if (isPending) return null;

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null;

  const snapshotAge = fmtDate(data?.snapshotFetchedAt ?? null);

  // State 1: fetch failed or error field set
  if (isError || data?.lastError) {
    return (
      <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        <span className="font-medium">⚠ Competitor data unavailable.</span>{" "}
        {snapshotAge
          ? `Last snapshot: ${snapshotAge}. Stale figures — nothing has changed since that date.`
          : "Competition app could not be reached."}
      </div>
    );
  }

  // State 2: no mapped row for this code
  if (!data?.rows.length) {
    return (
      <div className="mt-3 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-400 flex items-center gap-2">
        <span>No competitor row mapped for code <span className="font-mono">{code}</span>.</span>
        <a href="/mrp/competition" className="underline text-slate-500 hover:text-slate-700">
          Map one →
        </a>
      </div>
    );
  }

  // State 3: mapped rows found
  return (
    <div className="mt-3 rounded border border-blue-100 bg-blue-50/40 px-3 py-2 text-xs space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-600 text-[11px] uppercase tracking-wide">
          Competitor — Sparsh Pearl
        </span>
        {snapshotAge && (
          <span className="text-[10px] text-slate-400">snapshot {snapshotAge}</span>
        )}
      </div>
      {data.rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-slate-600 font-medium">{r.competitorName}</span>
          <span className="text-slate-400">{r.category}</span>
          {r.mrp != null && (
            <span className="font-mono text-slate-700">MRP ₹{r.mrp.toFixed(2)}</span>
          )}
          {r.netPriceDerived != null && (
            <span className="text-slate-500">
              net ₹{r.netPriceDerived.toFixed(2)}
              <span className="ml-0.5 text-slate-400">
                (derived, {r.discountPctAssumed}% off MRP — not a street price)
              </span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
interface MrpCalculatorProps {
  initialCode?: string;
  initialSegment?: string;
}

export default function MrpCalculator({ initialCode, initialSegment }: MrpCalculatorProps) {
  // ── Lookup state ────────────────────────────────────────────────────────
  const [codeInput, setCodeInput] = useState(initialCode ?? "");
  const [chosenCode, setChosenCode] = useState(initialCode ?? "");
  const [chosenSegment, setChosenSegment] = useState(initialSegment ?? "");
  const [pendingSegmentChoose, setPendingSegmentChoose] = useState<string[] | null>(null);

  // ── Calculator inputs ────────────────────────────────────────────────────
  const [targetRetailerPrice, setTargetRetailerPrice] = useState<string>("");
  const [distributorMarginPct, setDistributorMarginPct] = useState<string>("");
  const [distMarginSource, setDistMarginSource] = useState<"secondary" | "assumed" | "user">("assumed");
  const [manualPrimaryDiscountPct, setManualPrimaryDiscountPct] = useState<string>("");
  const [showIdentity, setShowIdentity] = useState(false);

  // Trigger lookup
  const [lookupKey, setLookupKey] = useState<{ code: string; segment: string } | null>(
    initialCode ? { code: initialCode, segment: initialSegment ?? "" } : null,
  );

  // ── Data fetch ─────────────────────────────────────────────────────────
  const fetchUrl = lookupKey
    ? `${BASE}/api/mrp/calculator?code=${encodeURIComponent(lookupKey.code)}${lookupKey.segment ? `&segment=${encodeURIComponent(lookupKey.segment)}` : ""}`
    : null;

  const { data: rawData, isLoading, error: fetchError } = useQuery<CalculatorData | AmbiguousError>({
    queryKey: ["mrp-calc", lookupKey?.code, lookupKey?.segment],
    queryFn: () => fetch(fetchUrl!).then((r) => r.json()),
    enabled: !!fetchUrl,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const isAmbigError = rawData && "availableSegments" in rawData && "error" in rawData;
  const data = (rawData && !isAmbigError) ? (rawData as CalculatorData) : null;

  // When data loads, seed distributor margin from default; reset manual primary discount
  const seededRef = useRef<string>("");
  useEffect(() => {
    if (!data) return;
    const key = `${data.itemCode}|${data.segment}`;
    if (seededRef.current === key) return;
    seededRef.current = key;
    const def = data.distributorMarginDefault;
    if (def.value != null) {
      setDistributorMarginPct((def.value * 100).toFixed(1));
      setDistMarginSource(def.source);
    } else {
      setDistributorMarginPct("");
      setDistMarginSource("assumed");
    }
    // Reset manual primary discount whenever a new code is loaded
    setManualPrimaryDiscountPct("");
  }, [data]);

  // Handle ambiguous response
  useEffect(() => {
    if (isAmbigError) {
      setPendingSegmentChoose((rawData as AmbiguousError).availableSegments);
    } else {
      setPendingSegmentChoose(null);
    }
  }, [isAmbigError, rawData]);

  // ── Derived calc ────────────────────────────────────────────────────────
  const trp = parseFloat(targetRetailerPrice) || null;
  const dm = parseFloat(distributorMarginPct) / 100 || null;
  // Primary discount: user override takes precedence; fall back to workbook value.
  const pd = manualPrimaryDiscountPct
    ? parseFloat(manualPrimaryDiscountPct) / 100
    : (data?.primaryDiscount.hasData ? (data.primaryDiscount.weightedDiscount ?? null) : null);
  const currentMrp = data?.currentMrp ?? null;
  const bom = data?.bomCost.weightedValue ?? null;

  const canCalc = trp != null && dm != null && pd != null && dm > 0 && dm < 1 && pd > 0 && pd < 1;
  const distBuyingPrice = canCalc ? round2(trp! / (1 - dm!)) : null;
  const backCalcMrp = canCalc ? round2(distBuyingPrice! / (1 - pd!)) : null;
  const mrpDiffRs = backCalcMrp != null && currentMrp != null ? round2(backCalcMrp - currentMrp) : null;
  const mrpDiffPct = mrpDiffRs != null && currentMrp != null ? round2((mrpDiffRs / currentMrp) * 100) : null;

  // Gross contribution
  const avgSaleAtCurrentMrp = currentMrp != null && pd != null ? round2(currentMrp * (1 - pd)) : null;
  const gcAtCurrent = avgSaleAtCurrentMrp != null && bom != null && avgSaleAtCurrentMrp > 0
    ? round2(((avgSaleAtCurrentMrp - bom) / avgSaleAtCurrentMrp) * 100)
    : null;
  const gcAtNew = distBuyingPrice != null && bom != null && distBuyingPrice > 0
    ? round2(((distBuyingPrice - bom) / distBuyingPrice) * 100)
    : null;

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleLookup = useCallback(() => {
    const c = codeInput.trim().toUpperCase();
    if (!c) return;
    setChosenCode(c);
    setChosenSegment("");
    setPendingSegmentChoose(null);
    setLookupKey({ code: c, segment: "" });
    seededRef.current = "";
  }, [codeInput]);

  const handleSegmentChosen = (seg: string) => {
    setChosenSegment(seg);
    setPendingSegmentChoose(null);
    setLookupKey({ code: chosenCode, segment: seg });
    seededRef.current = "";
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-auto px-6 py-5 space-y-5 max-w-3xl mx-auto">

      {/* ── Notice ───────────────────────────────────────────────────────── */}
      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2.5 flex items-start gap-2 text-xs text-blue-800">
        <Calculator className="h-3.5 w-3.5 shrink-0 mt-0.5 text-blue-600" />
        <span>
          <span className="font-semibold">Proposal only.</span>{" "}
          This calculator never writes to the price database. Applying a new MRP requires a separate confirmation step.
        </span>
      </div>

      {/* ── Code picker ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border p-4 space-y-3">
        <SectionLabel>Item lookup</SectionLabel>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Item code (e.g. 144, CNS-15)"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleLookup()}
              className="pl-9 font-mono"
            />
          </div>
          <Button onClick={handleLookup} disabled={!codeInput.trim() || isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Look up"}
          </Button>
        </div>

        {/* Ambiguous — ask segment */}
        {pendingSegmentChoose && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-800 font-medium flex items-center gap-1.5 mb-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Ambiguous code — choose a segment
            </p>
            <p className="text-xs text-amber-700 mb-3">
              <span className="font-mono font-medium">{chosenCode}</span> exists in multiple segments with different products and MRPs. Select one to continue.
            </p>
            <div className="flex gap-2 flex-wrap">
              {pendingSegmentChoose.map((seg) => (
                <Button
                  key={seg}
                  variant="outline"
                  size="sm"
                  className="border-amber-300 text-amber-800 hover:bg-amber-100"
                  onClick={() => handleSegmentChosen(seg)}
                >
                  {seg}
                </Button>
              ))}
            </div>
          </div>
        )}

        {fetchError && (
          <p className="text-sm text-red-600">Failed to load data. Check the item code and try again.</p>
        )}
      </div>

      {/* ── Data loaded ─────────────────────────────────────────────────── */}
      {data && (
        <>
          {/* Item header */}
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-slate-800 text-base">{data.itemCode}</span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEGMENT_COLORS[data.segment] ?? "bg-gray-100 text-gray-700"}`}>
                    {data.segment}
                  </span>
                  {data.isAmbiguousCode && (
                    <Badge variant="outline" className="border-amber-300 text-amber-700 text-[10px]">
                      <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />Ambiguous
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-slate-600 mt-0.5">{data.itemName ?? "—"}</p>
                {data.series && <p className="text-xs text-slate-400 mt-0.5">{data.series}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-bold text-slate-800">{fmt(data.currentMrp)}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Current MRP{data.mrpEffectiveFrom ? ` · from ${new Date(data.mrpEffectiveFrom + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}` : ""}
                </p>
              </div>
            </div>
          </div>

          {/* Discount data */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Primary discount */}
            <div className="bg-white rounded-lg border p-4">
              <SectionLabel>Primary discount (plan)</SectionLabel>
              {data.primaryDiscount.hasData ? (
                <>
                  <DataRow
                    label="Weighted discount"
                    value={pct(data.primaryDiscount.weightedDiscount)}
                    sub={`${data.primaryDiscount.monthsCovered} month${data.primaryDiscount.monthsCovered !== 1 ? "s" : ""} · ${(data.primaryDiscount.totalQty ?? 0).toLocaleString("en-IN")} units`}
                  />
                  <DataRow
                    label="Formula"
                    value="Σ(discount_frac × qty) / Σ(qty)"
                    sub="fraction of MRP — GP Margin workbooks"
                  />
                  <button
                    onClick={() => setShowIdentity(!showIdentity)}
                    className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1"
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${showIdentity ? "rotate-180" : ""}`} />
                    Identity check: MRP × (1 − disc) = avg sale
                  </button>
                  {showIdentity && data.primaryDiscount.identitySamples.length > 0 && (
                    <div className="mt-2 rounded border border-slate-100 overflow-hidden text-xs">
                      <table className="w-full">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-slate-500">Month</th>
                            <th className="px-2 py-1 text-right font-medium text-slate-500">MRP</th>
                            <th className="px-2 py-1 text-right font-medium text-slate-500">Implied</th>
                            <th className="px-2 py-1 text-right font-medium text-slate-500">Avg sale</th>
                            <th className="px-2 py-1 text-right font-medium text-slate-500">Δ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.primaryDiscount.identitySamples.map((s) => (
                            <tr key={s.month} className="border-t border-slate-100">
                              <td className="px-2 py-1 text-slate-600">{s.month}</td>
                              <td className="px-2 py-1 text-right text-slate-600">₹{s.mrp}</td>
                              <td className="px-2 py-1 text-right text-slate-600">₹{s.impliedSale}</td>
                              <td className="px-2 py-1 text-right text-slate-600">₹{s.avgSale}</td>
                              <td className={`px-2 py-1 text-right font-medium ${s.diffRupees > 1 ? "text-amber-700" : "text-emerald-700"}`}>
                                {s.diffRupees <= 1 ? "✓" : `₹${s.diffRupees}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-start gap-2 rounded bg-amber-50 border border-amber-200 p-3 mt-1">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">No discount data</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      No GP Margin workbook rows for this code. Enter the primary discount manually in the calculator below.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Realised discount */}
            <div className="bg-white rounded-lg border p-4">
              <SectionLabel>Realised discount (actual)</SectionLabel>
              {data.realisedDiscount.hasData ? (
                <>
                  <DataRow
                    label="Register discount"
                    value={pct(data.realisedDiscount.value)}
                    sub={`${data.realisedDiscount.monthsCovered} months · ${(data.realisedDiscount.totalQty ?? 0).toLocaleString("en-IN")} units`}
                  />
                  <DataRow
                    label="Formula"
                    value="1 − Σ(amount) / (Σ(qty) × current MRP)"
                    sub="from primary sale register (sale_line)"
                  />
                  {data.discountGapPoints != null && (
                    <div className={`mt-3 rounded px-3 py-2 ${data.discountGapFlagged ? "bg-amber-50 border border-amber-200" : "bg-slate-50 border border-slate-200"}`}>
                      <div className="flex items-center gap-1.5 text-xs">
                        {data.discountGapFlagged
                          ? <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                          : <Info className="h-3.5 w-3.5 text-slate-400" />}
                        <span className={data.discountGapFlagged ? "font-semibold text-amber-800" : "text-slate-600"}>
                          Gap: {data.discountGapPoints.toFixed(1)} pp
                          {data.discountGapFlagged
                            ? " — flagged (>5 pp). Plan vs actual diverging."
                            : " — within normal range."}
                        </span>
                      </div>
                      {data.discountGapFlagged && (
                        <p className="text-[11px] text-amber-700 mt-1">
                          GP Margin workbook (plan) and sale register (actual) differ by more than 5 percentage points. The back-calculated MRP uses the plan figure.
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-400 italic mt-1">No primary sale data for this code in the trailing 12 months.</p>
              )}
            </div>
          </div>

          {/* BOM cost */}
          <div className="bg-white rounded-lg border p-4">
            <SectionLabel>BOM cost (factory)</SectionLabel>
            {data.bomCost.hasData ? (
              <DataRow
                label="Volume-weighted BOM cost"
                value={fmt(data.bomCost.weightedValue)}
                sub="Factory cost only — no freight, overhead, or SG&A. All contribution figures below are GROSS CONTRIBUTION."
              />
            ) : (
              <p className="text-sm text-slate-400 italic">
                No BOM cost data for this code. Gross contribution cannot be computed.
              </p>
            )}
          </div>

          {/* ── Calculator inputs ────────────────────────────────────────── */}
          <div className="bg-white rounded-lg border p-4">
            <SectionLabel>Calculator inputs</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Target retailer buying price */}
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Target retailer buying price (₹)
                </label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="e.g. 90.00"
                  value={targetRetailerPrice}
                  onChange={(e) => setTargetRetailerPrice(e.target.value)}
                  className="font-mono"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  What the retailer pays the distributor.
                </p>
              </div>

              {/* Distributor margin */}
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Distributor margin %{" "}
                  <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    distMarginSource === "secondary" ? "bg-blue-100 text-blue-700" :
                    distMarginSource === "user" ? "bg-emerald-100 text-emerald-700" :
                    "bg-slate-100 text-slate-600"
                  }`}>
                    {distMarginSource}
                  </span>
                </label>
                <Input
                  type="number"
                  min={0}
                  max={99}
                  step={0.1}
                  placeholder={data.distributorMarginDefault.value != null
                    ? (data.distributorMarginDefault.value * 100).toFixed(1)
                    : "e.g. 15.0"}
                  value={distributorMarginPct}
                  onChange={(e) => {
                    setDistributorMarginPct(e.target.value);
                    setDistMarginSource("user");
                  }}
                  className="font-mono"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  {data.distributorMarginDefault.note}
                </p>
              </div>
            </div>

            {/* Primary discount override — always shown; defaults to workbook value when available */}
            <div className="mt-4">
              <label className="block text-xs text-slate-500 mb-1">
                Primary discount %{" "}
                {data.primaryDiscount.hasData ? (
                  <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    manualPrimaryDiscountPct ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"
                  }`}>
                    {manualPrimaryDiscountPct ? "override" : "workbook"}
                  </span>
                ) : (
                  <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700">
                    no workbook data — required
                  </span>
                )}
              </label>
              <Input
                id="manual-pd"
                type="number"
                min={0}
                max={99}
                step={0.1}
                placeholder={
                  data.primaryDiscount.hasData && data.primaryDiscount.weightedDiscount != null
                    ? (data.primaryDiscount.weightedDiscount * 100).toFixed(1)
                    : "e.g. 50.0"
                }
                value={manualPrimaryDiscountPct}
                className="font-mono max-w-xs"
                onChange={(e) => setManualPrimaryDiscountPct(e.target.value)}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {data.primaryDiscount.hasData
                  ? "Leave blank to use the workbook-derived weighted discount. Enter a value to override it."
                  : "No GP Margin workbook rows found — you must enter this figure manually."}
              </p>
              {!data.primaryDiscount.hasData && (
                <p className="text-[11px] text-amber-700 mt-0.5">
                  A silently inferred discount produces a confidently wrong MRP — always verify this figure.
                </p>
              )}
            </div>
          </div>

          {/* ── Chain display ────────────────────────────────────────────── */}
          {canCalc && (
            <div className="bg-white rounded-lg border p-4">
              <SectionLabel>Back-calculation chain</SectionLabel>
              <div className="space-y-2">
                <ChainStep
                  label="Target retailer buying price"
                  value={fmt(trp)}
                />
                <div className="flex items-center gap-2 px-4 text-xs text-slate-400">
                  <span>÷ (1 − {(dm! * 100).toFixed(1)}% distributor margin)</span>
                </div>
                <ChainStep
                  label="Distributor buying price (from company)"
                  value={fmt(distBuyingPrice)}
                  op="="
                  operand={`${fmt(trp)} ÷ ${(1 - dm!).toFixed(4)}`}
                  result={fmt(distBuyingPrice)}
                />
                <div className="flex items-center gap-2 px-4 text-xs text-slate-400">
                  <span>÷ (1 − {(pd! * 100).toFixed(1)}% primary discount)</span>
                </div>
                <ChainStep
                  label="Back-calculated MRP"
                  value={fmt(backCalcMrp)}
                  op="="
                  operand={`${fmt(distBuyingPrice)} ÷ ${(1 - pd!).toFixed(4)}`}
                  result={fmt(backCalcMrp)}
                  highlight
                />
              </div>
            </div>
          )}

          {/* ── Comparison ───────────────────────────────────────────────── */}
          {canCalc && currentMrp != null && (
            <div className="bg-white rounded-lg border p-4">
              <SectionLabel>Current vs proposed MRP</SectionLabel>

              {/* Diff banner */}
              <div className={`flex items-center gap-3 rounded-md border px-4 py-3 mb-4 ${
                mrpDiffRs! > 0 ? "border-blue-200 bg-blue-50" : mrpDiffRs! < 0 ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"
              }`}>
                {mrpDiffRs! > 0
                  ? <TrendingUp className="h-5 w-5 text-blue-600 shrink-0" />
                  : <TrendingDown className="h-5 w-5 text-rose-600 shrink-0" />}
                <div>
                  <p className={`text-sm font-semibold ${mrpDiffRs! > 0 ? "text-blue-800" : "text-rose-800"}`}>
                    Proposed MRP is {mrpDiffRs! > 0 ? "higher" : "lower"} by{" "}
                    {fmt(Math.abs(mrpDiffRs!))} ({Math.abs(mrpDiffPct!).toFixed(1)}%)
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {fmt(currentMrp)} current → {fmt(backCalcMrp)} proposed
                  </p>
                </div>
              </div>

              {/* Side-by-side table */}
              <div className="rounded border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-slate-500 text-xs">Metric</th>
                      <th className="px-4 py-2 text-right font-medium text-slate-600 text-xs">
                        Current MRP {fmt(currentMrp)}
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-blue-700 text-xs">
                        Proposed MRP {fmt(backCalcMrp)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-600">Dist. buying price</td>
                      <td className="px-4 py-2 text-right text-slate-700 font-mono">
                        {fmt(avgSaleAtCurrentMrp)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-700 font-mono">
                        {fmt(distBuyingPrice)}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-600">BOM cost</td>
                      <td className="px-4 py-2 text-right text-slate-700 font-mono">
                        {fmt(bom)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-700 font-mono">
                        {fmt(bom)}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-600 font-medium">
                        Gross contribution
                        <span className="block text-[10px] font-normal text-slate-400">(dist. price − BOM) ÷ dist. price</span>
                      </td>
                      <td className={`px-4 py-2 text-right font-semibold font-mono ${
                        bom == null ? "text-slate-400" : gcAtCurrent! >= 0 ? "text-emerald-700" : "text-red-700"
                      }`}>
                        {bom == null ? "—" : gcAtCurrent != null ? `${gcAtCurrent.toFixed(1)}%` : "—"}
                      </td>
                      <td className={`px-4 py-2 text-right font-semibold font-mono ${
                        bom == null ? "text-slate-400" : gcAtNew! >= 0 ? "text-emerald-700" : "text-red-700"
                      }`}>
                        {bom == null ? "—" : gcAtNew != null ? `${gcAtNew.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {bom == null && (
                <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
                  <Info className="h-3.5 w-3.5" />
                  BOM cost not available for this code — gross contribution cannot be computed.
                </p>
              )}

              {/* Proposal note */}
              <div className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">Proposal only.</span>{" "}
                This calculator has not changed the MRP. Applying a new MRP requires an explicit separate action with a confirmation step.
              </div>
            </div>
          )}

          {/* Not enough inputs yet */}
          {!canCalc && (
            <div className="bg-slate-50 rounded-lg border border-dashed border-slate-300 px-6 py-8 text-center">
              <Calculator className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400">
                {!data.primaryDiscount.hasData
                  ? "Enter the primary discount % and target retailer price above to calculate."
                  : "Enter a target retailer buying price above to calculate the back-calculated MRP."}
              </p>
            </div>
          )}

          {/* Competitor context — always shown when a code is loaded */}
          <CompetitorPanel code={data.itemCode} />
        </>
      )}

      {/* Empty state */}
      {!lookupKey && !data && (
        <div className="bg-slate-50 rounded-lg border border-dashed border-slate-300 px-6 py-12 text-center">
          <Calculator className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500 font-medium">Back-calculator</p>
          <p className="text-xs text-slate-400 mt-1">
            Enter an item code above and click Look up to load discount data.
          </p>
        </div>
      )}
    </div>
  );
}
