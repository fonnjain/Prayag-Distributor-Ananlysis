// AnalyticsTab — Tab 5 of Market Survey page.
// Ten analysis panels over the collected survey data.
// All numbers show their n; n < 5 is labelled INDICATIVE ONLY.

import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL;
const API  = (path: string) => `${BASE}api/${path}`;

const N_ADEQUATE = 5;
const isIndicative = (n: number) => n < N_ADEQUATE;

// ── Shared helpers ────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function IndicativeBadge() {
  return (
    <span className="ml-1 text-[10px] rounded bg-amber-100 text-amber-700 px-1.5 py-0.5 font-semibold uppercase tracking-wide">
      indicative only
    </span>
  );
}

function NTag({ n }: { n: number }) {
  return <span className="text-[10px] text-muted-foreground">(n={n})</span>;
}

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b pb-2 mb-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground py-4 text-center">{msg}</p>;
}

// ── Types ─────────────────────────────────────────────────────────────────

interface SummaryRow {
  itemCode: string; segment: string; itemName: string | null;
  currentMrp: number | null; n: number; indicativeOnly: boolean;
  medianCompetitorNet: number; minNet: number; maxNet: number;
  p25Net: number; p75Net: number;
}

interface BrandRow {
  brand: string; n: number; segments: string[]; states: string[];
  minNet: number; maxNet: number; medianNet: number;
}

interface ReasonsData {
  overall: { reason: string; count: number }[];
  bySegment: { segment: string; counts: Record<string, number> }[];
}

interface CreditCompRow {
  state: string; segment: string; n: number;
  medianCompetitorDays: number | null; medianPrayagDays: number | null;
  givenByDistributor: number; givenByCompetitorCompany: number; givenByUnknown: number;
}

interface SchemeCompRow {
  schemeType: string; n: number; valuesSeen: string[];
}

interface DeliveryCompRow {
  state: string; n: number;
  medianCompetitorDays: number | null; minCompetitor: number | null; maxCompetitor: number | null;
  medianPrayagDays: number | null; minPrayag: number | null; maxPrayag: number | null;
}

interface SizedOppRow {
  segment: string; state: string; n: number;
  estimatedMonthlyToCompetitor: number | null;
}

interface CoverageRow {
  segment: string; n: number;
}

interface NewSkuRow {
  prayagItemCode: string; segment: string; itemName: string | null;
  currentMrp: number | null; n: number; retailers: string[]; brands: string[];
}

interface VsCompRow {
  prayagItemCode: string; segment: string; itemName: string | null;
  currentMrp: number | null; surveyN: number; surveyMedian: number;
  competitorRows: {
    brand: string; code: string; name: string | null;
    mrp: number | null; netDerived: number | null; discountAssumed: number | null;
    label: "DERIVED";
  }[];
}

// ── Panel 1 — Per item ────────────────────────────────────────────────────

