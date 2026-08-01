// SKU Deep Dive — Discounts section (K4).
//
// GET /api/sku/discounts?fy=YYYY-YY[&channel][&monthFrom&monthTo]
//
// CRITICAL RULE: the two discount measures must NEVER share a column/table.
//   • primary  = "Discount off MRP" (distributor pays vs list)
//   • secondary = "Register discount" (retailer level)
// They are rendered as two clearly separated sections, each showing its own
// measureLabel.  Emphasis is on VARIANCE: widestGaps first, then per-code.
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types (mirror backend skuDiscounts.ts) ─────────────────────────────────────

export type DiscountCodeRow = {
  code: string;
  segment: string;
  customers: number;
  net: number;
  avgDiscount: number; // 0-1
  minDiscount: number; // 0-1
  maxDiscount: number; // 0-1
  spread: number;      // 0-1
  lowCustomer: string;
  highCustomer: string;
};

export type PrimaryDiscount = {
  measureLabel: string;
  fy: string;
  channel: string;
  codes: DiscountCodeRow[];
  widestGaps: DiscountCodeRow[];
  mrpCoverage: { rowsWithMrp: number; rowsTotal: number };
  projectExclusion: { basis: string; bridgedCustomers: number; note: string };
};

export type SecondaryVerification = {
  sampled: boolean;
  lineUid?: string;
  gross?: number;
  discountAmount?: number;
  net?: number;
  holds?: boolean;
  note: string;
};

export type SecondaryDiscount = {
  measureLabel: string;
  fy: string;
  available: boolean;
  reason?: string;
  codes: DiscountCodeRow[];
  widestGaps: DiscountCodeRow[];
  verification: SecondaryVerification;
};

