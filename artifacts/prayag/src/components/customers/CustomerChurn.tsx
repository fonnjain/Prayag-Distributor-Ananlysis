import { trunc2 } from "@/lib/trunc";
// Customer At-Risk & New — three-tab view.
//
// Scheme Risk: like-months LY vs CY comparison for every customer who bought
//   last year. Sorted by revenue at risk (LY value descending for at-risk).
//   Zero-buyers are the most urgent group — no order at all this year yet.
//
// Inactive Risk: gap-ratio scoring vs each customer's own historical
//   median inter-order cycle. Seasonal buyers are never mislabelled.
//
// New: appeared in CY period but had no orders in the corresponding LY period.
import { useState, useEffect } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtVal } from "./formatters";

// ── Types ─────────────────────────────────────────────────────────────────────

type AtRiskRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  medianGap: number;
  daysSinceLast: number;
  lastOrderDate: string | null;
  gapRatio: number;
  riskLevel: "high" | "mild";
};

type NewRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  lastOrderDate: string | null;
  qtyLy: number;
  valLy: number;
  monthsOrdered: number;
};

type SchemeRiskRow = {
  customer: string;
  cyVal: number;
  lyVal: number;
  growthPct: number | null;
  isZeroBuyer: boolean;
  status: "on_track" | "at_risk" | "zero";
};

type SchemeRiskSummary = {
  total: number;
  onTrack: number;
  atRisk: number;
  zeroBuyers: number;
  atRiskRevenue: number;
  zeroBuyerRevenue: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTITY_LABELS: Record<string, string> = {
  distributor: "Distributor",
  direct_dealer: "Dealer",
  retailer: "Retailer",
  unknown: "—",
};

function GrowthCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground">—</span>;
  const cls =
    pct >= 0
      ? "text-green-600 dark:text-green-400"
      : pct >= -20
      ? "text-amber-700 dark:text-amber-400"
      : "text-red-600 dark:text-red-400";
  return (
    <span className={`tabular-nums font-mono text-sm ${cls}`}>
      {pct >= 0 ? "+" : ""}
      {trunc2(pct)}%
    </span>
  );
}

// ── Scheme Risk tab ────────────────────────────────────────────────────────────

