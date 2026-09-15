import { trunc2 } from "@/lib/trunc";
// Factory pending order book — quantity view.
// Source: REPORT 2 tab of the internal pending sheet.
// All figures are in UNITS (pieces). Water tanks are in PIECES in this sheet,
// not litres — do not apply the litre conversion used in the sale register.
// The derived pending (Order Booking minus Sale) is shown in value (₹) as a
// cross-check; the two measures are independent and in different units.
import React, { useState, useEffect, Fragment } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Info, Download } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ReconciliationCheck = {
  parent: number;
  children: number;
  difference: number;
  exact: boolean;
};

export type PendingAttributionCandidate = {
  personId: number;
  member: string;
  stateHead: string | null;
  active: boolean;
  left: boolean;
  evidence: string[];
};

export type PendingAttribution = {
  classification: string;
  candidateCount: number;
  candidates: PendingAttributionCandidate[];
  conflictEvidence: string[];
  conflictLink: string | null;
};

export type PendingParty = {
  party: string;
  total: number;
  byGroup: Record<string, number>;
  classification?: string;
  candidateEvidence?: string[];
  attributionLink?: string | null;
  attribution?: PendingAttribution;
  reconciliation?: ReconciliationCheck;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  byGroupAmount?: Record<string, number | null>;
  amountReconciliation?: ReconciliationCheck;
};

export type PendingBucket = {
  bucket: string;
  total: number;
  parties: PendingParty[];
  reconciliation?: ReconciliationCheck;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  amountReconciliation?: ReconciliationCheck;
};

export type PendingHead = {
  head: string;
  total: number;
  parties: PendingParty[];
  buckets?: PendingBucket[];
  coverage?: PendingCoverage;
  reconciliation?: ReconciliationCheck;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  amountReconciliation?: ReconciliationCheck;
};

export type PendingCoverage = {
  candidateCoveragePct: number | null;
  safeCoveragePct: number | null;
  conflictCostPp: number | null;
  candidateQty: number | null;
  safeQty: number | null;
  conflictQty: number | null;
  unassignedQty: number | null;
  disputedQty: number | null;
};

export type PendingReconciliation = {
  company: ReconciliationCheck;
  heads: Array<{ head: string } & ReconciliationCheck>;
  buckets: Array<{ head: string; bucket: string } & ReconciliationCheck>;
  parties: Array<{ head: string; bucket: string; party: string } & ReconciliationCheck>;
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
  attributionAvailable?: boolean;
  coverage?: PendingCoverage;
  reconciliation?: PendingReconciliation;
  attributionError?: string | null;
  computedAt: string;
  error: string | null;
  pricingAvailable?: boolean;
  pricingError?: string | null;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  pricing?: {
    basis: string;
    byGroup: Record<string, {
      averageRealisedRate: number | null;
      amount: number | null;
      unpriceableQty: number;
      unpriceableReason: string | null;
    }>;
  } | null;
  amountReconciliation?: PendingReconciliation | null;
};

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtQty(n: number): string {
  return n.toLocaleString("en-IN");
}

function fmtCr(n: number): string {
  return "\u20b9" + trunc2((n / 1e7)) + " Cr";
}