export type DiscountsResult = {
  fy: string;
  channel: string;
  primary: PrimaryDiscount;
  secondary: SecondaryDiscount;
  blocked: {
    marginPerCode: { blocked: boolean; reason: string };
    liveYearRetailer: { blocked: boolean; reason: string };
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtNet(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${cr.toFixed(2)} Cr`;
  const l = n / 1e5;
  if (l >= 1) return `₹${l.toFixed(1)} L`;
  return `₹${Math.round(n / 1000)}k`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pts(v: number): string {
  return `${(v * 100).toFixed(1)} pts`;
}

// Colour the spread by how wide it is (variance emphasis).
function spreadColour(spread: number): string {
  if (spread >= 0.15) return "text-red-600 dark:text-red-400";
  if (spread >= 0.08) return "text-orange-600 dark:text-orange-400";
  if (spread >= 0.04) return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  fy: string;
  channel?: "territory" | "project";
  monthFrom?: number;
  monthTo?: number;
  periodLabel: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SkuDiscounts({ fy, channel, monthFrom, monthTo, periodLabel }: Props) {
  const [data, setData] = useState<DiscountsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ fy });
    if (channel) params.set("channel", channel);
    if (monthFrom != null) params.set("monthFrom", String(monthFrom));
    if (monthTo != null) params.set("monthTo", String(monthTo));
    fetch(`${BASE}/api/sku/discounts?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DiscountsResult>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [fy, channel, monthFrom, monthTo]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 rounded-lg border bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        Failed to load discounts: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No discount data for the selected period.
      </p>
    );
  }

  const { primary, secondary, blocked } = data;

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-muted-foreground">
          FY {data.fy} · {data.channel === "project" ? "Project / Govt" : "Territory"} · {periodLabel}
        </span>
      </div>

      {/* ── Blocked measures notice ────────────────────────────────────────── */}
      {blocked.marginPerCode.blocked && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-4 py-3 flex gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-300">
              Blocked · "Margin per code" is not computable
            </p>
            <p className="text-amber-700 dark:text-amber-400 mt-0.5">
              {blocked.marginPerCode.reason}
            </p>
          </div>
        </div>
      )}

      {/* ── PRIMARY: Discount off MRP (distributor) ────────────────────────── */}
      <section className="rounded-lg border bg-card">
        <div className="px-4 pt-3 pb-2 border-b">
          <h3 className="text-sm font-semibold">Discount off MRP</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-medium text-foreground">Primary</span> · {primary.measureLabel}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 text-xs text-muted-foreground">
            <span>
              MRP coverage:{" "}
              <span className="font-medium text-foreground tabular-nums">
                {primary.mrpCoverage.rowsWithMrp.toLocaleString()}
              </span>{" "}
              / {primary.mrpCoverage.rowsTotal.toLocaleString()} rows
            </span>
            <span title={primary.projectExclusion.note}>
              {primary.projectExclusion.basis}
              {primary.projectExclusion.bridgedCustomers > 0 &&
                ` · ${primary.projectExclusion.bridgedCustomers} bridged`}
            </span>
          </div>
        </div>

        {/* Widest gaps first — variance emphasis */}
        <VarianceBlock
          title="Widest gaps"
          subtitle="codes where distributors pay wildly different discounts off list"
          rows={primary.widestGaps}
          emptyLabel="No wide-gap codes."
        />

        {/* Per-code table */}
        <CodeBlock
          title="All codes by net"
          rows={primary.codes}
          emptyLabel="No codes with MRP coverage."
        />
      </section>

      {/* ── SECONDARY: Register discount (retailer) ────────────────────────── */}
      <section className="rounded-lg border bg-card">
        <div className="px-4 pt-3 pb-2 border-b">
          <h3 className="text-sm font-semibold">Register discount</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-medium text-foreground">Secondary</span> · {secondary.measureLabel}
          </p>
        </div>

        {!secondary.available ? (
          <div className="px-4 py-3">
            <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 flex gap-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {secondary.reason ?? "Register discount is not available for this period."}
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Verification strip */}
            {secondary.verification.sampled && (
              <div className="px-4 pt-2 pb-1">
                <div
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs",
                    secondary.verification.holds
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : "border-amber-400/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
                  )}
                  title={secondary.verification.note}
                >
                  <span className="font-medium">
                    {secondary.verification.holds ? "Verified" : "Check"}
                  </span>
                  {secondary.verification.lineUid && (
                    <span className="ml-2 font-mono">{secondary.verification.lineUid}</span>
                  )}
                  {secondary.verification.gross != null && (
                    <span className="ml-2 tabular-nums">
                      gross {fmtNet(secondary.verification.gross)}
                    </span>
                  )}
                  {secondary.verification.discountAmount != null && (
                    <span className="ml-2 tabular-nums">
                      − {fmtNet(secondary.verification.discountAmount)}
                    </span>
                  )}
                  {secondary.verification.net != null && (
                    <span className="ml-2 tabular-nums">
                      = {fmtNet(secondary.verification.net)}
                    </span>
                  )}
                  <span className="ml-2 text-muted-foreground">{secondary.verification.note}</span>
                </div>
              </div>
            )}

            <VarianceBlock
              title="Widest gaps"
              subtitle="retailer-level register discount variance by code"
              rows={secondary.widestGaps}
              customerLabel="retailer"
              emptyLabel="No wide-gap codes."
            />

            <CodeBlock
              title="All codes by net"
              rows={secondary.codes}
              customerLabel="retailer"
              emptyLabel="No register-discount codes."
            />
          </>
        )}
      </section>

      {/* ── Live-year retailer blocked note ────────────────────────────────── */}
      {blocked.liveYearRetailer.blocked && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-4 py-3 flex gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-300">
              Blocked · live-year retailer discount
            </p>
            <p className="text-amber-700 dark:text-amber-400 mt-0.5">
              {blocked.liveYearRetailer.reason}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Variance (widest gaps) block ────────────────────────────────────────────────

function VarianceBlock({
  title,
  subtitle,
  rows,
  customerLabel = "customer",
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  rows: DiscountCodeRow[];
  customerLabel?: string;
  emptyLabel: string;
}) {
  return (
    <div className="border-b last:border-0">
      <div className="px-4 pt-2.5 pb-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        <p className="text-xs text-muted-foreground/80">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground italic">{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="text-xs">
                <TableHead className="py-1.5 pl-4">Code</TableHead>
                <TableHead className="py-1.5 hidden sm:table-cell">Segment</TableHead>
                <TableHead className="py-1.5 text-right">Spread</TableHead>
                <TableHead className="py-1.5">Low {customerLabel}</TableHead>
                <TableHead className="py-1.5">High {customerLabel}</TableHead>
                <TableHead className="py-1.5 text-right pr-4">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="py-1.5 pl-4 font-mono text-xs whitespace-nowrap">
                    {row.code}
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground hidden sm:table-cell max-w-[160px] truncate">
                    {row.segment}
                  </TableCell>
                  <TableCell className="py-1.5 text-right whitespace-nowrap">
                    <span className={cn("font-medium tabular-nums text-xs", spreadColour(row.spread))}>
                      {pts(row.spread)}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-xs">
                    <div className="min-w-0 max-w-[160px] truncate">{row.lowCustomer}</div>
                    <div className="text-muted-foreground tabular-nums">{pct(row.minDiscount)}</div>
                  </TableCell>
                  <TableCell className="py-1.5 text-xs">
                    <div className="min-w-0 max-w-[160px] truncate">{row.highCustomer}</div>
                    <div className="text-muted-foreground tabular-nums">{pct(row.maxDiscount)}</div>
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs whitespace-nowrap pr-4">
                    {fmtNet(row.net)}
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

// ── Per-code block ───────────────────────────────────────────────────────────────

function CodeBlock({
  title,
  rows,
  customerLabel = "customers",
  emptyLabel,
}: {
  title: string;
  rows: DiscountCodeRow[];
  customerLabel?: string;
  emptyLabel: string;
}) {
  return (
    <div className="border-b last:border-0">
      <div className="px-4 pt-2.5 pb-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground italic">{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="text-xs">
                <TableHead className="py-1.5 pl-4">Code</TableHead>
                <TableHead className="py-1.5 hidden sm:table-cell">Segment</TableHead>
                <TableHead className="py-1.5 text-right capitalize">{customerLabel}</TableHead>
                <TableHead className="py-1.5 text-right">Avg disc</TableHead>
                <TableHead className="py-1.5 text-right hidden md:table-cell">Min–Max</TableHead>
                <TableHead className="py-1.5 text-right">Spread</TableHead>
                <TableHead className="py-1.5 text-right pr-4">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="py-1.5 pl-4 font-mono text-xs whitespace-nowrap">
                    {row.code}
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground hidden sm:table-cell max-w-[160px] truncate">
                    {row.segment}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs">
                    {row.customers.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs">
                    {pct(row.avgDiscount)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs text-muted-foreground hidden md:table-cell whitespace-nowrap">
                    {pct(row.minDiscount)} – {pct(row.maxDiscount)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right whitespace-nowrap">
                    <span className={cn("tabular-nums text-xs", spreadColour(row.spread))}>
                      {pts(row.spread)}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs whitespace-nowrap pr-4">
                    {fmtNet(row.net)}
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