function Panel1() {
  const q = useQuery<{ rows: SummaryRow[] }>({
    queryKey: ["ms-summary"],
    queryFn: () => fetch(API("market-survey/summary")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load item summary.</p>;

  const rows = q.data.rows;
  if (rows.length === 0) return <EmptyState msg="No item-level data recorded yet." />;

  const gap = (r: SummaryRow) =>
    r.currentMrp != null ? ((r.currentMrp - r.medianCompetitorNet) / r.currentMrp) * 100 : -Infinity;

  const sorted = [...rows].sort((a, b) => {
    const aInd = isIndicative(a.n), bInd = isIndicative(b.n);
    if (aInd !== bInd) return aInd ? 1 : -1;
    if (!aInd) return gap(b) - gap(a);
    return b.n - a.n;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">Code</th>
            <th className="pb-1.5 pr-3 font-medium">Segment</th>
            <th className="pb-1.5 pr-3 font-medium">Item</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Our MRP</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Median Net</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Range</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Gap%</th>
            <th className="pb-1.5 font-medium text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const g = r.currentMrp != null
              ? ((r.currentMrp - r.medianCompetitorNet) / r.currentMrp * 100).toFixed(1) + "%"
              : "—";
            return (
              <tr key={`${r.itemCode}|${r.segment}`}
                className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
                <td className="py-1.5 pr-3 font-mono">{r.itemCode}</td>
                <td className="py-1.5 pr-3">{r.segment}</td>
                <td className="py-1.5 pr-3 max-w-[200px] truncate" title={r.itemName ?? ""}>
                  {r.itemName ?? <span className="italic text-muted-foreground">unknown</span>}
                  {isIndicative(r.n) && <IndicativeBadge />}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.currentMrp)}</td>
                <td className={`py-1.5 pr-3 text-right tabular-nums ${isIndicative(r.n) ? "" : "font-medium"}`}>
                  {fmt(r.medianCompetitorNet)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                  {fmt(r.minNet)} – {fmt(r.maxNet)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{g}</td>
                <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground mt-2">
        Gap% = (Our MRP − competitor median) / Our MRP. Rows with n &lt; {N_ADEQUATE} are INDICATIVE ONLY.
      </p>
    </div>
  );
}

// ── Panel 2 — By competitor brand ─────────────────────────────────────────

function Panel2() {
  const q = useQuery<{ rows: BrandRow[] }>({
    queryKey: ["ms-by-brand"],
    queryFn: () => fetch(API("market-survey/by-brand")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load brand data.</p>;

  const rows = q.data.rows;
  if (rows.length === 0) return <EmptyState msg="No competitor brand data recorded yet." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">Competitor Brand</th>
            <th className="pb-1.5 pr-3 font-medium">Segments</th>
            <th className="pb-1.5 pr-3 font-medium">States</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Median Net</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Range</th>
            <th className="pb-1.5 font-medium text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.brand} className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
              <td className="py-1.5 pr-3 font-medium">
                {r.brand}
                {isIndicative(r.n) && <IndicativeBadge />}
              </td>
              <td className="py-1.5 pr-3">{r.segments.join(", ")}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">
                {r.states.length === 0 ? "—" : r.states.join(", ")}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.medianNet)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {fmt(r.minNet)} – {fmt(r.maxNet)}
              </td>
              <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Panel 3 — Reasons breakdown ───────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  price: "Price",
  availability: "Availability",
  credit_terms: "Credit Terms",
  relationship: "Relationship",
  scheme: "Scheme / Incentive",
  quality: "Quality",
};

function Panel3() {
  const q = useQuery<ReasonsData>({
    queryKey: ["ms-reasons"],
    queryFn: () => fetch(API("market-survey/reasons")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load reasons data.</p>;

  const { overall, bySegment } = q.data;
  if (overall.length === 0) return <EmptyState msg="No reasons recorded yet." />;

  const maxCount = Math.max(...overall.map((r) => r.count), 1);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Overall</p>
        <div className="space-y-1.5">
          {overall.map((r) => (
            <div key={r.reason} className="flex items-center gap-2">
              <span className="text-xs w-32 text-right shrink-0">
                {REASON_LABELS[r.reason] ?? r.reason}
              </span>
              <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden">
                <div
                  className="bg-primary h-3 rounded-full"
                  style={{ width: `${(r.count / maxCount) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground w-6 text-right">{r.count}</span>
            </div>
          ))}
        </div>
      </div>

      {bySegment.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">By Segment</p>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-1 pr-3 text-left font-medium">Segment</th>
                  {overall.map((r) => (
                    <th key={r.reason} className="pb-1 pr-2 font-medium text-center">
                      {REASON_LABELS[r.reason] ?? r.reason}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bySegment.map((s) => (
                  <tr key={s.segment} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">{s.segment}</td>
                    {overall.map((r) => (
                      <td key={r.reason} className="py-1.5 pr-2 text-center tabular-nums text-muted-foreground">
                        {s.counts[r.reason] ?? "–"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Panel 4 — Credit comparison ───────────────────────────────────────────

function Panel4() {
  const q = useQuery<{ rows: CreditCompRow[] }>({
    queryKey: ["ms-credit-comparison"],
    queryFn: () => fetch(API("market-survey/credit-comparison")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load credit comparison.</p>;
  const rows = q.data.rows;
  if (rows.length === 0) return (
    <EmptyState msg="No credit data recorded yet. Fill in competitor credit days or credit source when submitting a survey." />
  );

  // Group by state
  const stateMap = new Map<string, CreditCompRow[]>();
  for (const r of rows) {
    if (!stateMap.has(r.state)) stateMap.set(r.state, []);
    stateMap.get(r.state)!.push(r);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Two numbers side-by-side — the comparison is the finding, not either number alone.
        A distributor funding 60 days from his own working capital is a different problem from a competitor
        funding it centrally.
      </p>
      {Array.from(stateMap.entries()).map(([state, segs]) => (
        <div key={state}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{state}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-1.5 pr-3 text-left font-medium">Segment</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">Competitor (median days)</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">Prayag (median days)</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">By distributor</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">By competitor co.</th>
                  <th className="pb-1.5 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {segs.map((r) => (
                  <tr key={`${r.state}|${r.segment}`}
                    className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
                    <td className="py-1.5 pr-3">
                      {r.segment}
                      {isIndicative(r.n) && <IndicativeBadge />}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium">
                      {r.medianCompetitorDays != null ? `${r.medianCompetitorDays} d` : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {r.medianPrayagDays != null ? `${r.medianPrayagDays} d` : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {r.givenByDistributor > 0 ? r.givenByDistributor : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {r.givenByCompetitorCompany > 0 ? r.givenByCompetitorCompany : "—"}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Panel 5 — Scheme comparison ───────────────────────────────────────────

const SCHEME_TYPE_LABELS: Record<string, string> = {
  percentage: "Percentage off",
  free_goods: "Free goods",
  slab:       "Slab scheme",
  none:       "No scheme",
  unknown:    "Unknown",
};

function Panel5() {
  const q = useQuery<{ rows: SchemeCompRow[] }>({
    queryKey: ["ms-scheme-comparison"],
    queryFn: () => fetch(API("market-survey/scheme-comparison")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load scheme data.</p>;
  const rows = q.data.rows;
  if (rows.length === 0) return (
    <EmptyState msg="No scheme data recorded yet. Fill in competitor scheme type and value when submitting a survey." />
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Field-observed scheme values. A comparison with any live Prayag scheme requires a human to read it — it is not computed here.
        Do not compute a winner; show both and let a person read it.
      </p>
      {rows.map((r) => (
        <div key={r.schemeType}
          className={`rounded border bg-card p-3 space-y-1 ${isIndicative(r.n) ? "opacity-70" : ""}`}>
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-sm">{SCHEME_TYPE_LABELS[r.schemeType] ?? r.schemeType}</span>
            <span className="text-xs text-muted-foreground">
              <NTag n={r.n} />
              {isIndicative(r.n) && <IndicativeBadge />}
            </span>
          </div>
          {r.valuesSeen.length > 0 ? (
            <ul className="space-y-0.5 pl-2">
              {r.valuesSeen.map((v, i) => (
                <li key={i} className="text-xs text-muted-foreground list-disc list-inside">{v}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground italic">No specific values recorded.</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Panel 6 — Delivery speed ──────────────────────────────────────────────

function Panel6() {
  const q = useQuery<{ rows: DeliveryCompRow[] }>({
    queryKey: ["ms-delivery-comparison"],
    queryFn: () => fetch(API("market-survey/delivery-comparison")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load delivery data.</p>;
  const rows = q.data.rows;
  if (rows.length === 0) return (
    <EmptyState msg="No delivery speed data recorded yet. Fill in delivery days when submitting a survey." />
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Two days against seven is a logistics answer, not a pricing one — and the cheapest gap to close.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="pb-1.5 pr-3 text-left font-medium">State</th>
              <th className="pb-1.5 pr-3 text-right font-medium">Competitor median</th>
              <th className="pb-1.5 pr-3 text-right font-medium">Comp. range</th>
              <th className="pb-1.5 pr-3 text-right font-medium">Prayag median</th>
              <th className="pb-1.5 pr-3 text-right font-medium">Prayag range</th>
              <th className="pb-1.5 text-right font-medium">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.state}
                className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
                <td className="py-1.5 pr-3">
                  {r.state}
                  {isIndicative(r.n) && <IndicativeBadge />}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums font-medium">
                  {r.medianCompetitorDays != null ? `${r.medianCompetitorDays} d` : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                  {r.minCompetitor != null && r.maxCompetitor != null
                    ? `${r.minCompetitor}–${r.maxCompetitor} d` : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.medianPrayagDays != null ? `${r.medianPrayagDays} d` : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                  {r.minPrayag != null && r.maxPrayag != null
                    ? `${r.minPrayag}–${r.maxPrayag} d` : "—"}
                </td>
                <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Panel 7 — Sized opportunity ───────────────────────────────────────────

function Panel7() {
  const q = useQuery<{ rows: SizedOppRow[]; assumption: string }>({
    queryKey: ["ms-sized-opportunity"],
    queryFn: () => fetch(API("market-survey/sized-opportunity")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load opportunity data.</p>;
  const rows = q.data.rows;
  if (rows.length === 0) return (
    <EmptyState msg="No data yet. Record shelf share and monthly volume in a survey to size the opportunity." />
  );

  return (
    <div className="space-y-3">
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <strong>Assumption on this panel:</strong> {q.data.assumption}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="pb-1.5 pr-3 text-left font-medium">Segment</th>
              <th className="pb-1.5 pr-3 text-left font-medium">State</th>
              <th className="pb-1.5 pr-3 text-right font-medium">Est. monthly to competitors</th>
              <th className="pb-1.5 text-right font-medium">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.segment}|${r.state}`}
                className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
                <td className="py-1.5 pr-3">{r.segment}</td>
                <td className="py-1.5 pr-3">{r.state}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums font-medium">
                  {r.estimatedMonthlyToCompetitor != null ? fmt(r.estimatedMonthlyToCompetitor) : "—"}
                  {isIndicative(r.n) && <IndicativeBadge />}
                </td>
                <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Panel 8 — Coverage gaps ───────────────────────────────────────────────

function Panel8() {
  const q = useQuery<{ rows: CoverageRow[] }>({
    queryKey: ["ms-coverage"],
    queryFn: () => fetch(API("market-survey/coverage")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load coverage data.</p>;

  const thin = (q.data.rows ?? []).filter((r) => isIndicative(r.n));
  if (thin.length === 0) return (
    <p className="text-sm text-muted-foreground">
      All tracked segments have n ≥ {N_ADEQUATE} surveys. No coverage gaps.
    </p>
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-3">
        Segments with fewer than {N_ADEQUATE} surveys. Figures from these segments should not drive decisions.
      </p>
      <div className="flex flex-wrap gap-2">
        {thin.map((r) => (
          <div key={r.segment}
            className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
            <p className="font-medium text-amber-900">{r.segment}</p>
            <p className="text-amber-700"><NTag n={r.n} /> — needs {N_ADEQUATE - r.n} more</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Panel 9 — New SKU opportunity ─────────────────────────────────────────

function Panel9() {
  const q = useQuery<{ rows: NewSkuRow[] }>({
    queryKey: ["ms-new-sku-opportunity"],
    queryFn: () => fetch(API("market-survey/new-sku-opportunity")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load new SKU data.</p>;

  const rows = q.data.rows;
  if (rows.length === 0) return <EmptyState msg="No 'new SKU' surveys recorded yet." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">Code</th>
            <th className="pb-1.5 pr-3 font-medium">Segment</th>
            <th className="pb-1.5 pr-3 font-medium">Item</th>
            <th className="pb-1.5 pr-3 font-medium text-right">Our MRP</th>
            <th className="pb-1.5 pr-3 font-medium">Retailers requesting it</th>
            <th className="pb-1.5 pr-3 font-medium">Competitors seen</th>
            <th className="pb-1.5 font-medium text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.prayagItemCode}|${r.segment}`}
              className={`border-b last:border-0 ${isIndicative(r.n) ? "text-muted-foreground" : ""}`}>
              <td className="py-1.5 pr-3 font-mono">{r.prayagItemCode}</td>
              <td className="py-1.5 pr-3">{r.segment}</td>
              <td className="py-1.5 pr-3 max-w-[160px] truncate" title={r.itemName ?? ""}>
                {r.itemName ?? <span className="italic">unknown</span>}
                {isIndicative(r.n) && <IndicativeBadge />}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(r.currentMrp)}</td>
              <td className="py-1.5 pr-3">
                {r.retailers.length === 0
                  ? <span className="italic text-muted-foreground">—</span>
                  : r.retailers.join(", ")}
              </td>
              <td className="py-1.5 pr-3 text-muted-foreground">{r.brands.join(", ")}</td>
              <td className="py-1.5 text-right text-muted-foreground">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Panel 10 — Competition-app comparison ─────────────────────────────────

function Panel10() {
  const q = useQuery<{ rows: VsCompRow[] }>({
    queryKey: ["ms-vs-competition"],
    queryFn: () => fetch(API("market-survey/vs-competition")).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-destructive">Failed to load competition comparison.</p>;

  const rows = q.data.rows;
  if (rows.length === 0) return (
    <EmptyState msg="No codes match between survey data and the competition price database yet." />
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        DERIVED prices are calculated from the competitor's MRP minus assumed trade discount, not directly observed.
        Survey net prices are field-observed. These are not equivalent and must not be presented as such.
      </p>
      {rows.map((r) => (
        <div key={`${r.prayagItemCode}|${r.segment}`} className="rounded border bg-card p-3 space-y-2">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 items-baseline">
            <span className="font-medium text-sm font-mono">{r.prayagItemCode}</span>
            <span className="text-xs rounded bg-muted px-1.5 py-0.5">{r.segment}</span>
            {r.itemName && <span className="text-xs text-muted-foreground">{r.itemName}</span>}
            {r.currentMrp != null && (
              <span className="text-xs text-muted-foreground">Our MRP: {fmt(r.currentMrp)}</span>
            )}
            <span className="text-xs text-muted-foreground">
              Survey median: {fmt(r.surveyMedian)} <NTag n={r.surveyN} />
              {isIndicative(r.surveyN) && <IndicativeBadge />}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-1 pr-3 text-left font-medium">Competitor</th>
                  <th className="pb-1 pr-3 text-left font-medium">Code</th>
                  <th className="pb-1 pr-3 text-right font-medium">Competitor MRP</th>
                  <th className="pb-1 pr-3 text-right font-medium">Net (DERIVED)</th>
                  <th className="pb-1 text-right font-medium">Discount%</th>
                </tr>
              </thead>
              <tbody>
                {r.competitorRows.map((c, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1 pr-3 font-medium">{c.brand}</td>
                    <td className="py-1 pr-3 font-mono text-muted-foreground">{c.code}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{fmt(c.mrp)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {fmt(c.netDerived)}
                      <span className="ml-1 text-[9px] rounded bg-sky-100 text-sky-700 px-1 py-0.5 font-semibold">DERIVED</span>
                    </td>
                    <td className="py-1 text-right text-muted-foreground">
                      {c.discountAssumed != null ? `${c.discountAssumed}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

export default function AnalyticsTab() {
  return (
    <div className="space-y-8">
      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="1. Per-item prices"
          subtitle="Competitor net prices observed per Prayag item code. Sorted by gap% (n ≥ 5 first)." />
        <Panel1 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="2. By competitor brand"
          subtitle="Aggregate view of each competitor across all surveyed codes — what brands are met in the field." />
        <Panel2 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="3. Why retailers buy elsewhere"
          subtitle="Reason counts, overall and by segment. Credit outranking price points to a different solution than pricing does." />
        <Panel3 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="4. Credit comparison"
          subtitle="Median credit days — competitor vs Prayag — by state and segment, with n. Plus who extends the competitor credit." />
        <Panel4 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="5. Scheme comparison"
          subtitle="Competitor scheme values recorded, grouped by type. Show both; let a person read it — do not compute a winner." />
        <Panel5 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="6. Delivery speed"
          subtitle="Distribution of competitor delivery days against ours, by state. Median and range." />
        <Panel6 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="7. Sized opportunity"
          subtitle="Estimated monthly value going to competitors, by segment and state, from shelf share × net price × monthly volume." />
        <Panel7 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="8. Coverage gaps"
          subtitle={`Segments and states below n=${N_ADEQUATE} — named, so a salesperson knows where to go next.`} />
        <Panel8 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="9. New SKU opportunity"
          subtitle="Prayag codes being bought from a competitor by customers who already buy from us — a push list from field evidence." />
        <Panel9 />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <SectionHeading
          title="10. Competitor price vs ours, where both exist"
          subtitle="DERIVED = MRP less an assumed 40%, not observed. Survey figure is observed. Never present them as equivalent." />
        <Panel10 />
      </div>
    </div>
  );
}
