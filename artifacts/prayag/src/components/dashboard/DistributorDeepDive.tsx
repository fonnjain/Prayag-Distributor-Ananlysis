// Distributor Deep Dive — Phase D1
//
// Reads all member working sheets under a state head, groups retailer rows by
// Assigned Distributor, and surfaces four distinct field states:
//   blank   → direct dealer branch (parallel, never under a distributor)
//   '--'    → no distributor assigned (mapping problem — flag it)
//   A,B     → shared distributor relationship (not a split)
//   other   → normalised distributor group
//
// Design rules:
//   - Direct dealers are NEVER shown as a child of any distributor.
//   - Every distributor total must show Confirmed / Guessed confidence split.
//   - Concentration >= 60 % of party OB → show a risk callout.
//   - "None-assigned" panel includes visit-effort share observation.
//   - Flow gap is an observation, not an accusation (cannot distinguish stock
//     building from channel leakage from this data).
import { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Users,
  ShoppingBag,
  Loader2,
  Info,
  CheckCircle2,
  HelpCircle,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { formatINR } from "@/data/dataset";

// ── Types ────────────────────────────────────────────────────────────────────

type DistributorRetailerRow = {
  name: string;
  district: string | null;
  city: string | null;
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

/** D2: per-distributor flow data returned by the API. */
type DistributorFlows = {
  hasPrimaryData: boolean;
  primaryDispatch: number;
  primaryOb: number | null;
  pendingValue: number | null;
  fillRate: number | null;
  matchedCustomers: string[];
  secondaryOut: number;
  secondarySource: string;
  flowGap: number | null;
  period: string;
  lastInvoiceDate: string | null;
  daysSinceLastOrder: number | null;
  invoiceCount: number;
  monthsActive: number;
  ordersPerMonth: number | null;
  yoyPeriod: string;
  currentPeriodDispatch: number | null;
  priorPeriodDispatch: number | null;
  growthPct: number | null;
};

/** D3: brand_canon/segment spread per distributor from secondary_register_line. */
type DistributorBrandNet = {
  segment: string;
  net: number;
  pct: number;
};

type WhitespaceHint = {
  type: "range_depth" | "lost_brand" | "peer_whitespace";
  brand: string;
  broadSegment: string;
  evidence: string;
  peerNames?: string[];
  peerNet?: number;
};

type DistributorSkuSpread = {
  isLiveYear: boolean;
  liveYearNote?: string;
  totalBroadSegments: number;
  recentFy?: string;
  totalNet?: number;
  distinctBrands?: number;
  broadSegmentsCovered?: number;
  netByBrand?: DistributorBrandNet[];
  netByBroadSegment?: DistributorBrandNet[];
  crossSellDepth?: number;
  concentrationHhi?: number;
  matchedRetailers?: number;
  whitespace?: WhitespaceHint[];
};

type DistributorGroup = {
  name: string;
  normKey: string;
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  obSharePct: number | null;
  isConcentrationRisk: boolean;
  confirmedCount: number;
  guessedCount: number;
  retailers: DistributorRetailerRow[];
  flows: DistributorFlows | null;
  skuSpread?: DistributorSkuSpread;
};

type SharedRetailerEntry = {
  name: string;
  rawDistributor: string;
  distributorParts: string[];
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

type DirectDealerSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
};

type NoneAssignedSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  visitSharePct: number | null;
  allDormant: boolean;
};

type MappingQuality = {
  totalRetailers: number;
  blankCount: number;
  noneCount: number;
  sharedCount: number;
  malformedCount: number;
  distributorCount: number;
  noneVisits: number | null;
  totalVisits: number | null;
  noneVisitSharePct: number | null;
  noneAllDormant: boolean;
};

type DistributorDeepDiveResult = {
  fy: string;
  stateHeads: string[];
  distributors: DistributorGroup[];
  sharedRetailers: SharedRetailerEntry[];
  directDealer: DirectDealerSummary | null;
  noneAssigned: NoneAssignedSummary | null;
  mappingQuality: MappingQuality | null;
  partyObTotal: number;
  membersLoaded: number;
  membersNotMapped: number;
  error: string | null;
};

// ── API ──────────────────────────────────────────────────────────────────────

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
const FY_OPTIONS = ["2026-27", "2025-26", "2024-25", "2023-24"];
const CONCENTRATION_THRESHOLD = 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number | null): string {
  if (n === null) return "--";
  return n.toFixed(1) + "%";
}