function fmtAmount(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function AmountCell({
  value,
  unpriceableQty = 0,
  reason,
}: {
  value?: number | null;
  unpriceableQty?: number | null;
  reason?: string | null;
}) {
  if (value == null) {
    return (
      <span
        className="text-muted-foreground/60 bg-muted/50 px-1 rounded"
        title={reason ?? "No usable positive realised rate"}
      >
        —
      </span>
    );
  }
  return <span title={(unpriceableQty ?? 0) > 0 ? `${fmtQty(unpriceableQty ?? 0)} pieces unpriceable` : undefined}>{fmtAmount(value)}</span>;
}

// ── Shared components ──────────────────────────────────────────────────────────

export function ReconText({
  rec,
  measure = "quantity",
}: {
  rec?: ReconciliationCheck | null;
  measure?: "quantity" | "amount";
}) {
  if (!rec) return null;
  const format = measure === "amount" ? fmtAmount : fmtQty;
  if (rec.exact) {
    return (
      <span className="text-[11px] text-muted-foreground font-normal">
        Parent {format(rec.parent)}, Children {format(rec.children)}, Difference {format(0)}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-destructive font-medium flex items-center gap-1">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      Mismatch: Parent {format(rec.parent)}, Children {format(rec.children)}, Difference {format(rec.difference)}
    </span>
  );
}

function BucketGroup({
  bucket,
  activeGroups,
  measure = "quantity",
  stateKey,
  openState,
  onOpenChange,
}: {
  bucket: PendingBucket;
  activeGroups: string[];
  measure?: "quantity" | "amount";
  stateKey?: string;
  openState?: Record<string, boolean>;
  onOpenChange?: (key: string, value: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = stateKey && openState ? openState[stateKey] ?? false : localOpen;
  const isDisputed = bucket.bucket === "Attribution Conflicts";
  const isUnassigned = bucket.bucket === "Unassigned";
  const bucketName = isDisputed ? "Disputed" : isUnassigned ? "Not assigned" : bucket.bucket;

  return (
    <Fragment>
      <tr
        className="bg-muted/10 border-b border-border font-medium cursor-pointer hover:bg-muted/20"
        onClick={() => stateKey && onOpenChange ? onOpenChange(stateKey, !open) : setLocalOpen(!open)}
      >
        <td className="px-3 py-2 text-foreground flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span>{bucketName}</span>
          </div>
          <div className="pl-6">
            <ReconText rec={measure === "amount" ? bucket.amountReconciliation : bucket.reconciliation} measure={measure} />
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-foreground align-top">
          {measure === "amount" ? (
            <AmountCell value={bucket.pricedAmount ?? bucket.amount} unpriceableQty={bucket.unpriceableQty} reason={bucket.unpriceableReason} />
          ) : fmtQty(bucket.total)}
        </td>
        {measure === "amount" && (
          <td className="px-3 py-2 text-right tabular-nums text-amber-700 align-top">
            {bucket.unpriceableQty ? fmtQty(bucket.unpriceableQty) : ""}
          </td>
        )}
        {activeGroups.map(g => {
          const sum = bucket.parties.reduce((acc, p) => acc + (p.byGroup[g] ?? 0), 0);
          const groupAmounts = bucket.parties
            .map((party) => party.byGroupAmount?.[g] ?? null)
            .filter((amount): amount is number => amount != null);
          return (
            <td key={g} className="px-2 py-2 text-right tabular-nums text-muted-foreground align-top">
              {measure === "amount"
                ? <AmountCell value={groupAmounts.length ? groupAmounts.reduce((a, value) => a + value, 0) : null} />
                : sum > 0 ? fmtQty(sum) : ""}
            </td>
          );
        })}
      </tr>

      {open && bucket.parties.map((p, i) => {
        const isLeft = p.classification === "LEFT / departed member";
        const isConflict = p.classification === "Attribution Conflicts" || p.classification === "Multiple Candidates";

        return (
          <tr
            key={p.party + i}
            className="border-b border-border/50 bg-background last:border-0"
          >
            <td className="px-3 py-2 align-top pl-9">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {isConflict && p.attributionLink ? (
                    <Link href={p.attributionLink} className="text-primary hover:underline font-medium break-words">
                      {p.party}
                    </Link>
                  ) : (
                    <span className="text-foreground font-medium break-words">{p.party}</span>
                  )}
                  {isLeft && (
                    <span className="text-[9px] font-semibold bg-muted text-muted-foreground px-1 py-0.5 rounded uppercase tracking-wider">
                      LEFT
                    </span>
                  )}
                </div>
                <ReconText rec={measure === "amount" ? p.amountReconciliation : p.reconciliation} measure={measure} />

                {isConflict && p.candidateEvidence && p.candidateEvidence.length > 0 && (
                  <div className="text-[10px] text-destructive flex flex-col gap-0.5 mt-1">
                    {p.candidateEvidence.map((ev, ei) => (
                      <span key={ei}>- {ev}</span>
                    ))}
                  </div>
                )}
              </div>
            </td>
            <td className="px-3 py-2 text-right font-medium tabular-nums align-top">
              {measure === "amount" ? (
                <AmountCell value={p.pricedAmount ?? p.amount} unpriceableQty={p.unpriceableQty} reason={p.unpriceableReason} />
              ) : fmtQty(p.total)}
            </td>
            {measure === "amount" && (
              <td className="px-3 py-2 text-right tabular-nums text-amber-700 align-top">
                {p.unpriceableQty ? fmtQty(p.unpriceableQty) : ""}
              </td>
            )}
            {activeGroups.map((g) => (
              <td
                key={g}
                className="px-2 py-2 text-right tabular-nums text-muted-foreground align-top"
              >
                {measure === "amount"
                  ? <AmountCell value={p.byGroupAmount?.[g] ?? null} />
                  : (p.byGroup[g] ?? 0) > 0 ? fmtQty(p.byGroup[g]) : ""}
              </td>
            ))}
          </tr>
        );
      })}
    </Fragment>
  );
}

// ── Collapsible head section ──────────────────────────────────────────────────

export function HeadSection({
  head,
  groups,
  defaultOpen,
  measure = "quantity",
  openState,
  onOpenChange,
}: {
  head: PendingHead;
  groups: string[];
  defaultOpen: boolean;
  measure?: "quantity" | "amount";
  openState?: Record<string, boolean>;
  onOpenChange?: (key: string, value: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = openState ? openState[`head:${head.head}`] ?? defaultOpen : localOpen;

  // Compute coverage facts for the head
  const headCandidatePct = head.coverage?.candidateCoveragePct ?? 0;
  const headSafePct = head.coverage?.safeCoveragePct ?? 0;
  const headConflictCost = head.coverage?.conflictCostPp ?? 0;
  const isZeroCoverage = headCandidatePct === 0 && head.total > 0;

  // Only show groups that have at least one non-zero value across parties.
  const activeGroups = groups.filter((g) =>
    head.parties.some((p) => (p.byGroup[g] ?? 0) > 0),
  );

  const buckets = head.buckets || [
    { bucket: "All Parties", total: head.total, parties: head.parties, reconciliation: head.reconciliation }
  ];

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex flex-col sm:flex-row sm:items-start justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-left gap-4"
        onClick={() => onOpenChange ? onOpenChange(`head:${head.head}`, !open) : setLocalOpen((v) => !v)}
      >
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5">
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          </div>
          <div className="flex flex-col">
            <div className="flex flex-col">
              <span className="font-semibold text-base">{head.head}</span>
              <ReconText rec={measure === "amount" ? head.amountReconciliation : head.reconciliation} measure={measure} />
            </div>

            <div className="text-[11.5px] text-muted-foreground mt-2 flex flex-col gap-0.5">
              {isZeroCoverage ? (
                <>
                  <div>0.00% has exactly one assignment candidate; 0.00% safely mapped after conflict holds.</div>
                  <div className="italic mt-0.5 font-medium text-amber-600 dark:text-amber-500">
                    Known attribution gap — pending quantity is retained below, not missing.
                  </div>
                </>
              ) : (
                <>
                  <div>
                    {headCandidatePct.toFixed(2)}% has exactly one assignment candidate; {headSafePct.toFixed(2)}% safely mapped after conflict holds.
                  </div>
                  {headConflictCost > 0 && (
                    <div className="text-destructive font-medium mt-0.5">
                      Conflicts reduce safe coverage by {headConflictCost.toFixed(2)} percentage points.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col text-left sm:text-right pl-6 sm:pl-0 shrink-0">
          <span className="text-base font-bold tabular-nums">
            {measure === "amount" ? (
              <AmountCell value={head.pricedAmount ?? head.amount} unpriceableQty={head.unpriceableQty} reason={head.unpriceableReason} />
            ) : `${fmtQty(head.total)} pcs`}
          </span>
          {measure === "amount" && head.unpriceableQty ? (
            <span className="text-xs text-amber-700">{fmtQty(head.unpriceableQty)} pcs unpriceable</span>
          ) : null}
          <span className="text-xs text-muted-foreground mt-1">
            {head.parties.length} {head.parties.length === 1 ? "party" : "parties"}
          </span>
        </div>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-64 min-w-48 pl-9">
                  Bucket / Party
                </th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground w-24 shrink-0">
                  {measure === "amount" ? "Priced amount (₹)" : "Total (pcs)"}
                </th>
                {measure === "amount" && (
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Unpriceable (pcs)</th>
                )}
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
              {buckets.map((bucket, bIdx) => (
                <BucketGroup
                  key={bucket.bucket + bIdx}
                  bucket={bucket}
                  activeGroups={activeGroups}
                  measure={measure}
                  stateKey={`bucket:${head.head}:${bucket.bucket}`}
                  openState={openState}
                  onOpenChange={onOpenChange}
                />
              ))}

              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="px-3 py-2 text-sm flex flex-col gap-0.5 pl-9">
                  <span>Total — {head.head}</span>
                    <ReconText rec={measure === "amount" ? head.amountReconciliation : head.reconciliation} measure={measure} />
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums align-top">
                  {measure === "amount" ? (
                    <AmountCell value={head.pricedAmount ?? head.amount} unpriceableQty={head.unpriceableQty} reason={head.unpriceableReason} />
                  ) : fmtQty(head.total)}
                </td>
                {measure === "amount" && (
                  <td className="px-3 py-2 text-right text-amber-700">
                    {head.unpriceableQty ? fmtQty(head.unpriceableQty) : ""}
                  </td>
                )}
                {activeGroups.map((g) => {
                  const sum = head.parties.reduce(
                    (acc, p) => acc + (p.byGroup[g] ?? 0),
                    0,
                  );
                  return (
                    <td key={g} className="px-2 py-2 text-right tabular-nums text-sm align-top">
                     {measure === "amount"
                       ? <AmountCell value={(() => {
                           const values = head.parties
                             .map((party) => party.byGroupAmount?.[g] ?? null)
                             .filter((amount): amount is number => amount != null);
                           return values.length ? values.reduce((a, value) => a + value, 0) : null;
                         })()} />
                       : sum > 0 ? fmtQty(sum) : ""}
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

export function SourceOnlyHeadSection({
  head,
  groups,
  measure = "quantity",
}: {
  head: PendingHead;
  groups: string[];
  measure?: "quantity" | "amount";
}) {
  const [open, setOpen] = useState(false);
  const activeGroups = groups.filter((group) =>
    head.parties.some((party) => (party.byGroup[group] ?? 0) > 0),
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start justify-between gap-3 p-3 text-left hover:bg-muted/20"
        onClick={() => setOpen((value) => !value)}
      >
        <div className="flex items-start gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 mt-0.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground" />
          )}
          <div>
            <div className="font-semibold">{head.head}</div>
            <div className="text-xs text-amber-800">
              Attribution unavailable — source parties and quantities only.
            </div>
            <ReconText rec={measure === "amount" ? head.amountReconciliation : head.reconciliation} measure={measure} />
          </div>
        </div>
        <div className="text-right shrink-0">
           <div className="font-bold tabular-nums">
             {measure === "amount" ? <AmountCell value={head.pricedAmount ?? head.amount} unpriceableQty={head.unpriceableQty} reason={head.unpriceableReason} /> : `${fmtQty(head.total)} pcs`}
           </div>
          <div className="text-xs text-muted-foreground">
            {head.parties.length} {head.parties.length === 1 ? "party" : "parties"}
          </div>
        </div>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                  Source party
                </th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                   {measure === "amount" ? "Priced amount (₹)" : "Total (pcs)"}
                </th>
                {measure === "amount" && <th className="text-right px-3 py-2 font-medium text-muted-foreground">Unpriceable (pcs)</th>}
                {activeGroups.map((group) => (
                  <th
                    key={group}
                    className="text-right px-2 py-2 font-medium text-muted-foreground whitespace-nowrap"
                  >
                    {group}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {head.parties.map((party, index) => (
                <tr key={`${party.party}-${index}`} className="border-b border-border/50">
                  <td className="px-3 py-2">
                    <div>{party.party}</div>
                    <ReconText rec={measure === "amount" ? party.amountReconciliation : party.reconciliation} measure={measure} />
                  </td>
                   <td className="px-3 py-2 text-right tabular-nums">
                     {measure === "amount" ? <AmountCell value={party.pricedAmount ?? party.amount} unpriceableQty={party.unpriceableQty} reason={party.unpriceableReason} /> : fmtQty(party.total)}
                   </td>
                   {measure === "amount" && <td className="px-3 py-2 text-right tabular-nums text-amber-700">{party.unpriceableQty ? fmtQty(party.unpriceableQty) : ""}</td>}
                  {activeGroups.map((group) => (
                    <td key={group} className="px-2 py-2 text-right tabular-nums">
                       {measure === "amount"
                         ? <AmountCell value={party.byGroupAmount?.[group] ?? null} />
                         : (party.byGroup[group] ?? 0) > 0 ? fmtQty(party.byGroup[group] ?? 0) : ""}
                    </td>
                  ))}
                </tr>
              ))}
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
  const [measure, setMeasure] = useState<"quantity" | "amount">("quantity");
  // Stable keys mean changing the measure never collapses a head or bucket.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});

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
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Pending Order Book</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Factory pending sheet — balance quantity by state head and party. All figures
            are in units (pieces); quantity is the REPORT 2 source measure. Water tanks
            are pieces, not litres.
          </p>
          {measure === "amount" && data.pricingAvailable === true && (
            <p className="text-sm font-semibold mt-2">
              {data.pricedAmount != null ? fmtCr(data.pricedAmount) : "—"} priced, {fmtQty(data.unpriceableQty ?? 0)} pieces unpriceable
            </p>
          )}
          <div className="mt-3 flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1 w-fit">
            <button
              type="button"
              className={cn("px-3 py-1.5 text-xs font-medium rounded", measure === "quantity" ? "bg-background shadow-sm" : "text-muted-foreground")}
              onClick={() => setMeasure("quantity")}
            >
              Quantity
            </button>
            <button
              type="button"
              className={cn("px-3 py-1.5 text-xs font-medium rounded", measure === "amount" ? "bg-background shadow-sm" : "text-muted-foreground")}
              onClick={() => setMeasure("amount")}
            >
              Amount
            </button>
          </div>
          {measure === "amount" && (
            <div className="text-xs text-muted-foreground mt-2 max-w-3xl leading-relaxed">
              <p className="font-semibold text-foreground">
                Pending value = pending quantity x average realised price per product group, FY2026-27. Estimated worth of outstanding orders, not an invoiced amount. The source carries product groups, not item codes, so this is a group-level estimate.
              </p>
              <p className="mt-1">
                Partial coverage is disclosed: product-group quantities without a usable positive realised rate, and REPORT 2 total-minus-group residuals, remain unpriceable. Water tank pricing is per tank; REPORT 2 water-tank quantities are pieces, with mapped tank denominators resolved from the canonical per-tank litre map.
              </p>
            </div>
          )}
        </div>
        {data.attributionAvailable !== false ? (
          <a
            href="/api/mgmt/pending-orders/export"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors shrink-0"
            download
          >
            <Download className="h-4 w-4" />
            Download Hierarchy
          </a>
        ) : (
          <span className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-muted-foreground text-sm font-medium rounded-md shrink-0">
            <Download className="h-4 w-4" />
            Attribution export unavailable
          </span>
        )}
      </div>

      {/* Sheet error */}
      {data.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Could not read factory pending sheet: {data.error}</span>
        </div>
      )}

      {data.attributionError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Could not apply attribution: {data.attributionError}</span>
        </div>
      )}

      {data.pricingError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Amount unavailable: {data.pricingError}. Source quantities remain available.</span>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-3 flex flex-col justify-between">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Balance Qty</div>
            <div className="text-xl font-bold tabular-nums">
              {fmtQty(data.grandTotal)}
            </div>
            <div className="text-xs text-muted-foreground">pieces</div>
          </div>
          <div className="mt-2">
            <ReconText
              rec={measure === "amount" ? data.amountReconciliation?.company : data.reconciliation?.company}
              measure={measure}
            />
          </div>
        </div>
        {data.pricingAvailable === true && <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">Priced amount</div>
          <div className="text-xl font-bold tabular-nums">
            {data.pricedAmount != null ? fmtCr(data.pricedAmount) : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {data.unpriceableQty != null ? `${fmtQty(data.unpriceableQty)} pcs unpriceable` : "—"}
          </div>
        </div>}
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

      {/* Attribution Summary */}
      {data.attributionAvailable !== false && data.coverage && (
        <>
          <div className="text-sm font-semibold mt-2">Attribution Coverage</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-1">Safe Coverage</div>
              <div className="text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-500">
                {(data.coverage.safeCoveragePct ?? 0).toFixed(2)}%
              </div>
              <div className="text-xs text-muted-foreground">{fmtQty(data.coverage.safeQty ?? 0)} pcs</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-1">Candidate Coverage</div>
              <div className="text-xl font-bold tabular-nums">
                {(data.coverage.candidateCoveragePct ?? 0).toFixed(2)}%
              </div>
              <div className="text-xs text-muted-foreground">{fmtQty(data.coverage.candidateQty ?? 0)} pcs (incl. LEFT)</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-1">Conflict Cost</div>
              <div className="text-xl font-bold tabular-nums text-destructive">
                {(data.coverage.conflictCostPp ?? 0).toFixed(2)} pp
              </div>
              <div className="text-xs text-muted-foreground">{fmtQty(data.coverage.conflictQty ?? 0)} pcs disputed</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-1">Unassigned Gap</div>
              <div className="text-xl font-bold tabular-nums text-amber-600 dark:text-amber-500">
                {fmtQty(data.coverage.unassignedQty ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">pieces without candidates</div>
            </div>
          </div>
        </>
      )}

      {/* Cross-check panel */}
      {(measure !== "amount" || data.pricingAvailable === true) && <div className="rounded-lg border border-border bg-card p-4 mt-2">
        <div className="flex items-center gap-2 mb-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">
            Cross-check: Derived pending vs factory pending
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4 text-sm">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Priced factory pending</span>
            <span className="font-semibold tabular-nums">
              {data.pricedAmount != null ? fmtCr(data.pricedAmount) : "—"}
            </span>
            <span className="text-xs text-muted-foreground">Independent REPORT 2 amount measure</span>
          </div>
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
           The priced factory pending and derived pending are independent measures.
           They are expected to agree in magnitude as a cross-check, but are not fully
           comparable: derived pending is OB minus Sale while factory pending is priced
           REPORT 2 quantity.
        </p>
      </div>}

      {/* Per-head sections */}
      {data.byHead.length === 0 && !data.error && (
        <div className="text-center text-sm text-muted-foreground py-8 mt-4">
          No pending orders found in factory sheet.
        </div>
      )}
      {measure === "amount" && data.pricingAvailable !== true ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 mt-4">
          Amount pricing unavailable{data.pricingError ? `: ${data.pricingError}` : "."}
        </div>
      ) : data.attributionAvailable === false ? (
        <div className="flex flex-col gap-2 mt-4">
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Factory totals and source parties remain available, but the member
            hierarchy is withheld because assignment or Attribution Conflicts
            evidence could not be loaded. No party has been treated as safely mapped.
          </div>
          {data.byHead
            .slice()
            .sort((a, b) => b.total - a.total)
            .map((head) => (
               <SourceOnlyHeadSection key={head.head} head={head} groups={data.groups} measure={measure} />
            ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          {data.byHead
            .slice()
            .sort((a, b) => b.total - a.total)
            .map((h) => (
              <HeadSection
                key={h.head}
                head={h}
                groups={data.groups}
                defaultOpen={false}
                measure={measure}
                openState={openState}
                onOpenChange={(key, value) => setOpenState((current) => ({ ...current, [key]: value }))}
              />
            ))}
        </div>
      )}

      {data.computedAt && (
        <p className="text-xs text-muted-foreground text-center mt-4">
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