function SchemeRiskPanel({
  rows,
  summary,
  loading,
  fyCy,
  fyLy,
  monthsCy,
  monthsLy,
}: {
  rows: SchemeRiskRow[];
  summary: SchemeRiskSummary | null;
  loading: boolean;
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
}) {
  const [filter, setFilter] = useState<"all" | "at_risk" | "zero" | "on_track">("all");

  const visible = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "zero") return r.isZeroBuyer;
    if (filter === "at_risk") return r.status === "at_risk";
    if (filter === "on_track") return r.status === "on_track";
    return true;
  });

  const periodLabel =
    monthsCy.length === 0
      ? ""
      : monthsCy.length === 1
      ? monthsCy[0]
      : `${monthsCy[0]}–${monthsCy[monthsCy.length - 1]}`;

  const lyPeriodLabel =
    monthsLy.length === 0
      ? ""
      : monthsLy.length === 1
      ? monthsLy[0]
      : `${monthsLy[0]}–${monthsLy[monthsLy.length - 1]}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-sm">
        {[
          { label: "Total LY traders", value: summary.total, sub: null },
          {
            label: "On track",
            value: summary.onTrack,
            sub: `${summary.total > 0 ? trunc2(((summary.onTrack / summary.total) * 100)) : 0}%`,
            cls: "text-green-600 dark:text-green-400",
          },
          {
            label: "At risk",
            value: summary.atRisk,
            sub: `${summary.total > 0 ? trunc2(((summary.atRisk / summary.total) * 100)) : 0}%`,
            cls: "text-amber-700 dark:text-amber-400",
          },
          {
            label: "Zero buyers",
            value: summary.zeroBuyers,
            sub: "no order yet",
            cls: "text-red-600 dark:text-red-400",
          },
          {
            label: "Revenue at risk",
            value: fmtVal(summary.atRiskRevenue),
            sub: `LY ${lyPeriodLabel}`,
            cls: "text-amber-700 dark:text-amber-400",
          },
          {
            label: "Zero-buyer revenue",
            value: fmtVal(summary.zeroBuyerRevenue),
            sub: `LY ${lyPeriodLabel}`,
            cls: "text-red-600 dark:text-red-400",
          },
        ].map((t) => (
          <div key={t.label} className="rounded border bg-card p-3">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className={`text-base font-semibold tabular-nums mt-0.5 ${t.cls ?? ""}`}>
              {typeof t.value === "number" ? t.value : t.value}
            </p>
            {t.sub && <p className="text-xs text-muted-foreground mt-0.5">{t.sub}</p>}
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Comparing {periodLabel} ({fyCy}) vs {lyPeriodLabel} ({fyLy}) for every
        customer who bought in {fyLy}. Sorted by revenue at risk (largest LY
        value first among under-performers). Zero-buyers have placed no order
        this year — highest urgency.
      </p>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {(
          [
            { key: "all", label: `All (${summary.total})` },
            { key: "zero", label: `Zero buyers (${summary.zeroBuyers})` },
            { key: "at_risk", label: `At risk (${summary.atRisk})` },
            { key: "on_track", label: `On track (${summary.onTrack})` },
          ] as { key: typeof filter; label: string }[]
        ).map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          No customers in this group.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">LY {lyPeriodLabel}</TableHead>
                <TableHead className="text-right">CY {periodLabel}</TableHead>
                <TableHead className="text-right">Growth</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow
                  key={row.customer}
                  className={row.isZeroBuyer ? "bg-red-50/40 dark:bg-red-950/10" : ""}
                >
                  <TableCell className="font-medium max-w-[220px] truncate">
                    {row.customer}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {fmtVal(row.lyVal)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.cyVal > 0 ? fmtVal(row.cyVal) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <GrowthCell pct={row.growthPct} />
                  </TableCell>
                  <TableCell className="text-right">
                    {row.isZeroBuyer ? (
                      <Badge className="bg-red-100 text-red-700 border border-red-300 dark:bg-red-950 dark:text-red-300 text-xs font-normal">
                        Zero
                      </Badge>
                    ) : row.status === "at_risk" ? (
                      <Badge className="bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 text-xs font-normal">
                        At risk
                      </Badge>
                    ) : (
                      <Badge className="bg-green-100 text-green-700 border border-green-300 dark:bg-green-950 dark:text-green-300 text-xs font-normal">
                        On track
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Inactive Risk tab ──────────────────────────────────────────────────────────

function AtRiskTable({ rows }: { rows: AtRiskRow[] }) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No at-risk customers found for this filter.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Risk</TableHead>
            <TableHead className="text-right">Normal gap</TableHead>
            <TableHead className="text-right">Days silent</TableHead>
            <TableHead className="text-right">Gap ratio</TableHead>
            <TableHead className="text-right">Last order</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.customer}>
              <TableCell className="font-medium max-w-[220px] truncate">
                {row.customer}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs font-normal">
                  {ENTITY_LABELS[row.entityType] ?? row.entityType}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Badge
                  className={
                    row.riskLevel === "high"
                      ? "bg-red-100 text-red-700 border border-red-300 dark:bg-red-950 dark:text-red-300 text-xs font-normal"
                      : "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 text-xs font-normal"
                  }
                >
                  {row.riskLevel === "high" ? "High" : "Mild"}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">
                {row.medianGap}d
              </TableCell>
              <TableCell
                className={`text-right font-mono text-sm font-semibold ${
                  row.riskLevel === "high"
                    ? "text-red-600 dark:text-red-400"
                    : "text-amber-700 dark:text-amber-400"
                }`}
              >
                {row.daysSinceLast}d
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">
                {trunc2(row.gapRatio)}×
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {row.lastOrderDate ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── New customers tab ──────────────────────────────────────────────────────────

function NewTable({ rows, fyCy }: { rows: NewRow[]; fyCy: string }) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        None found for this period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Last order</TableHead>
            <TableHead className="text-right">Value {fyCy}</TableHead>
            <TableHead className="text-right">Months active</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.customer}>
              <TableCell className="font-medium max-w-[220px] truncate">
                {row.customer}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs font-normal">
                  {ENTITY_LABELS[row.entityType] ?? row.entityType}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {row.lastOrderDate ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {fmtVal(row.valLy)}
              </TableCell>
              <TableCell className="text-right text-sm">
                {row.monthsOrdered}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CustomerAtRisk({
  fyCy,
  fyLy,
  monthsCy,
  monthsLy,
  entityType,
}: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType: string;
}) {
  const [atRisk, setAtRisk] = useState<AtRiskRow[]>([]);
  const [newCust, setNewCust] = useState<NewRow[]>([]);
  const [schemeRows, setSchemeRows] = useState<SchemeRiskRow[]>([]);
  const [schemeSummary, setSchemeSummary] = useState<SchemeRiskSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [schemeLoading, setSchemeLoading] = useState(false);
  const [tab, setTab] = useState<"scheme" | "atRisk" | "new">("scheme");

  const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

  // Inactive + new customers
  useEffect(() => {
    if (!monthsCy.length) return;
    setLoading(true);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      entityType,
    });
    fetch(`${BASE}/api/customers/churn?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setAtRisk(d.atRisk ?? []);
        setNewCust(d.newCustomers ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), entityType]);

  // Scheme risk
  useEffect(() => {
    if (!monthsCy.length || !monthsLy.length) return;
    setSchemeLoading(true);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
    });
    fetch(`${BASE}/api/customers/distributor-risk?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setSchemeRows(d.rows ?? []);
        setSchemeSummary(d.summary ?? null);
      })
      .catch(() => {})
      .finally(() => setSchemeLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(",")]);

  const highCount = atRisk.filter((r) => r.riskLevel === "high").length;
  const mildCount = atRisk.filter((r) => r.riskLevel === "mild").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 flex-wrap">
        <Button
          variant={tab === "scheme" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("scheme")}
        >
          Scheme Risk{schemeSummary ? ` (${schemeSummary.atRisk + schemeSummary.zeroBuyers})` : ""}
        </Button>
        <Button
          variant={tab === "atRisk" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("atRisk")}
        >
          Inactive Risk ({atRisk.length})
        </Button>
        <Button
          variant={tab === "new" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("new")}
        >
          New ({newCust.length})
        </Button>
      </div>

      {tab === "scheme" && (
        <SchemeRiskPanel
          rows={schemeRows}
          summary={schemeSummary}
          loading={schemeLoading}
          fyCy={fyCy}
          fyLy={fyLy}
          monthsCy={monthsCy}
          monthsLy={monthsLy}
        />
      )}

      {tab === "atRisk" && (
        <>
          {atRisk.length > 0 && (
            <div className="flex gap-3 text-xs text-muted-foreground">
              {highCount > 0 && (
                <span className="text-red-600 dark:text-red-400 font-medium">
                  {highCount} high risk (&gt;2× gap)
                </span>
              )}
              {mildCount > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {mildCount} mild risk (1.2–2× gap)
                </span>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Customers scored against their own historical median inter-order gap.
            Seasonal buyers and new customers are excluded automatically —
            only those silent beyond their own normal cycle appear here.
            Gap ratio = days silent / normal gap; high risk means &gt;2×.
          </p>
          {loading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : (
            <AtRiskTable rows={atRisk} />
          )}
        </>
      )}

      {tab === "new" && (
        <>
          <p className="text-xs text-muted-foreground">
            Customers who ordered in {fyCy} but had no orders in the
            corresponding {fyLy} period. Comparing{" "}
            {monthsCy.length > 0
              ? `${monthsCy[0]}–${monthsCy[monthsCy.length - 1]}`
              : "selected period"}{" "}
            vs same months in {fyLy}.
          </p>
          {loading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : (
            <NewTable rows={newCust} fyCy={fyCy} />
          )}
        </>
      )}
    </div>
  );
}