function visits(n: number | null): string {
  if (n === null) return "--";
  return n.toLocaleString("en-IN");
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ConfidenceBadge({ confirmed, guessed }: { confirmed: number; guessed: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
      <span className="text-emerald-700">{confirmed}</span>
      <HelpCircle className="w-3 h-3 text-amber-500" />
      <span className="text-amber-600">{guessed}</span>
    </span>
  );
}

function SectionCard({ title, children, className }: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border border-border rounded-lg overflow-hidden ${className ?? ""}`}>
      <div className="bg-muted/40 px-4 py-2.5 border-b border-border">
        <h3 className="font-semibold text-sm tracking-wide text-foreground">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function RetailerTable({ retailers, memberName }: {
  retailers: DistributorRetailerRow[];
  memberName?: string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground text-xs">
            <th className="text-left py-2 pr-4 font-medium">Retailer</th>
            {memberName === undefined && (
              <th className="text-left py-2 pr-4 font-medium">Member</th>
            )}
            <th className="text-left py-2 pr-4 font-medium">Location</th>
            <th className="text-right py-2 pr-4 font-medium">OB (Rs)</th>
            <th className="text-right py-2 pr-4 font-medium">Sale (Rs)</th>
            <th className="text-right py-2 font-medium">Visits</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {retailers.map((r, i) => (
            <tr
              key={i}
              className={`${r.isActive ? "" : "opacity-50"} hover:bg-muted/30`}
            >
              <td className="py-1.5 pr-4 font-medium">
                <div className="flex items-start gap-1.5">
                  {r.confirmedHead ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-600 mt-0.5 shrink-0" aria-label="Confirmed" />
                  ) : (
                    <HelpCircle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" aria-label="Guessed" />
                  )}
                  <span>{r.name}</span>
                </div>
              </td>
              {memberName === undefined && (
                <td className="py-1.5 pr-4 text-muted-foreground text-xs">{r.memberName}</td>
              )}
              <td className="py-1.5 pr-4 text-muted-foreground text-xs">
                {[r.city, r.district].filter(Boolean).join(", ") || "--"}
              </td>
              <td className="py-1.5 pr-4 text-right tabular-nums">
                {r.orderBooking > 0 ? formatINR(r.orderBooking) : (
                  <span className="text-muted-foreground">--</span>
                )}
              </td>
              <td className="py-1.5 pr-4 text-right tabular-nums">
                {r.sale > 0 ? formatINR(r.sale) : (
                  <span className="text-muted-foreground">--</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {visits(r.visits)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── D2: Flow panel ────────────────────────────────────────────────────────────

function FlowPanel({ flows, distName }: { flows: DistributorFlows | null; distName: string }) {
  if (!flows) return null;

  if (!flows.hasPrimaryData) {
    return (
      <div className="mb-4 border border-border rounded-lg p-4 bg-muted/5">
        <div className="text-sm font-semibold mb-1.5">Flows and Pending</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          No primary dispatch data found for {distName} in the primary sales register for {flows.period}.
          The distributor may be listed under a different name in the SAP system.
          {flows.matchedCustomers.length > 0 && (
            <> Customer name(s) tried: {flows.matchedCustomers.join(", ")}.</>
          )}
        </p>
        {flows.primaryOb !== null && flows.primaryOb > 0 && (
          <div className="mt-2.5 grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Order Booking (primary)</div>
              <div className="font-semibold tabular-nums text-sm">{formatINR(flows.primaryOb)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Secondary Out (member sheets)</div>
              <div className="font-semibold tabular-nums text-sm">{formatINR(flows.secondaryOut)}</div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const gapPositive = flows.flowGap !== null && flows.flowGap >= 0;

  return (
    <div className="mb-4 border border-border rounded-lg overflow-hidden">
      <div className="bg-muted/40 px-4 py-2.5 border-b border-border flex items-center justify-between">
        <h4 className="font-semibold text-sm">Flows and Pending</h4>
        <span className="text-xs text-muted-foreground">{flows.period}</span>
      </div>
      <div className="p-4 space-y-4">

        {/* Two-column flow comparison */}
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Primary In — Prayag to Distributor
            </div>
            <div className="text-xl font-bold tabular-nums">{formatINR(flows.primaryDispatch)}</div>
            <div className="text-xs text-muted-foreground">Primary sales register</div>
            {flows.matchedCustomers.length > 0 && (
              <div className="text-xs text-muted-foreground italic">
                Matched as: {flows.matchedCustomers.join(", ")}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Secondary Out — Distributor to Retailers
            </div>
            <div className="text-xl font-bold tabular-nums">{formatINR(flows.secondaryOut)}</div>
            <div className="text-xs text-muted-foreground">Member sheets (FY to date)</div>
          </div>
        </div>

        {/* Flow gap observation */}
        {flows.flowGap !== null && (
          <div className={`rounded-md px-3 py-2.5 text-xs leading-relaxed ${
            gapPositive
              ? "bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800/50 text-blue-900 dark:text-blue-200"
              : "bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800/50 text-orange-900 dark:text-orange-200"
          }`}>
            <span className="font-semibold">Flow gap: </span>
            <span className="tabular-nums font-bold">
              {flows.flowGap >= 0 ? "+" : ""}{formatINR(flows.flowGap)}
            </span>
            <span className="ml-2 opacity-80">
              {gapPositive
                ? "Primary in exceeds secondary out — may indicate stock building at the distributor, or business moving outside the attributed retailer channel."
                : "Secondary out exceeds primary in — may indicate prior-period stock being liquidated, or secondary reported against a different primary FY."}
            </span>
          </div>
        )}

        {/* Pending: OB vs dispatch */}
        {flows.primaryOb !== null && (
          <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border/60">
            <div>
              <div className="text-xs text-muted-foreground">Order Booking</div>
              <div className="font-semibold tabular-nums text-sm">{formatINR(flows.primaryOb)}</div>
              <div className="text-xs text-muted-foreground">primary, non-institutional</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Dispatched</div>
              <div className="font-semibold tabular-nums text-sm">{formatINR(flows.primaryDispatch)}</div>
              <div className="text-xs text-muted-foreground">primary register</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pending</div>
              <div className={`font-semibold tabular-nums text-sm ${
                (flows.pendingValue ?? 0) > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
              }`}>
                {flows.pendingValue !== null ? formatINR(flows.pendingValue) : "--"}
              </div>
              <div className="text-xs text-muted-foreground">
                {flows.fillRate !== null
                  ? `${flows.fillRate.toFixed(1)}% fill rate`
                  : ""}
              </div>
            </div>
          </div>
        )}

        {/* Recency and frequency */}
        <div className="flex flex-wrap gap-5 text-sm pt-1 border-t border-border/60">
          <div>
            <span className="text-xs text-muted-foreground">Last dispatch: </span>
            <span className="font-medium">
              {flows.daysSinceLastOrder !== null
                ? `${flows.daysSinceLastOrder} day${flows.daysSinceLastOrder !== 1 ? "s" : ""} ago`
                : (flows.lastInvoiceDate ?? "--")}
            </span>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Dispatches per month: </span>
            <span className="font-medium">
              {flows.ordersPerMonth !== null ? flows.ordersPerMonth.toFixed(1) : "--"}
            </span>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Invoices (FY): </span>
            <span className="font-medium">{flows.invoiceCount}</span>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Months active: </span>
            <span className="font-medium">{flows.monthsActive}</span>
          </div>
        </div>

        {/* YoY growth */}
        {(flows.currentPeriodDispatch !== null || flows.priorPeriodDispatch !== null) && (
          <div className="pt-1 border-t border-border/60">
            <div className="text-xs text-muted-foreground mb-2">
              Year-on-year — {flows.yoyPeriod}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div>
                <div className="text-xs text-muted-foreground">This period</div>
                <div className="font-semibold tabular-nums text-sm">
                  {flows.currentPeriodDispatch !== null
                    ? formatINR(flows.currentPeriodDispatch)
                    : "--"}
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Prior period</div>
                <div className="font-semibold tabular-nums text-sm">
                  {flows.priorPeriodDispatch !== null
                    ? formatINR(flows.priorPeriodDispatch)
                    : "no data"}
                </div>
              </div>
              {flows.growthPct !== null && (
                <div className={`flex items-center gap-1 font-bold text-sm ${
                  flows.growthPct >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}>
                  {flows.growthPct >= 0
                    ? <TrendingUp className="w-4 h-4" />
                    : <TrendingDown className="w-4 h-4" />}
                  {flows.growthPct >= 0 ? "+" : ""}{flows.growthPct.toFixed(1)}%
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── D3: SKU / segment spread panel ───────────────────────────────────────────

const HHI_LABEL = (hhi: number) =>
  hhi < 2500 ? "Diversified" : hhi < 5000 ? "Moderate" : "Concentrated";

const WHITESPACE_TYPE_LABEL: Record<WhitespaceHint["type"], string> = {
  range_depth: "Range depth",
  lost_brand: "Lost line",
  peer_whitespace: "Peer gap",
};

const WHITESPACE_TYPE_COLOR: Record<WhitespaceHint["type"], string> = {
  range_depth:
    "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300",
  lost_brand:
    "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-300",
  peer_whitespace:
    "bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/40 text-blue-800 dark:text-blue-300",
};

function SkuSpreadPanel({
  spread,
  distName,
}: {
  spread: DistributorSkuSpread | undefined;
  distName: string;
}) {
  if (!spread) return null;

  // Live FY placeholder
  if (spread.isLiveYear) {
    return (
      <div className="mb-4 border border-border rounded-lg p-4 bg-muted/5">
        <div className="text-sm font-semibold mb-1">Product Mix</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {spread.liveYearNote ??
            "Segment data will populate once a FY2026-27 secondary register is ingested."}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          The secondary register is the source for this panel. The dealer's assigned
          segment attribute records allocation, not actual purchases, and is never
          substituted here.
        </p>
      </div>
    );
  }

  // No retailer matches
  if ((spread.matchedRetailers ?? 0) === 0) {
    return (
      <div className="mb-4 border border-border rounded-lg p-4 bg-muted/5">
        <div className="text-sm font-semibold mb-1">Product Mix</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          No secondary register rows matched {distName}'s retailers for closed FYs
          (FY2021-22 through FY2025-26). Retailer names from the member working
          sheet may differ from how the secondary register records them.
        </p>
      </div>
    );
  }

  const brands = spread.netByBrand ?? [];
  const broadSegs = spread.netByBroadSegment ?? [];
  const whitespace = spread.whitespace ?? [];
  const totalNet = spread.totalNet ?? 0;
  const maxBrandNet = brands[0]?.net ?? 1;

  return (
    <div className="mb-4 border border-border rounded-lg overflow-hidden">
      <div className="bg-muted/40 px-4 py-2.5 border-b border-border flex items-center justify-between">
        <h4 className="font-semibold text-sm">Product Mix</h4>
        <span className="text-xs text-muted-foreground">
          Secondary register — {spread.recentFy} &nbsp;·&nbsp;
          {spread.matchedRetailers} retailer{spread.matchedRetailers !== 1 ? "s" : ""} matched
        </span>
      </div>

      <div className="p-4 space-y-5">

        {/* Coverage tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Broad segments</div>
            <div className="font-bold text-lg tabular-nums">
              {spread.broadSegmentsCovered ?? 0}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}of {spread.totalBroadSegments}
              </span>
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Product lines</div>
            <div className="font-bold text-lg tabular-nums">{spread.distinctBrands ?? 0}</div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Cross-sell depth</div>
            <div className="font-bold text-lg tabular-nums">
              {spread.crossSellDepth?.toFixed(1) ?? "--"}
              <span className="text-sm font-normal text-muted-foreground"> avg lines/retailer</span>
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Concentration</div>
            <div className="font-bold text-lg tabular-nums">
              {spread.concentrationHhi != null ? HHI_LABEL(spread.concentrationHhi) : "--"}
            </div>
            {spread.concentrationHhi != null && (
              <div className="text-xs text-muted-foreground">
                HHI {spread.concentrationHhi.toLocaleString()}
              </div>
            )}
          </div>
        </div>

        {/* Broad segment bars */}
        {broadSegs.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              NET by broad segment — {spread.recentFy}
            </div>
            <div className="space-y-1.5">
              {broadSegs.map((seg) => (
                <div key={seg.segment} className="flex items-center gap-2">
                  <div className="w-32 shrink-0 text-xs truncate text-right text-muted-foreground">
                    {seg.segment}
                  </div>
                  <div className="flex-1 bg-muted/40 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-2 rounded-full bg-primary/70"
                      style={{ width: `${Math.min(100, seg.pct)}%` }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-xs tabular-nums text-right">
                    {formatINR(seg.net)}
                    <span className="text-muted-foreground ml-1">{seg.pct.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top product lines */}
        {brands.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Top product lines (brand_canon) — {spread.recentFy}
            </div>
            <div className="space-y-1">
              {brands.slice(0, 8).map((b) => (
                <div key={b.segment} className="flex items-center gap-2">
                  <div className="w-48 shrink-0 text-xs truncate text-muted-foreground">
                    {b.segment}
                  </div>
                  <div className="flex-1 bg-muted/40 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-1.5 rounded-full bg-primary/50"
                      style={{ width: `${Math.round((b.net / maxBrandNet) * 100)}%` }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-xs tabular-nums text-right">
                    {formatINR(b.net)}
                  </div>
                </div>
              ))}
              {brands.length > 8 && (
                <div className="text-xs text-muted-foreground pl-48 pt-0.5">
                  + {brands.length - 8} more product lines (total {formatINR(totalNet)})
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2 italic">
              The secondary register records sales at product-line level (brand_canon), not
              individual item codes. Brand_canon is the finest granularity available.
            </p>
          </div>
        )}

        {/* Whitespace */}
        {whitespace.length > 0 && (
          <div className="pt-1 border-t border-border/60">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Whitespace — ranked easiest to convert first
            </div>
            <div className="space-y-1.5">
              {whitespace.map((h, i) => (
                <div
                  key={i}
                  className={`rounded-md border px-3 py-2 text-xs ${WHITESPACE_TYPE_COLOR[h.type]}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 font-semibold mt-px">
                      {WHITESPACE_TYPE_LABEL[h.type]}
                    </span>
                    <span className="font-medium">{h.brand}</span>
                    <span className="text-[10px] opacity-70 shrink-0">{h.broadSegment}</span>
                  </div>
                  <div className="mt-0.5 opacity-80">{h.evidence}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {whitespace.length === 0 && brands.length > 0 && (
          <div className="pt-1 border-t border-border/60">
            <div className="text-xs text-muted-foreground">
              No whitespace suggestions — this distributor sells all product lines
              observed across comparable distributors for {spread.recentFy}.
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DistributorDeepDive() {
  const [fy, setFy]               = useState("2026-27");
  const [stateHead, setStateHead] = useState("");
  const [data, setData]           = useState<DistributorDeepDiveResult | null>(null);
  const [loading, setLoading]     = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expandedDist, setExpandedDist] = useState<string | null>(null);

  const load = useCallback(async (fyVal: string, stateHeadVal: string) => {
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({ fy: fyVal });
      if (stateHeadVal) params.set("stateHead", stateHeadVal);
      const res = await fetch(`${API}/mgmt/distributor-deep-dive?${params}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const json: DistributorDeepDiveResult = await res.json();
      setData(json);
      // Auto-populate state head from first available if the selector is empty.
      if (!stateHeadVal && json.stateHeads.length > 0) {
        setStateHead(json.stateHeads[0]);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load to get state head list.
  useEffect(() => {
    load(fy, stateHead);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFyChange(next: string) {
    setFy(next);
    setData(null);
    setExpandedDist(null);
    load(next, stateHead);
  }

  function handleStateHeadChange(next: string) {
    setStateHead(next);
    setData(null);
    setExpandedDist(null);
    load(fy, next);
  }

  function toggleDist(normKey: string) {
    setExpandedDist((prev) => (prev === normKey ? null : normKey));
  }

  const stateHeads = data?.stateHeads ?? [];
  const hasConcentrationRisk = data?.distributors.some((d) => d.isConcentrationRisk) ?? false;

  return (
    <div className="space-y-6">
      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">FY</label>
          <select
            value={fy}
            onChange={(e) => handleFyChange(e.target.value)}
            className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {FY_OPTIONS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">State Head</label>
          <select
            value={stateHead}
            onChange={(e) => handleStateHeadChange(e.target.value)}
            className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring min-w-[180px]"
            disabled={stateHeads.length === 0}
          >
            <option value="">All state heads</option>
            {stateHeads.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>

        {loading && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading sheets...
          </span>
        )}
        {data && !loading && (
          <span className="text-xs text-muted-foreground">
            {data.membersLoaded} member sheet{data.membersLoaded !== 1 ? "s" : ""} loaded
            {data.membersNotMapped > 0 && `, ${data.membersNotMapped} not yet mapped`}
          </span>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────── */}
      {fetchError && (
        <div className="border border-destructive/40 bg-destructive/5 rounded-lg p-4 text-sm text-destructive">
          {fetchError}
        </div>
      )}
      {data?.error && (
        <div className="border border-destructive/40 bg-destructive/5 rounded-lg p-4 text-sm text-destructive">
          {data.error}
        </div>
      )}

      {/* ── No state head selected ─────────────────────────────────── */}
      {!loading && data && !stateHead && (
        <div className="text-muted-foreground text-sm text-center py-12">
          Select a state head to see the distributor breakdown.
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────── */}
      {data && stateHead && (
        <>
          {/* Concentration risk callout */}
          {hasConcentrationRisk && (
            <div className="flex items-start gap-3 border border-amber-400/50 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-600/40 rounded-lg p-4">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <span className="font-semibold text-amber-800 dark:text-amber-400">Concentration risk: </span>
                <span className="text-amber-800 dark:text-amber-300">
                  {data.distributors.filter((d) => d.isConcentrationRisk).map((d) => (
                    `${d.name} (${pct(d.obSharePct)} of party order booking)`
                  )).join(", ")}. Over {CONCENTRATION_THRESHOLD}% of secondary business
                  flows through a single distributor.
                </span>
              </div>
            </div>
          )}

          {/* Summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-border rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">Party OB</div>
              <div className="font-bold text-lg tabular-nums">{formatINR(data.partyObTotal)}</div>
              <div className="text-xs text-muted-foreground">via distributors</div>
            </div>
            <div className="border border-border rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">Direct Dealer OB</div>
              <div className="font-bold text-lg tabular-nums">
                {data.directDealer ? formatINR(data.directDealer.orderBooking) : "--"}
              </div>
              <div className="text-xs text-muted-foreground">parallel channel</div>
            </div>
            <div className="border border-border rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">Total Retailers</div>
              <div className="font-bold text-lg">
                {data.mappingQuality?.totalRetailers ?? "--"}
              </div>
              <div className="text-xs text-muted-foreground">
                {data.mappingQuality && (
                  `${data.distributors.reduce((s, d) => s + d.activeCount, 0) +
                    (data.directDealer?.activeCount ?? 0) +
                    data.sharedRetailers.filter((r) => r.isActive).length} active`
                )}
              </div>
            </div>
            <div className="border border-border rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">Distributors</div>
              <div className="font-bold text-lg">{data.distributors.length}</div>
              <div className="text-xs text-muted-foreground">
                {data.sharedRetailers.length > 0 && `+ ${data.sharedRetailers.length} shared`}
              </div>
            </div>
          </div>

          {/* ── Distributor table ───────────────────────────────────── */}
          {data.distributors.length > 0 && (
            <SectionCard title="Distributor Overview">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-4 font-medium w-8"></th>
                      <th className="text-left py-2 pr-4 font-medium">Distributor</th>
                      <th className="text-right py-2 pr-3 font-medium">Retailers</th>
                      <th className="text-right py-2 pr-3 font-medium">Active</th>
                      <th className="text-right py-2 pr-4 font-medium">Order Booking</th>
                      <th className="text-right py-2 pr-4 font-medium">Sale</th>
                      <th className="text-right py-2 pr-3 font-medium">Visits</th>
                      <th className="text-right py-2 pr-3 font-medium">Party%</th>
                      <th className="text-left py-2 font-medium">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.distributors.map((dist) => (
                      <>
                        <tr
                          key={dist.normKey}
                          className={`hover:bg-muted/30 cursor-pointer ${
                            expandedDist === dist.normKey ? "bg-muted/20" : ""
                          }`}
                          onClick={() => toggleDist(dist.normKey)}
                        >
                          <td className="py-2 pr-2 text-muted-foreground">
                            {expandedDist === dist.normKey
                              ? <ChevronDown className="w-4 h-4" />
                              : <ChevronRight className="w-4 h-4" />}
                          </td>
                          <td className="py-2 pr-4 font-medium">
                            <div className="flex items-center gap-2">
                              {dist.isConcentrationRisk && (
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              )}
                              {dist.name}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{dist.retailerCount}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <span className={dist.activeCount > 0 ? "text-emerald-700 font-medium" : "text-muted-foreground"}>
                              {dist.activeCount}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums font-medium">
                            {formatINR(dist.orderBooking)}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                            {dist.sale > 0 ? formatINR(dist.sale) : "--"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                            {visits(dist.visits)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <span className={`font-medium ${dist.isConcentrationRisk ? "text-amber-600" : ""}`}>
                              {pct(dist.obSharePct)}
                            </span>
                          </td>
                          <td className="py-2">
                            <ConfidenceBadge confirmed={dist.confirmedCount} guessed={dist.guessedCount} />
                          </td>
                        </tr>

                        {/* Expanded detail: flows (D2) + retailer table (D1) */}
                        {expandedDist === dist.normKey && (
                          <tr key={`${dist.normKey}-detail`}>
                            <td colSpan={9} className="bg-muted/10 px-4 py-4">
                              <FlowPanel flows={dist.flows} distName={dist.name} />
                              <SkuSpreadPanel spread={dist.skuSpread} distName={dist.name} />
                              <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                Confirmed
                                <HelpCircle className="w-3 h-3 text-amber-500 ml-1" />
                                Guessed head attribution
                              </div>
                              <RetailerTable
                                retailers={dist.retailers}
                                memberName={undefined}
                              />
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                  {/* Totals row */}
                  <tfoot>
                    <tr className="border-t-2 border-border font-semibold text-sm">
                      <td colSpan={2} className="py-2 pr-4 text-muted-foreground">Party total</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {data.distributors.reduce((s, d) => s + d.retailerCount, 0)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {data.distributors.reduce((s, d) => s + d.activeCount, 0)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatINR(data.distributors.reduce((s, d) => s + d.orderBooking, 0))}
                      </td>
                      <td colSpan={4}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </SectionCard>
          )}

          {/* ── Shared retailers ────────────────────────────────────── */}
          {data.sharedRetailers.length > 0 && (
            <SectionCard title={`Shared Distributors (${data.sharedRetailers.length} retailer${data.sharedRetailers.length !== 1 ? "s" : ""})`}>
              <p className="text-xs text-muted-foreground mb-3 flex items-start gap-2">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                These retailers have two or more distributors listed in the sheet.
                This records a supply relationship — the order booking belongs to the
                retailer, not split across distributors. Included in party OB total.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-4 font-medium">Retailer</th>
                      <th className="text-left py-2 pr-4 font-medium">Distributors</th>
                      <th className="text-right py-2 pr-4 font-medium">OB (Rs)</th>
                      <th className="text-right py-2 font-medium">Visits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.sharedRetailers.map((r, i) => (
                      <tr key={i} className={r.isActive ? "" : "opacity-50"}>
                        <td className="py-1.5 pr-4 font-medium">
                          <div className="flex items-center gap-1.5">
                            {r.confirmedHead
                              ? <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                              : <HelpCircle className="w-3 h-3 text-amber-500 shrink-0" />}
                            {r.name}
                          </div>
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground text-xs">
                          {r.distributorParts.join(" + ")}
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">
                          {r.orderBooking > 0 ? formatINR(r.orderBooking) : "--"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                          {visits(r.visits)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {/* ── Two-column row: Direct Dealer + None Assigned ───────── */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* Direct dealer */}
            {data.directDealer && (
              <SectionCard title="Direct Dealers">
                <p className="text-xs text-muted-foreground mb-3 flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  These retailers buy directly from Prayag — they are NOT served
                  via any distributor. Shown as a parallel channel.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Retailers", value: String(data.directDealer.retailerCount) },
                    { label: "Active",    value: String(data.directDealer.activeCount)   },
                    { label: "OB",        value: formatINR(data.directDealer.orderBooking) },
                    { label: "Sale",      value: data.directDealer.sale > 0 ? formatINR(data.directDealer.sale) : "--" },
                    { label: "Visits",    value: visits(data.directDealer.visits) },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-semibold tabular-nums">{value}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* None assigned */}
            {data.noneAssigned && (
              <SectionCard title="No Distributor Assigned (--)">
                <p className="text-xs text-muted-foreground mb-3 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                  {data.noneAssigned.allDormant
                    ? `All ${data.noneAssigned.retailerCount} retailers are dormant (zero OB and sale).`
                    : `${data.noneAssigned.dormantCount} of ${data.noneAssigned.retailerCount} retailers are dormant.`}
                  {data.noneAssigned.visitSharePct !== null && (
                    <> They absorb {pct(data.noneAssigned.visitSharePct)} of total visit effort.</>
                  )}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Retailers", value: String(data.noneAssigned.retailerCount)                           },
                    { label: "Active",    value: String(data.noneAssigned.activeCount)                              },
                    { label: "Visits",    value: visits(data.noneAssigned.visits)                                   },
                    { label: "Visit %",   value: pct(data.noneAssigned.visitSharePct)                               },
                    { label: "OB",        value: data.noneAssigned.orderBooking > 0 ? formatINR(data.noneAssigned.orderBooking) : "Rs 0" },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-semibold tabular-nums">{value}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}
          </div>

          {/* ── Mapping quality panel ───────────────────────────────── */}
          {data.mappingQuality && (
            <SectionCard title="Mapping Quality">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 text-sm">
                {[
                  {
                    label: "Direct Dealers",
                    value: data.mappingQuality.blankCount,
                    note:  "blank field",
                    color: "text-foreground",
                  },
                  {
                    label: "Via Distributor",
                    value: data.mappingQuality.distributorCount,
                    note:  "assigned",
                    color: "text-emerald-700",
                  },
                  {
                    label: "Shared",
                    value: data.mappingQuality.sharedCount,
                    note:  "comma-separated",
                    color: "text-foreground",
                  },
                  {
                    label: "None Assigned",
                    value: data.mappingQuality.noneCount,
                    note:  "'--' in field",
                    color: data.mappingQuality.noneCount > 0 ? "text-amber-600" : "text-foreground",
                  },
                  {
                    label: "Malformed",
                    value: data.mappingQuality.malformedCount,
                    note:  "excluded",
                    color: data.mappingQuality.malformedCount > 0 ? "text-destructive" : "text-muted-foreground",
                  },
                ].map(({ label, value, note, color }) => (
                  <div key={label} className="space-y-0.5">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
                    <div className="text-xs text-muted-foreground">{note}</div>
                  </div>
                ))}
              </div>
              {data.mappingQuality.noneVisitSharePct !== null &&
               data.mappingQuality.noneAllDormant &&
               data.mappingQuality.noneCount > 0 && (
                <div className="mt-4 pt-3 border-t border-border/50 text-xs text-muted-foreground flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {data.mappingQuality.noneCount} retailers with no distributor assigned are all dormant,
                    yet absorb {pct(data.mappingQuality.noneVisitSharePct)} of total visit effort.
                    Assigning a distributor is a prerequisite for any order booking from these outlets.
                  </span>
                </div>
              )}
            </SectionCard>
          )}

          {/* ── Empty state when no sheets returned data ──────────── */}
          {!loading &&
           data.distributors.length === 0 &&
           !data.directDealer &&
           !data.noneAssigned &&
           !data.error && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p>No retailer data found for this state head.</p>
              {data.membersNotMapped > 0 && (
                <p className="mt-1 text-xs">
                  {data.membersNotMapped} member sheet{data.membersNotMapped !== 1 ? "s are" : " is"} not yet
                  mapped in the config — add them to <code>config/member_sheet_map.json</code>.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Loading placeholder ─────────────────────────────────────── */}
      {loading && !data && (
        <div className="flex items-center justify-center py-20 gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Reading member working sheets...</span>
        </div>
      )}
    </div>
  );
}
