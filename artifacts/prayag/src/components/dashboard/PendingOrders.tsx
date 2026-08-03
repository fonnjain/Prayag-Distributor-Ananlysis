import { trunc2 } from "@/lib/trunc";
// Factory pending order book — quantity view.
// Source: REPORT 2 tab of the internal pending sheet.
// All figures are in UNITS (pieces). Water tanks are in PIECES in this sheet,
// not litres — do not apply the litre conversion used in the sale register.
// The derived pending (Order Booking minus Sale) is shown in value (₹) as a
// cross-check; the two measures are independent and in different units.
import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";

// ── Types ──────────────────────────────────────────────────────────────────────

type PendingParty = {
  party: string;
  total: number;
  byGroup: Record<string, number>;
};

type PendingHead = {
  head: string;
  total: number;
  parties: PendingParty[];
};

type DerivedPending = {
  ob: number | null;
  sale: number | null;
  pending: number | null;
  obError: string | null;
  saleError: string | null;
};

type PendingOrdersData = {
  groups: string[];
  grandTotal: number;
  byHead: PendingHead[];
  derived: DerivedPending;
  computedAt: string;
  error: string | null;
};

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtQty(n: number): string {
  return n.toLocaleString("en-IN");
}

function fmtCr(n: number): string {
  return "\u20b9" + trunc2((n / 1e7)) + " Cr";
}

// ── Collapsible head section ──────────────────────────────────────────────────

function HeadSection({
  head,
  groups,
  defaultOpen,
}: {
  head: PendingHead;
  groups: string[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Only show groups that have at least one non-zero value across parties.
  const activeGroups = groups.filter((g) =>
    head.parties.some((p) => (p.byGroup[g] ?? 0) > 0),
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium text-sm truncate">{head.head}</span>
          <span className="text-xs text-muted-foreground">
            {head.parties.length} {head.parties.length === 1 ? "party" : "parties"}
          </span>
        </div>
        <span className="text-sm font-semibold tabular-nums ml-4 shrink-0">
          {fmtQty(head.total)} pcs
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-64 min-w-48">
                  Party
                </th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground w-24 shrink-0">
                  Total (pcs)
                </th>
                {activeGroups.map((g) => (
                  <th
                    key={g}
                    className="text-right px-2 py-2 font-medium text-muted-foreground whitespace-nowrap"
                  >
                    {g}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {head.parties.map((p, i) => (
                <tr
                  key={i}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    i % 2 === 0 ? "bg-background" : "bg-muted/10",
                  )}
                >
                  <td className="px-3 py-1.5 text-foreground font-normal truncate max-w-xs">
                    {p.party}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                    {fmtQty(p.total)}
                  </td>
                  {activeGroups.map((g) => (
                    <td
                      key={g}
                      className="px-2 py-1.5 text-right tabular-nums text-muted-foreground"
                    >
                      {(p.byGroup[g] ?? 0) > 0 ? fmtQty(p.byGroup[g]) : ""}
                    </td>
                  ))}
                </tr>
              ))}
              {/* Head subtotal */}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="px-3 py-2 text-sm">Total — {head.head}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums">
                  {fmtQty(head.total)}
                </td>
                {activeGroups.map((g) => {
                  const sum = head.parties.reduce(
                    (acc, p) => acc + (p.byGroup[g] ?? 0),
                    0,
                  );
                  return (
                    <td key={g} className="px-2 py-2 text-right tabular-nums text-sm">
                      {sum > 0 ? fmtQty(sum) : ""}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PendingOrders() {
  const [data, setData] = useState<PendingOrdersData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // True while Google Sheets is briefly rate-limiting reads (503 quota);
  // a retry is scheduled automatically after the server's retryAfter hint.
  const [quotaWait, setQuotaWait] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setFetchError(null);
    setQuotaWait(false);
    fetch("/api/mgmt/pending-orders")
      .then(async (r) => {
        const q = await quotaOrThrow(r);
        if (q) {
          if (!cancelled) {
            setQuotaWait(true);
            retryTimer = setTimeout(
              () => setRetryTick((t) => t + 1),
              quotaDelayMs(q.retryAfter),
            );
          }
          return null;
        }
        return r.json() as Promise<PendingOrdersData>;
      })
      .then((d) => {
        if (!cancelled && d !== null) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [retryTick]);

  if (quotaWait) {
    return (
      <div className="p-6">
        <QuotaWaitBanner testId="banner-quota-wait-pending" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Loading pending order book...
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="p-6 text-center text-sm text-destructive">
        Could not load data: {fetchError}
      </div>
    );
  }

  if (!data) return null;

  const d = data.derived;

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">Pending Order Book</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Factory pending sheet — balance quantity by state head and party. All figures
          are in units (pieces). Water tanks are in pieces in this source, not litres.
        </p>
      </div>

      {/* Sheet error */}
      {data.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Could not read factory pending sheet: {data.error}</span>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">Balance Qty</div>
          <div className="text-xl font-bold tabular-nums">
            {fmtQty(data.grandTotal)}
          </div>
          <div className="text-xs text-muted-foreground">pieces</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">Parties</div>
          <div className="text-xl font-bold tabular-nums">
            {fmtQty(data.byHead.reduce((a, h) => a + h.parties.length, 0))}
          </div>
          <div className="text-xs text-muted-foreground">unique</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">State Heads</div>
          <div className="text-xl font-bold tabular-nums">
            {data.byHead.length}
          </div>
          <div className="text-xs text-muted-foreground">with pending orders</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">Product Groups</div>
          <div className="text-xl font-bold tabular-nums">
            {data.groups.length}
          </div>
          <div className="text-xs text-muted-foreground">with balance</div>
        </div>
      </div>

      {/* Cross-check panel */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">
            Cross-check: Derived pending vs factory pending
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Order Booking (OB)</span>
            <span className="font-semibold tabular-nums">
              {d.ob != null ? fmtCr(d.ob) : "—"}
            </span>
            {d.obError && (
              <span className="text-xs text-destructive">{d.obError}</span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Primary Sale (dispatched)</span>
            <span className="font-semibold tabular-nums">
              {d.sale != null ? fmtCr(d.sale) : "—"}
            </span>
            {d.saleError && (
              <span className="text-xs text-destructive">{d.saleError}</span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Derived Pending (OB minus Sale)</span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                d.pending != null && d.pending < 0 ? "text-destructive" : "",
              )}
            >
              {d.pending != null ? fmtCr(d.pending) : "—"}
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
          The derived pending (₹ value, from OB minus Sale sheets) and the factory
          pending (unit quantity, from the internal pending sheet) are independent
          measures of the same outstanding order balance. They are in different
          units and cannot be added or directly compared, but they should point to
          the same order of magnitude. A large divergence in direction (e.g. derived
          pending is positive but factory pending is zero, or vice versa) would
          indicate a data integrity issue worth investigating.
        </p>
      </div>

      {/* Per-head sections */}
      {data.byHead.length === 0 && !data.error && (
        <div className="text-center text-sm text-muted-foreground py-8">
          No pending orders found in factory sheet.
        </div>
      )}
      <div className="flex flex-col gap-2">
        {data.byHead
          .slice()
          .sort((a, b) => b.total - a.total)
          .map((h, i) => (
            <HeadSection
              key={h.head}
              head={h}
              groups={data.groups}
              defaultOpen={i === 0}
            />
          ))}
      </div>

      {data.computedAt && (
        <p className="text-xs text-muted-foreground text-center">
          Data from factory pending sheet, read at{" "}
          {new Date(data.computedAt).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      )}
    </div>
  );
}
