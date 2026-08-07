import { trunc2 } from "@/lib/trunc";
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
import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";
import { useGlobalFilter } from "@/data/global-filter-context";
import { REGION_GROUPS } from "../ui/StateFilter";
import { achBandText } from "@/lib/achievementBands";
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

/** D4: investment, ROI and tier per distributor. */
type EffectiveDiscount = {
  recentFy: string;
  grossTotal: number;
  netTotal: number;
  discountAmount: number;
  weightedDiscountPct: number;
  hasAnomalousLines: boolean;
  peerMedianDiscountPct: number | null;
  abovePeerMedian: boolean;
  sampleLineGross: number | null;
  sampleLineDiscountPct: number | null;
  sampleLineNet: number | null;
  sampleLineComputed: number | null;
};

type CostToServe = {
  distributorVisits: number;
  memberCostPerVisit: number;
  visitCostToServe: number;
};

type DistributorRoiD4 = {
  netRevenue: number;
  revenueRecentFy: string;
  visitCostToServe: number;
  netToCostMultiple: number;
  marginRoiAvailable: false;
};

type TierInput = {
  label: string;
  value: string;
  score: number;
  note: string;
};

type DistributorTier = {
  tier: "A" | "B" | "C";
  score: number;
  visitCadence: string;
  creditPosture: string;
  inputs: TierInput[];
  // D7 extensions
  cadenceDistributorPerMonth: number;
  cadenceRetailerPerMonth: number;
  rangeFocus: string[];
  isOverridden: boolean;
  overrideReason: string | null;
};

type RetailerConcentration = {
  totalOb: number;
  top5Ob: number;
  top5SharePct: number | null;
  top10Ob: number;
  top10SharePct: number | null;
  topRetailerName: string | null;
  topRetailerOb: number | null;
  topRetailerSharePct: number | null;
};

type CapacityCheckBreakdown = {
  normKey: string;
  name: string;
  tier: "A" | "B" | "C";
  demandedRetailerVisitsPerMonth: number;
};

type CapacityCheck = {
  availablePerMonth: number | null;
  demandedPerMonth: number;
  shortfallPerMonth: number | null;
  hasShortfall: boolean;
  breakdown: CapacityCheckBreakdown[];
};

type DistributorInvestment = {
  effectiveDiscount: EffectiveDiscount | null;
  costToServe: CostToServe | null;
  creditOutstanding: { status: "no_source" };
  schemePayouts: { status: "no_source" };
  roi: DistributorRoiD4 | null;
  tier: DistributorTier;
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
  investment?: DistributorInvestment;
  retailerConcentration?: RetailerConcentration;
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
  /** Secondary OB from working-sheet blank-distributor rows (typically 0 for direct-dealer channels). */
  orderBooking: number;
  sale: number;
  visits: number | null;
  /** Authoritative OB from Data-tab directDealersOrder column. */
  dashboardOb: number | null;
  /** Member whose Data-tab directDealersOrder > 0. */
  dashboardMember: string | null;
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

// ── SD2: per-state and per-member analysis ────────────────────────────────────

type StateDistributorRow = {
  state: string;
  memberCount: number;
  retailerCount: number;
  visitCount: number | null;
  namedCount: number;
  noneCount: number;
  blankCount: number;
  sharedCount: number;
  malformedCount: number;
  namedActiveCount: number;
  namedActivePct: number | null;
  noneActiveCount: number;
  noneActivePct: number | null;
  noneVisits: number | null;
  noneVisitSharePct: number | null;
  topDistributorNormKey: string | null;
  topDistributorName: string | null;
  topDistributorObPct: number | null;
  effectiveDistributors: number | null;
  effectiveRetailers: number | null;
  coverageGapDistricts: number;
  coverageGapRetailers: number;
  coverageGapPriorYearOb: number;
  assignmentGapDistricts: number;
  assignmentGapRetailers: number;
  assignmentGapPriorYearOb: number;
};

type MemberDistributorRow = {
  name: string;
  normKey: string;
  state: string;
  isLeft: boolean;
  totalRetailers: number;
  removedCount: number;
  namedCount: number;
  noneCount: number;
  blankCount: number;
  sharedCount: number;
  blankOb?: number;
  noneSharePct: number | null;
  namedActivePct: number | null;
  noneActivePct: number | null;
  noneVisits: number | null;
  noneVisitSharePct: number | null;
  achievementTotal: number | null;
};

type NamingCandidate = {
  a: string;
  b: string;
  normA: string;
  normB: string;
  similarity: number;
};

// ── D5: Territory whitespace types ───────────────────────────────────────────

type WhitespaceNoneRetailer = {
  name: string;
  ob: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
};

type DistrictStat = {
  district: string;
  hasDistributor: boolean;
  distributorNames: string[];
  coveredCount: number;
  directCount: number;
  noneCount: number;
  totalCount: number;
  coveredOb: number;
  directOb: number;
  noneOb: number;
  priorYearOb: number;
  coveredVisits: number | null;
  directVisits: number | null;
  noneVisits: number | null;
  totalVisits: number | null;
  gapType: "coverage" | "assignment" | "both" | "none";
  isChannelConflict: boolean;
  noneRetailers: WhitespaceNoneRetailer[];
};

type ChannelConflictEntry = {
  name: string;
  district: string;
  ob: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
};

type TerritoryWhitespace = {
  districtStats: DistrictStat[];
  totalAssignmentGapRetailers: number;
  totalAssignmentGapDistricts: number;
  totalCoverageGapRetailers: number;
  totalCoverageGapDistricts: number;
  coverageGapPriorYearOb: number;
  coverageGapCurrentOb: number;
  coverageGapVisits: number;
  channelConflictCount: number;
  channelNonConflictCount: number;
  channelConflictEntries: ChannelConflictEntry[];
};

// ── D6: Customer concentration types ─────────────────────────────────────────

type TopCustomerEntry = {
  rank: number;
  name: string;
  orderBooking: number;
  sharePct: number;
  cumulativePct: number;
  visits: number | null;
  channel: string;
  isDirectDealer: boolean;
};

type CustomerStateGroup = {
  state: "retained" | "reactivated" | "at_risk" | "never";
  label: string;
  count: number;
  obThisYear: number;
  obLastYear: number;
  visits: number | null;
  bizPerVisit: number | null;
  visitSharePct: number | null;
  obSharePct: number | null;
};

type CustomerConcentration = {
  totalOb: number;
  totalVisits: number | null;
  overallBizPerVisit: number | null;
  top5Ob: number;
  top5SharePct: number | null;
  top10Ob: number;
  top10SharePct: number | null;
  topCustomers: TopCustomerEntry[];
  customerStates: CustomerStateGroup[];
  dataCutoffLabel: string;
  dataCutoffMonthsElapsed: number;
  newRetailersOnboarded: number | null;
  newPartyOrderBooking: number | null;
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
  membersFailed?: number; // absent in snapshots saved before Aug 2026
  whitespace: TerritoryWhitespace | null;
  concentration: CustomerConcentration | null;
  capacityCheck: CapacityCheck | null;
  /** SD2: per-state classification and activity breakdown. */
  byState?: StateDistributorRow[];
  /** SD2: per-member unassigned analysis (all members). */
  perMember?: MemberDistributorRow[];
  /** SD2: Pearson r between noneSharePct and achievementTotal (active members). */
  unassignedCorrelation?: number | null;
  /** SD2: candidate near-duplicate distributor name pairs (Jaccard trigram > 0.6). */
  namingCandidates?: NamingCandidate[];
  error: string | null;
  /** True when the server served the last saved snapshot because Google Sheets
   *  was briefly busy — figures may be slightly out of date. */
  stale?: boolean;
  refreshing?: boolean;
};

// ── Distributor directory (filter-chain index) ───────────────────────────────

type DirectoryDistributor = {
  name: string;
  normKey: string;
  states: string[];   // canonical geographic states (serving members' states)
  heads: string[];
  retailerCount: number;
  activeCount: number;
  orderBooking: number;
  sale: number;
};

type DirectoryHead = {
  name: string;
  states: string[];
  distributorCount: number;
  orderBooking: number;
  stale: boolean;
  failed: boolean;
};

type DistributorDirectory = {
  fy: string;
  basis: string;
  basisLabel: string;
  states: string[];
  heads: DirectoryHead[];
  distributors: DirectoryDistributor[];
};

// ── API ──────────────────────────────────────────────────────────────────────

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
const FY_OPTIONS = ["2026-27", "2025-26", "2024-25", "2023-24"];
const CONCENTRATION_THRESHOLD = 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number | null): string {
  if (n === null) return "--";
  return trunc2(n) + "%";
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
                  ? `${trunc2(flows.fillRate)}% fill rate`
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
              {flows.ordersPerMonth !== null ? trunc2(flows.ordersPerMonth) : "--"}
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
                  {flows.growthPct >= 0 ? "+" : ""}{trunc2(flows.growthPct)}%
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

        {spread.liveYearNote && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
            {spread.liveYearNote}
          </div>
        )}

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
              {spread.crossSellDepth != null ? trunc2(spread.crossSellDepth) : "--"}
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
                    <span className="text-muted-foreground ml-1">{trunc2(seg.pct)}%</span>
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

// ── D5: Territory whitespace panel ───────────────────────────────────────────

const GAP_BADGE: Record<DistrictStat["gapType"], { label: string; cls: string }> = {
  coverage:   { label: "COVERAGE GAP",   cls: "bg-red-100    text-red-800    border border-red-200"    },
  assignment: { label: "ASSIGNMENT GAP", cls: "bg-amber-100  text-amber-800  border border-amber-200"  },
  both:       { label: "COVERAGE GAP",   cls: "bg-red-100    text-red-800    border border-red-200"    },
  none:       { label: "Covered",         cls: "bg-green-100  text-green-800  border border-green-200"  },
};

function WhitespacePanel({ whitespace }: { whitespace: TerritoryWhitespace }) {
  const [showNone, setShowNone] = useState<string | null>(null);

  const hasAnyGap =
    whitespace.totalAssignmentGapRetailers > 0 || whitespace.totalCoverageGapRetailers > 0;

  return (
    <SectionCard title="Territory Whitespace">
      <div className="space-y-5">

        {/* ── Two-gap summary callouts ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Assignment gap */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-1">
              Assignment Gap
            </div>
            <div className="text-2xl font-bold text-amber-900 tabular-nums">
              {whitespace.totalAssignmentGapRetailers}
              <span className="text-sm font-normal text-amber-700 ml-1">retailers</span>
            </div>
            <div className="text-sm text-amber-800 mt-1">
              {whitespace.totalAssignmentGapDistricts === 0
                ? "No assignment gap"
                : `Across ${whitespace.totalAssignmentGapDistricts} district${whitespace.totalAssignmentGapDistricts > 1 ? "s" : ""} that already have a distributor.`}
            </div>
            <div className="text-xs text-amber-600 mt-2 font-medium">
              Fix: assign to existing distributor — administrative, immediate.
            </div>
          </div>

          {/* Coverage gap */}
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-red-700 mb-1">
              Coverage Gap
            </div>
            <div className="text-2xl font-bold text-red-900 tabular-nums">
              {whitespace.totalCoverageGapRetailers}
              <span className="text-sm font-normal text-red-700 ml-1">retailers</span>
            </div>
            {whitespace.totalCoverageGapDistricts > 0 ? (
              <div className="text-sm text-red-800 mt-1">
                {whitespace.totalCoverageGapDistricts} district{whitespace.totalCoverageGapDistricts > 1 ? "s" : ""} with
                no distributor.{" "}
                {whitespace.coverageGapPriorYearOb > 0 && (
                  <span className="font-medium">
                    {formatINR(whitespace.coverageGapPriorYearOb)} prior-year demand,{" "}
                    {whitespace.coverageGapVisits} visits already spent.
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-red-800 mt-1">No coverage gap.</div>
            )}
            <div className="text-xs text-red-600 mt-2 font-medium">
              Fix: appoint a distributor — strategic, takes time.
            </div>
          </div>
        </div>

        {/* ── District table ── */}
        {whitespace.districtStats.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-3 font-medium">District</th>
                  <th className="text-right py-2 pr-3 font-medium">Total</th>
                  <th className="text-right py-2 pr-3 font-medium">Covered</th>
                  <th className="text-right py-2 pr-3 font-medium">Direct</th>
                  <th className="text-right py-2 pr-3 font-medium">Unassigned</th>
                  <th className="text-right py-2 pr-3 font-medium">Prior-Yr Demand</th>
                  <th className="text-right py-2 pr-3 font-medium">Current OB</th>
                  <th className="text-right py-2 pr-3 font-medium">Visits</th>
                  <th className="text-left py-2 font-medium">Gap / Distributors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {whitespace.districtStats.map((d) => {
                  const badge = GAP_BADGE[d.gapType];
                  const rowBg =
                    d.gapType === "coverage" || d.gapType === "both"
                      ? "bg-red-50/40"
                      : d.gapType === "assignment"
                      ? "bg-amber-50/40"
                      : "";
                  const currentOb = d.directOb + d.noneOb;
                  const totalVisitsVal =
                    (d.coveredVisits ?? 0) + (d.directVisits ?? 0) + (d.noneVisits ?? 0);

                  return (
                    <Fragment key={d.district}>
                      <tr className={`${rowBg}`}>
                        <td className="py-2 pr-3 font-medium">{d.district}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{d.totalCount}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                          {d.coveredCount}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {d.directCount > 0 ? (
                            <span className={d.isChannelConflict ? "text-orange-700 font-medium" : ""}>
                              {d.directCount}
                              {d.isChannelConflict && (
                                <AlertTriangle className="w-3 h-3 inline ml-0.5 mb-0.5" />
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {d.noneCount > 0 ? (
                            <button
                              className="text-amber-700 font-medium underline-offset-2 hover:underline"
                              onClick={() => setShowNone(showNone === d.district ? null : d.district)}
                            >
                              {d.noneCount}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {d.priorYearOb > 0 ? formatINR(d.priorYearOb) : "--"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                          {currentOb > 0 ? formatINR(currentOb) : "--"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                          {totalVisitsVal > 0 ? totalVisitsVal : "--"}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-col gap-1">
                            <span className={`inline-flex text-xs px-1.5 py-0.5 rounded font-medium w-fit ${badge.cls}`}>
                              {badge.label}
                            </span>
                            {d.distributorNames.length > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {d.distributorNames.join(", ")}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expandable unassigned retailer detail */}
                      {showNone === d.district && d.noneRetailers.length > 0 && (
                        <tr className="bg-amber-50/60">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="text-xs font-semibold text-amber-800 mb-2">
                              Unassigned retailers in {d.district} — visits spent, no supply route
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-muted-foreground">
                                  <th className="text-left pr-3 pb-1 font-medium">Retailer</th>
                                  <th className="text-right pr-3 pb-1 font-medium">Visits</th>
                                  <th className="text-right pr-3 pb-1 font-medium">Current OB</th>
                                  <th className="text-right pb-1 font-medium">Prior-Yr Demand</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-amber-200/50">
                                {d.noneRetailers.map((r) => (
                                  <tr key={r.name}>
                                    <td className="py-1 pr-3">{r.name}</td>
                                    <td className="py-1 pr-3 text-right tabular-nums">
                                      {r.visits != null ? r.visits : "--"}
                                    </td>
                                    <td className="py-1 pr-3 text-right tabular-nums">
                                      {r.ob > 0 ? formatINR(r.ob) : (
                                        <span className="text-muted-foreground">No orders</span>
                                      )}
                                    </td>
                                    <td className="py-1 text-right tabular-nums">
                                      {r.sale > 0 ? formatINR(r.sale) : "--"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="mt-2 text-xs text-amber-700">
                              A retailer with visits and no distributor cannot place orders through the
                              standard channel. This is a supply-mapping failure, not a sales-effort failure.
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Channel overlap ── */}
        {(whitespace.channelConflictCount > 0 || whitespace.channelNonConflictCount > 0) && (
          <div className="border border-border rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold">Channel Overlap</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
                <div className="font-semibold text-orange-800 mb-0.5">
                  {whitespace.channelConflictCount} structural conflict{whitespace.channelConflictCount !== 1 ? "s" : ""}
                </div>
                <div className="text-xs text-orange-700">
                  Direct dealers inside districts that have a distributor.
                  Channel integrity is at risk — each sale competes with distributor throughput.
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="font-semibold mb-0.5">
                  {whitespace.channelNonConflictCount} non-conflict
                </div>
                <div className="text-xs text-muted-foreground">
                  Direct dealers in districts with no distributor.
                  They are the only supply route — not a conflict.
                </div>
              </div>
            </div>

            {whitespace.channelConflictEntries.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-1.5 pr-3 font-medium">Direct Dealer</th>
                      <th className="text-left py-1.5 pr-3 font-medium">District</th>
                      <th className="text-right py-1.5 pr-3 font-medium">OB</th>
                      <th className="text-right py-1.5 pr-3 font-medium">Prior-Yr Demand</th>
                      <th className="text-right py-1.5 font-medium">Visits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {whitespace.channelConflictEntries.map((e) => (
                      <tr key={e.name + e.district} className="text-muted-foreground">
                        <td className="py-1.5 pr-3 font-medium text-foreground">{e.name}</td>
                        <td className="py-1.5 pr-3">{e.district}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {e.ob > 0 ? formatINR(e.ob) : "--"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {e.sale > 0 ? formatINR(e.sale) : "--"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {e.visits != null ? e.visits : "--"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!hasAnyGap && whitespace.channelConflictCount === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4">
            All retailers are assigned to a distributor. No territory gaps detected.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── D6: Customer concentration panel ─────────────────────────────────────────

const STATE_STYLE: Record<CustomerStateGroup["state"], { border: string; bg: string; label: string }> = {
  retained:    { border: "border-green-200",  bg: "bg-green-50",  label: "Retained"    },
  reactivated: { border: "border-blue-200",   bg: "bg-blue-50",   label: "Reactivated" },
  at_risk:     { border: "border-amber-200",  bg: "bg-amber-50",  label: "At Risk"     },
  never:       { border: "border-slate-200",  bg: "bg-slate-50",  label: "Never"       },
};

const STATE_OB_LABEL: Record<CustomerStateGroup["state"], string> = {
  retained:    "OB this year",
  reactivated: "OB this year",
  at_risk:     "OB last year",
  never:       "--",
};

function CustomerConcentrationPanel({ c }: { c: CustomerConcentration }) {
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const visibleCustomers = showAllCustomers ? c.topCustomers : c.topCustomers.slice(0, 5);

  const totalVisits = c.totalVisits ?? null;

  return (
    <SectionCard title="Customer Concentration">
      <div className="space-y-5">

        {/* ── Cutoff note ───────────────────────────────────────────── */}
        <div className="text-xs text-muted-foreground">
          Data through {c.dataCutoffLabel} ({c.dataCutoffMonthsElapsed} month{c.dataCutoffMonthsElapsed !== 1 ? "s" : ""} elapsed).
          {(c.newRetailersOnboarded != null || c.newPartyOrderBooking != null) && (
            <span className="ml-2">
              New retailers this year:{" "}
              <span className="font-medium text-foreground">
                {c.newRetailersOnboarded ?? "--"}
              </span>
              {c.newPartyOrderBooking != null && c.newPartyOrderBooking > 0 && (
                <span className="ml-1">
                  ({formatINR(c.newPartyOrderBooking)} OB)
                </span>
              )}
            </span>
          )}
        </div>

        {/* ── Concentration summary bar ─────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            { label: "Top 5 share",  pct: c.top5SharePct,  ob: c.top5Ob  },
            { label: "Top 10 share", pct: c.top10SharePct, ob: c.top10Ob },
            { label: "Total OB",     pct: null,             ob: c.totalOb },
          ].map(({ label, pct: p, ob }) => (
            <div key={label} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
              <div className="font-semibold text-sm tabular-nums">{formatINR(ob)}</div>
              {p != null && (
                <div className={`text-xs font-medium mt-0.5 ${p >= 60 ? "text-amber-600" : "text-muted-foreground"}`}>
                  {trunc2(p)}%
                  {p >= 60 && <AlertTriangle className="inline w-3 h-3 ml-0.5 mb-0.5" />}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Top customers table ───────────────────────────────────── */}
        {c.topCustomers.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Top customers by order booking
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left py-1.5 pr-3 font-medium w-6">#</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Customer</th>
                    <th className="text-left py-1.5 pr-3 font-medium hidden sm:table-cell">Channel</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Order Booking</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Share</th>
                    <th className="text-right py-1.5 font-medium">Cumulative</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {visibleCustomers.map((row) => (
                    <tr key={row.rank} className="text-xs">
                      <td className="py-1.5 pr-3 text-muted-foreground tabular-nums">{row.rank}</td>
                      <td className="py-1.5 pr-3 font-medium">
                        {row.name}
                        {row.isDirectDealer && (
                          <span className="ml-1.5 text-[10px] text-amber-600 font-normal">direct</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground hidden sm:table-cell">{row.channel}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatINR(row.orderBooking)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{trunc2(row.sharePct)}%</td>
                      <td className={`py-1.5 text-right tabular-nums font-medium ${row.cumulativePct >= 60 ? "text-amber-600" : "text-muted-foreground"}`}>
                        {trunc2(row.cumulativePct)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.topCustomers.length > 5 && (
              <button
                className="mt-2 text-xs text-primary hover:underline flex items-center gap-1"
                onClick={() => setShowAllCustomers((v) => !v)}
              >
                {showAllCustomers ? (
                  <><ChevronDown className="w-3 h-3 rotate-180" />Show top 5 only</>
                ) : (
                  <><ChevronRight className="w-3 h-3" />Show top {c.topCustomers.length}</>
                )}
              </button>
            )}
          </div>
        )}

        {/* ── Customer lifecycle grid ───────────────────────────────── */}
        {c.customerStates.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Repeat vs. new business
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {c.customerStates.map((sg) => {
                const style = STATE_STYLE[sg.state];
                const obVal = sg.state === "at_risk" ? sg.obLastYear : sg.obThisYear;
                const obLabel = STATE_OB_LABEL[sg.state];
                return (
                  <div key={sg.state} className={`rounded-lg border ${style.border} ${style.bg} px-3 py-2.5`}>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70 mb-1">
                      {style.label}
                    </div>
                    <div className="text-xl font-bold tabular-nums">{sg.count}</div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {sg.state !== "never" && obVal > 0 && (
                        <div>{obLabel}: <span className="font-medium text-foreground">{formatINR(obVal)}</span></div>
                      )}
                      {sg.visits != null && sg.visits > 0 && (
                        <div>
                          {sg.visits} visit{sg.visits !== 1 ? "s" : ""}
                          {sg.visitSharePct != null && ` (${trunc2(sg.visitSharePct)}%)`}
                        </div>
                      )}
                      {sg.bizPerVisit != null && sg.bizPerVisit > 0 && totalVisits != null && (
                        <div>{formatINR(sg.bizPerVisit)}/visit</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Effort-vs-return note ─────────────────────────────── */}
            {(() => {
              const reactivated = c.customerStates.find((s) => s.state === "reactivated");
              const retained    = c.customerStates.find((s) => s.state === "retained");
              if (
                reactivated?.bizPerVisit != null &&
                retained?.bizPerVisit != null &&
                reactivated.bizPerVisit > retained.bizPerVisit
              ) {
                return (
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
                    <TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Reactivated customers yield{" "}
                      <span className="font-medium">{formatINR(reactivated.bizPerVisit)}/visit</span>
                      {" "}vs{" "}
                      <span className="font-medium">{formatINR(retained.bizPerVisit)}/visit</span>
                      {" "}for retained — recovery visits are high-return.
                    </span>
                  </div>
                );
              }
              const atRisk = c.customerStates.find((s) => s.state === "at_risk");
              if (atRisk && atRisk.count > 0 && atRisk.obLastYear > 0) {
                return (
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      {atRisk.count} customer{atRisk.count !== 1 ? "s" : ""} with{" "}
                      <span className="font-medium">{formatINR(atRisk.obLastYear)}</span>
                      {" "}prior-year OB have no booking yet this year (cutoff: {c.dataCutoffLabel}).
                    </span>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        )}

      </div>
    </SectionCard>
  );
}

// ── D4: Investment, ROI and tier panel ───────────────────────────────────────

const TIER_COLOR: Record<"A" | "B" | "C", string> = {
  A: "bg-emerald-100 text-emerald-800 border border-emerald-200",
  B: "bg-amber-100  text-amber-800  border border-amber-200",
  C: "bg-red-100    text-red-800    border border-red-200",
};

function AddSourceBox({ label }: { label: string }) {
  return (
    <div className="rounded border border-dashed border-border p-3 text-center">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">No source connected</p>
    </div>
  );
}

function InvestmentPanel({
  investment,
  distNormKey,
  distName,
  stateHead,
  fy,
  onOverrideSaved,
}: {
  investment?: DistributorInvestment;
  distNormKey: string;
  distName: string;
  stateHead: string;
  fy: string;
  onOverrideSaved?: () => void;
}) {
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  if (!investment) return null;

  const { tier, effectiveDiscount: disc, costToServe: cts, roi } = investment;

  const fmtL = (v: number) => "Rs " + trunc2((v / 100_000)) + "L";
  const fmtPct = (v: number) => trunc2(v) + " %";

  return (
    <div className="mt-3 border-t border-border pt-3">
      {/* Tier header */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${TIER_COLOR[tier.tier]}`}>
          Tier {tier.tier}
        </span>
        <span className="text-xs text-muted-foreground">
          Score {tier.score} / 100
        </span>
        {tier.isOverridden && (
          <span className="text-xs px-2 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">
            Overridden
          </span>
        )}
      </div>

      {/* 3 metric tiles */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {/* Effective discount */}
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5 uppercase tracking-wide">
            Effective discount
          </p>
          {disc ? (
            <>
              <p className="text-sm font-semibold tabular-nums">
                {fmtPct(disc.weightedDiscountPct)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Net {fmtL(disc.netTotal)} / {disc.recentFy}
              </p>
              {disc.abovePeerMedian && disc.peerMedianDiscountPct != null && (
                <p className="text-[10px] text-amber-700 mt-0.5">
                  Above peer median ({fmtPct(disc.peerMedianDiscountPct)})
                </p>
              )}
              {disc.hasAnomalousLines && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Some anomalous lines excluded
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">Live FY — not yet available</p>
          )}
        </div>

        {/* Cost to serve */}
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5 uppercase tracking-wide">
            Cost to serve
          </p>
          {cts ? (
            <>
              <p className="text-sm font-semibold tabular-nums">
                {fmtL(cts.visitCostToServe)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {cts.distributorVisits} visits × Rs{" "}
                {Math.round(cts.memberCostPerVisit).toLocaleString("en-IN")} / visit
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">Visit or CTC data unavailable</p>
          )}
        </div>

        {/* Revenue / Cost ROI */}
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5 uppercase tracking-wide">
            NET / Cost (ROI)
          </p>
          {roi ? (
            <>
              <p className="text-sm font-semibold tabular-nums">
                {trunc2(roi.netToCostMultiple)}x
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {fmtL(roi.netRevenue)} net / {fmtL(roi.visitCostToServe)} cost
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">Needs cost and NET data</p>
          )}
        </div>
      </div>

      {/* Credit / Scheme — add-a-source */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <AddSourceBox label="Credit outstanding" />
        <AddSourceBox label="Scheme payouts" />
      </div>

      {/* Tier cadence + posture */}
      <div className="text-[11px] text-muted-foreground space-y-0.5 mb-2">
        <p><span className="font-medium">Visit cadence:</span> {tier.visitCadence}</p>
        <p><span className="font-medium">Credit posture:</span> {tier.creditPosture}</p>
      </div>

      {/* D7: Numeric cadence plan */}
      <div className="text-[11px] border border-border rounded p-2 mb-2 grid grid-cols-2 gap-x-4">
        <p>
          <span className="font-medium">Distributor visits/month:</span>{" "}
          {tier.cadenceDistributorPerMonth}
        </p>
        <p>
          <span className="font-medium">Retailer visits demanded/month:</span>{" "}
          {tier.cadenceRetailerPerMonth}
        </p>
      </div>

      {/* D7: Range focus */}
      <div className="mb-3">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Range focus
        </p>
        <ul className="space-y-0.5">
          {tier.rangeFocus.map((action, i) => (
            <li key={i} className="text-[11px] flex gap-1.5 items-start">
              <span className="text-muted-foreground shrink-0">-</span>
              <span>{action}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* D7: Override reason (when active) */}
      {tier.isOverridden && tier.overrideReason && (
        <p className="text-[11px] text-violet-700 mb-2">
          <span className="font-medium">Override reason:</span> {tier.overrideReason}
        </p>
      )}

      {/* Scoring breakdown (collapsible would be ideal, but keep it simple for now) */}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
          Score breakdown
        </summary>
        <table className="w-full mt-1 border-collapse">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1 pr-3 font-medium">Input</th>
              <th className="py-1 pr-3 font-medium text-right">Value</th>
              <th className="py-1 pr-3 font-medium text-right">Score</th>
              <th className="py-1 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {tier.inputs.map((inp) => (
              <tr key={inp.label} className="border-b border-border/40">
                <td className="py-1 pr-3 text-muted-foreground">{inp.label}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{inp.value}</td>
                <td className="py-1 pr-3 text-right tabular-nums font-medium">{inp.score}</td>
                <td className="py-1 text-muted-foreground">{inp.note}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-1 pr-3 font-semibold text-right">Total</td>
              <td className="py-1 pr-3 text-right tabular-nums font-bold">{tier.score}</td>
              <td className="py-1 text-muted-foreground">→ Tier {tier.tier}</td>
            </tr>
          </tbody>
        </table>
        {disc?.sampleLineGross != null && (
          <p className="mt-1.5 text-muted-foreground">
            Discount check: Rs {trunc2(disc.sampleLineGross)} gross × (1 −{" "}
            {disc.sampleLineDiscountPct != null ? trunc2(disc.sampleLineDiscountPct) : "--"} %) = Rs{" "}
            {disc.sampleLineComputed != null ? trunc2(disc.sampleLineComputed) : "--"}{" "}
            (registered: Rs {disc.sampleLineNet != null ? trunc2(disc.sampleLineNet) : "--"})
          </p>
        )}
      </details>

      {/* D7: Override tier button / inline form */}
      {!showOverrideForm ? (
        <button
          onClick={() => setShowOverrideForm(true)}
          className="mt-3 text-[11px] text-muted-foreground hover:text-foreground underline"
        >
          {tier.isOverridden ? "Change or remove override" : "Override tier"}
        </button>
      ) : (
        <TierOverrideForm
          distNormKey={distNormKey}
          distName={distName}
          currentTier={tier.tier}
          isCurrentlyOverridden={tier.isOverridden}
          stateHead={stateHead}
          fy={fy}
          onSaved={() => { setShowOverrideForm(false); onOverrideSaved?.(); }}
          onCancel={() => setShowOverrideForm(false)}
        />
      )}
    </div>
  );
}

// ── D7: Tier override form ────────────────────────────────────────────────────

function TierOverrideForm({
  distNormKey,
  distName,
  currentTier,
  isCurrentlyOverridden,
  stateHead,
  fy,
  onSaved,
  onCancel,
}: {
  distNormKey: string;
  distName: string;
  currentTier: "A" | "B" | "C";
  isCurrentlyOverridden: boolean;
  stateHead: string;
  fy: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [tier, setTier] = useState<"A" | "B" | "C">(currentTier);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!reason.trim()) { setError("Reason is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mgmt/distributor-tier-override`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy, stateHead, normKey: distNormKey, tier, reason: reason.trim() }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mgmt/distributor-tier-override`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy, stateHead, normKey: distNormKey }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded p-3 mt-3 bg-muted/20">
      <p className="text-xs font-medium mb-2">Override tier for {distName}</p>
      <div className="flex gap-2 mb-2">
        {(["A", "B", "C"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={`px-3 py-1 rounded text-xs font-bold border transition-colors ${
              tier === t
                ? TIER_COLOR[t] + " border-transparent"
                : "border-border text-muted-foreground hover:border-foreground/40"
            }`}
          >
            Tier {t}
          </button>
        ))}
      </div>
      <textarea
        className="w-full text-xs border border-border rounded p-2 bg-background resize-none"
        rows={2}
        placeholder="Reason for override (required)"
        value={reason}
        onChange={(e) => { setReason(e.target.value); setError(null); }}
      />
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      <div className="flex gap-2 mt-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs px-3 py-1 rounded bg-foreground text-background font-medium disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save override"}
        </button>
        {isCurrentlyOverridden && (
          <button
            onClick={handleRemove}
            disabled={saving}
            className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Remove override
          </button>
        )}
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded border border-border text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── D7: Retailer concentration bar (per distributor, own retailers only) ──────

function RetailerConcentrationBar({ rc }: { rc: RetailerConcentration }) {
  if (rc.totalOb === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
        Retailer concentration (within this distributor)
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5">Top account</p>
          <p className={`text-sm font-semibold tabular-nums ${
            (rc.topRetailerSharePct ?? 0) > 60 ? "text-amber-600" : ""
          }`}>
            {rc.topRetailerSharePct != null ? trunc2(rc.topRetailerSharePct) + "%" : "--"}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate" title={rc.topRetailerName ?? ""}>
            {rc.topRetailerName ?? "--"}
          </p>
        </div>
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5">Top-5 share</p>
          <p className={`text-sm font-semibold tabular-nums ${
            (rc.top5SharePct ?? 0) > 80 ? "text-amber-600" : ""
          }`}>
            {rc.top5SharePct != null ? trunc2(rc.top5SharePct) + "%" : "--"}
          </p>
        </div>
        <div className="rounded bg-muted/40 p-2">
          <p className="text-[10px] text-muted-foreground mb-0.5">Top-10 share</p>
          <p className="text-sm font-semibold tabular-nums">
            {rc.top10SharePct != null ? trunc2(rc.top10SharePct) + "%" : "--"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── D7: Capacity check panel (territory level) ────────────────────────────────

function CapacityCheckPanel({ check }: { check: CapacityCheck }) {
  const { isFyClosedValue } = useGlobalFilter();
  const [showBreakdown, setShowBreakdown] = useState(false);
  return (
    <div className={`rounded-lg border p-4 mb-4 ${
      check.hasShortfall ? "border-amber-300 bg-amber-50/40" : "border-border"
    }`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold">Visit Capacity Check</p>
        {check.hasShortfall ? (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
            Shortfall
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
            Within capacity
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 text-center mb-3">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
            Available / month
          </p>
          <p className="text-xl font-bold tabular-nums">
            {check.availablePerMonth != null ? Math.round(check.availablePerMonth) : "--"}
          </p>
          <p className="text-[10px] text-muted-foreground">visits ({isFyClosedValue ? "FY" : "YTD"} rate)</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
            Demanded / month
          </p>
          <p className={`text-xl font-bold tabular-nums ${check.hasShortfall ? "text-amber-600" : ""}`}>
            {Math.round(check.demandedPerMonth)}
          </p>
          <p className="text-[10px] text-muted-foreground">visits (tier plan)</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
            Shortfall
          </p>
          <p className={`text-xl font-bold tabular-nums ${
            check.hasShortfall ? "text-red-600" : "text-emerald-600"
          }`}>
            {check.shortfallPerMonth != null ? Math.round(check.shortfallPerMonth) : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {check.hasShortfall ? "over capacity" : "on plan"}
          </p>
        </div>
      </div>
      <button
        onClick={() => setShowBreakdown((b) => !b)}
        className="text-[11px] text-muted-foreground hover:text-foreground underline"
      >
        {showBreakdown ? "Hide breakdown" : "Show per-distributor breakdown"}
      </button>
      {showBreakdown && (
        <table className="w-full text-xs mt-2 border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Distributor</th>
              <th className="py-1 pr-3 font-medium text-center">Tier</th>
              <th className="py-1 text-right font-medium">Retailer visits / month</th>
            </tr>
          </thead>
          <tbody>
            {check.breakdown.map((b) => (
              <tr key={b.normKey} className="border-b border-border/30">
                <td className="py-1 pr-3">{b.name}</td>
                <td className="py-1 pr-3 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${TIER_COLOR[b.tier]}`}>
                    {b.tier}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  {trunc2(b.demandedRetailerVisitsPerMonth)}
                </td>
              </tr>
            ))}
            <tr className="font-semibold border-t border-border">
              <td className="py-1 pr-3">Total</td>
              <td className="py-1 pr-3"></td>
              <td className="py-1 text-right tabular-nums">{trunc2(check.demandedPerMonth)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── SD2: Per-member unassigned analysis section ───────────────────────────────

function PerMemberAnalysisSection({ perMember }: { perMember: MemberDistributorRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const active = perMember.filter((m) => m.totalRetailers > 0).sort((a, b) => b.noneCount - a.noneCount);
  const left   = perMember.filter((m) => m.isLeft && m.totalRetailers > 0);

  return (
    <SectionCard title={`Per-Member Unassigned Analysis (${active.length} members with data${left.length > 0 ? `, ${left.length} departed` : ""})`}>
      <p className="text-xs text-muted-foreground mb-3 flex items-start gap-2">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        Shows every member whose working sheet was loaded. None% = share of retailers with '--' (unassigned).
        None Active = active rate among unassigned retailers. DD OB = order booking on this member's blank-distributor
        (direct dealer) rows — these sum to the territory's direct-dealer total. Removed = rows in the 'Removed Parties' section.
      </p>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mb-3 text-xs font-medium text-primary underline-offset-2 hover:underline flex items-center gap-1"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {expanded ? "Collapse" : "Expand member table"}
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left py-2 pr-3 font-medium">Member</th>
                <th className="text-left py-2 pr-3 font-medium">State</th>
                <th className="text-right py-2 pr-3 font-medium">Retail</th>
                <th className="text-right py-2 pr-3 font-medium">None%</th>
                <th className="text-right py-2 pr-3 font-medium">None Active</th>
                <th className="text-right py-2 pr-3 font-medium">Named Active</th>
                <th className="text-right py-2 pr-3 font-medium">Achievement</th>
                <th className="text-right py-2 pr-3 font-medium">DD OB</th>
                <th className="text-right py-2 font-medium">Removed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {active.map((m) => (
                <tr key={m.normKey} className={`hover:bg-muted/30 ${m.isLeft ? "opacity-60" : ""}`}>
                  <td className="py-1.5 pr-3 font-medium text-xs">
                    {m.name}
                    {m.isLeft && <span className="ml-1 text-muted-foreground">(left)</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-muted-foreground">{m.state}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-xs">{m.totalRetailers}</td>
                  <td className={`py-1.5 pr-3 text-right tabular-nums text-xs font-medium ${
                    m.noneSharePct != null && m.noneSharePct > 60 ? "text-amber-600" : "text-muted-foreground"
                  }`}>
                    {pct(m.noneSharePct)}
                  </td>
                  <td className={`py-1.5 pr-3 text-right tabular-nums text-xs ${
                    m.noneActivePct != null && m.noneActivePct > 20 ? "text-amber-600" : "text-muted-foreground"
                  }`}>
                    {pct(m.noneActivePct)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-emerald-700">
                    {pct(m.namedActivePct)}
                  </td>
                  <td className={`py-1.5 pr-3 text-right tabular-nums text-xs ${
                    m.achievementTotal != null ? achBandText(m.achievementTotal) : ""
                  }`}>
                    {m.achievementTotal != null ? pct(m.achievementTotal) : "--"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-muted-foreground">
                    {m.blankOb != null && m.blankOb > 0 ? formatINR(m.blankOb) : "--"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                    {m.removedCount > 0 ? m.removedCount : "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type GeoMode = "all" | "region" | "state";

export default function DistributorDeepDive() {
  const { fy }                    = useGlobalFilter();
  const [stateHead, setStateHead] = useState("");
  // ── Filter chain: Geography → Distributor → State Head ──────────────
  const [dir, setDir]             = useState<DistributorDirectory | null>(null);
  const [dirError, setDirError]   = useState<string | null>(null);
  const [geoMode, setGeoMode]     = useState<GeoMode>("all");
  const [selRegions, setSelRegions] = useState<string[]>([]);
  const [selStates, setSelStates]   = useState<string[]>([]);
  const [distFilter, setDistFilter] = useState("");
  const [data, setData]           = useState<DistributorDeepDiveResult | null>(null);
  const [loading, setLoading]     = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expandedDist, setExpandedDist] = useState<string | null>(null);
  // True while Google Sheets is briefly rate-limiting reads (503 quota);
  // a retry is scheduled automatically after the server's retryAfter hint.
  const [quotaWait, setQuotaWait] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Request generation counter: each user-initiated load bumps it, so a stale
  // quota retry (or late response) from an earlier selection never commits.
  const reqSeq = useRef(0);

  useEffect(() => {
    return () => {
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    };
  }, []);

  const load = useCallback(async (fyVal: string, stateHeadVal: string) => {
    const seq = ++reqSeq.current;
    // A new load supersedes any pending quota retry.
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    setQuotaWait(false);
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({ fy: fyVal });
      if (stateHeadVal) params.set("stateHead", stateHeadVal);
      const res = await fetch(`${API}/mgmt/distributor-deep-dive?${params}`);
      if (seq !== reqSeq.current) return; // superseded by a newer load
      const q = await quotaOrThrow(res);
      if (q) {
        setQuotaWait(true);
        retryTimer.current = setTimeout(
          () => load(fyVal, stateHeadVal),
          quotaDelayMs(q.retryAfter),
        );
        return;
      }
      const json: DistributorDeepDiveResult = await res.json();
      if (seq !== reqSeq.current) return;
      setData(json);
      // Snapshot served while the server rebuilds in the background — silently
      // refetch (no loading spinner) until the fresh figures land, max 3 tries.
      if (json.refreshing && stateHeadVal) {
        let tries = 0;
        const silentRefetch = async () => {
          if (seq !== reqSeq.current || tries >= 3) return;
          tries += 1;
          try {
            const r2 = await fetch(`${API}/mgmt/distributor-deep-dive?${params}`);
            if (seq !== reqSeq.current || !r2.ok) return;
            const j2: DistributorDeepDiveResult = await r2.json();
            if (seq !== reqSeq.current) return;
            if (j2.refreshing) {
              retryTimer.current = setTimeout(silentRefetch, 60_000);
            } else {
              setData(j2);
            }
          } catch {
            /* silent — the snapshot on screen is fine */
          }
        };
        retryTimer.current = setTimeout(silentRefetch, 75_000);
      }
      // Auto-populate state head from first available if the selector is empty.
      if (!stateHeadVal && json.stateHeads.length > 0) {
        setStateHead(json.stateHeads[0]);
      }
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setFetchError(err instanceof Error ? err.message : "Load failed");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  // Load the cross-head distributor directory (drives the filter chain).
  useEffect(() => {
    let cancelled = false;
    setDir(null);
    setDirError(null);
    fetch(`${API}/mgmt/distributor-directory?fy=${encodeURIComponent(fy)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Directory load failed (${res.status})`);
        const json: DistributorDirectory = await res.json();
        if (!cancelled) setDir(json);
      })
      .catch((err) => {
        if (!cancelled) setDirError(err instanceof Error ? err.message : "Directory load failed");
      });
    return () => { cancelled = true; };
  }, [fy]);

  // Reload whenever global FY changes.
  useEffect(() => {
    setData(null);
    setExpandedDist(null);
    if (stateHead) load(fy, stateHead);
  }, [fy]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStateHeadChange(next: string) {
    setStateHead(next);
    setData(null);
    setExpandedDist(null);
    if (next) load(fy, next);
  }

  function toggleDist(normKey: string) {
    setExpandedDist((prev) => (prev === normKey ? null : normKey));
  }

  // ── Geography resolution ─────────────────────────────────────────────
  // null = All India (no state restriction); otherwise a canonical-state set.
  const geoStates: Set<string> | null = (() => {
    if (geoMode === "region") {
      const s = new Set<string>();
      for (const g of REGION_GROUPS) {
        if (selRegions.includes(g.region)) for (const st of g.states) s.add(st);
      }
      return s.size ? s : null;
    }
    if (geoMode === "state") {
      return selStates.length ? new Set(selStates) : null;
    }
    return null;
  })();

  const inGeo = (states: string[]): boolean =>
    geoStates === null || states.some((s) => geoStates.has(s));

  const headsInGeo = (dir?.heads ?? []).filter((h) => inGeo(h.states));
  const distsInGeo = (dir?.distributors ?? []).filter(
    (d) => inGeo(d.states) && (!distFilter || d.normKey === distFilter),
  );
  // Heads offered in the third filter: heads serving the geography (and, when a
  // distributor is picked, heads whose teams serve that distributor).
  const headOptions = headsInGeo.filter(
    (h) => !distFilter || distsInGeo.some((d) => d.heads.includes(h.name)),
  );
  const headsIncluded = stateHead
    ? headOptions.filter((h) => h.name === stateHead)
    : headOptions;

  // Keep an invalidated head selection from sticking when the geography changes.
  useEffect(() => {
    if (stateHead && dir && !headOptions.some((h) => h.name === stateHead)) {
      setStateHead("");
      setData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoMode, selRegions.join("|"), selStates.join("|"), distFilter, dir]);

  const geoLabel =
    geoMode === "all" || geoStates === null
      ? "All India"
      : geoMode === "region"
        ? selRegions.join(" + ")
        : selStates.join(", ");

  // Directory states → picker options (canonical, one entry per geographic state).
  const stateOptions = dir?.states ?? [];
  const distStatesByKey = new Map((dir?.distributors ?? []).map((d) => [d.normKey, d.states]));

  const hasConcentrationRisk = data?.distributors.some((d) => d.isConcentrationRisk) ?? false;

  // In the single-head detail view, the geography + distributor filters still
  // narrow the distributor table (states come from the directory).
  const detailDistributors = (data?.distributors ?? []).filter((d) => {
    if (distFilter && d.normKey !== distFilter) return false;
    if (geoStates === null) return true;
    const states = distStatesByKey.get(d.normKey);
    return !states || states.some((s) => geoStates.has(s));
  });

  return (
    <div className="space-y-6">
      {/* ── Filter chain: Geography → Distributor → State Head ─────── */}
      <div className="flex flex-wrap gap-3 items-end">
        {/* 1. Geography */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">1 · Geography</label>
          <div className="flex items-center gap-2">
            <select
              value={geoMode}
              onChange={(e) => {
                const m = e.target.value as GeoMode;
                setGeoMode(m);
                if (m === "all") { setSelRegions([]); setSelStates([]); }
              }}
              className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="select-geo-mode"
            >
              <option value="all">All India</option>
              <option value="region">Region</option>
              <option value="state">State</option>
            </select>
            {geoMode === "region" && (
              <div className="flex items-center gap-1.5">
                {REGION_GROUPS.map((g) => (
                  <button
                    key={g.region}
                    onClick={() =>
                      setSelRegions((prev) =>
                        prev.includes(g.region)
                          ? prev.filter((r) => r !== g.region)
                          : [...prev, g.region],
                      )
                    }
                    className={`px-2.5 py-1.5 rounded-md text-sm border ${
                      selRegions.includes(g.region)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-muted-foreground hover:bg-muted/40"
                    }`}
                    data-testid={`button-region-${g.region.toLowerCase()}`}
                  >
                    {g.region}
                  </button>
                ))}
              </div>
            )}
            {geoMode === "state" && (
              <>
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v && !selStates.includes(v)) setSelStates((p) => [...p, v]);
                  }}
                  className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring min-w-[160px]"
                  data-testid="select-add-state"
                >
                  <option value="">Add state…</option>
                  {stateOptions
                    .filter((s) => !selStates.includes(s))
                    .map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                </select>
                {/* Convenience: a head's states → the state multi-select (stays editable as states) */}
                <select
                  value=""
                  onChange={(e) => {
                    const h = (dir?.heads ?? []).find((x) => x.name === e.target.value);
                    if (h) setSelStates((p) => [...new Set([...p, ...h.states])]);
                  }}
                  className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="select-head-states"
                >
                  <option value="">+ a head's states…</option>
                  {(dir?.heads ?? []).map((h) => (
                    <option key={h.name} value={h.name}>{h.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
          {geoMode === "state" && selStates.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {selStates.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
                >
                  {s}
                  <button
                    onClick={() => setSelStates((p) => p.filter((x) => x !== s))}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${s}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 2. Distributor (filtered to geography, ordered by net) */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">2 · Distributor</label>
          <select
            value={distFilter}
            onChange={(e) => setDistFilter(e.target.value)}
            className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring min-w-[220px] max-w-[340px]"
            disabled={!dir}
            data-testid="select-distributor"
          >
            <option value="">All distributors ({(dir?.distributors ?? []).filter((d) => inGeo(d.states)).length})</option>
            {(dir?.distributors ?? [])
              .filter((d) => inGeo(d.states))
              .map((d) => (
                <option key={d.normKey} value={d.normKey}>
                  {d.name} — {d.states.join("/") || "?"} — {formatINR(d.orderBooking)}
                </option>
              ))}
          </select>
        </div>

        {/* 3. State Head (narrows within the geography) */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">3 · State Head</label>
          <select
            value={stateHead}
            onChange={(e) => handleStateHeadChange(e.target.value)}
            className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring min-w-[180px]"
            disabled={!dir}
            data-testid="select-state-head"
          >
            <option value="">All heads serving selection ({headOptions.length})</option>
            {headOptions.map((h) => (
              <option key={h.name} value={h.name}>{h.name}</option>
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
            {(data.membersFailed ?? 0) > 0 && (
              <span className="text-amber-600 font-medium">
                {`, ${data.membersFailed} failed to load`}
              </span>
            )}
          </span>
        )}
      </div>

      {/* ── Active-selection header — every figure below is the product of
             three filters, so all three are stated in full. ─────────────── */}
      {dir && (
        <div
          className="rounded-md border border-border bg-muted/20 px-4 py-2.5 text-sm"
          data-testid="header-active-selection"
        >
          <span className="font-semibold">{geoLabel}</span>
          <span className="text-muted-foreground"> · </span>
          <span>
            {distFilter
              ? `1 distributor (${dir.distributors.find((d) => d.normKey === distFilter)?.name ?? distFilter})`
              : `${distsInGeo.length} distributors`}
          </span>
          <span className="text-muted-foreground"> · </span>
          <span>
            {headsIncluded.length === 1
              ? `Head: ${headsIncluded[0].name}`
              : `${headsIncluded.length} state heads (${headsIncluded.map((h) => h.name).join(", ")})`}
          </span>
          <span className="text-muted-foreground"> · FY {fy} · Party / secondary channel</span>
          <div className="text-xs text-muted-foreground mt-0.5">{dir.basisLabel}</div>
          {stateHead && (
            <div className="text-xs text-muted-foreground mt-0.5">
              Head detail below shows {stateHead}'s full team figures; the geography and
              distributor filters narrow the Distributor Overview table only.
            </div>
          )}
        </div>
      )}
      {dirError && (
        <div className="border border-destructive/40 bg-destructive/5 rounded-lg p-4 text-sm text-destructive">
          {dirError}
        </div>
      )}

      {/* Failed-sheets notice: Google Sheets choked on this pass — the page is
          incomplete, NOT unmapped. Distinct from the "not yet mapped" count. */}
      {data && !loading && (data.membersFailed ?? 0) > 0 && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/10 dark:text-amber-300"
          data-testid="banner-failed-sheets-distributor-deep-dive"
        >
          {data.membersFailed} member sheet{data.membersFailed !== 1 ? "s" : ""} could not be read
          on this pass (Google Sheets was busy) — the figures below are incomplete. Refresh in a
          minute to retry.
        </div>
      )}

      {/* ── Quota wait ─────────────────────────────────────────────── */}
      {quotaWait && <QuotaWaitBanner testId="banner-quota-wait-distributor-deep-dive" />}

      {/* Background-refresh notice: saved figures shown instantly, fresh ones on the way */}
      {data?.refreshing && !data?.stale && !fetchError && (
        <div
          className="rounded-md border border-sky-500/30 bg-sky-50/60 px-4 py-3 text-sm text-sky-800 dark:bg-sky-900/10 dark:text-sky-300"
          data-testid="banner-refreshing-distributor-deep-dive"
        >
          Showing saved figures — the latest are being fetched in the background and
          will appear automatically in a minute or two.
        </div>
      )}

      {/* Stale-snapshot notice: Sheets was briefly busy, showing saved figures */}
      {data?.stale && !fetchError && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/10 dark:text-amber-300"
          data-testid="banner-stale-distributor-deep-dive"
        >
          Figures are updating — showing the last saved snapshot while Google
          Sheets is briefly busy. Refresh in a minute for live figures.
        </div>
      )}

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

      {/* ── Multi-head overview (no single head selected) ───────────── */}
      {!stateHead && dir && (
        <SectionCard title={`Distributors — ${geoLabel} (${distsInGeo.length})`}>
          <p className="text-xs text-muted-foreground mb-3">
            Every head serving the selection is included. Pick a state head above for
            the full deep dive (flows, SKU spread, investment, whitespace).
            Ordered by order booking (net).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-distributor-overview">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs">
                  <th className="text-left py-2 pr-4 font-medium">Distributor</th>
                  <th className="text-left py-2 pr-4 font-medium">State(s)</th>
                  <th className="text-left py-2 pr-4 font-medium">State head(s)</th>
                  <th className="text-right py-2 pr-3 font-medium">Retailers</th>
                  <th className="text-right py-2 pr-3 font-medium">Active</th>
                  <th className="text-right py-2 pr-4 font-medium">Order Booking</th>
                  <th className="text-right py-2 font-medium">Sale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {distsInGeo.map((d) => (
                  <tr key={d.normKey} className="hover:bg-muted/30">
                    <td className="py-2 pr-4 font-medium">{d.name}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{d.states.join(", ") || "--"}</td>
                    <td className="py-2 pr-4 text-xs">{d.heads.join(", ")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{d.retailerCount}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{d.activeCount}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium">{formatINR(d.orderBooking)}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {d.sale > 0 ? formatINR(d.sale) : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold text-sm">
                  <td colSpan={3} className="py-2 pr-4 text-muted-foreground">Total</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {distsInGeo.reduce((s, d) => s + d.retailerCount, 0)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {distsInGeo.reduce((s, d) => s + d.activeCount, 0)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatINR(distsInGeo.reduce((s, d) => s + d.orderBooking, 0))}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </SectionCard>
      )}
      {!stateHead && !dir && !dirError && (
        <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm py-12">
          <Loader2 className="w-4 h-4 animate-spin" /> Building the distributor directory…
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
              <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                Source: member working sheet rows (excl. Removed Parties; shared retailers counted once)
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

          {/* ── D5: Territory whitespace ────────────────────────────── */}
          {data.whitespace && (
            <WhitespacePanel whitespace={data.whitespace} />
          )}

          {/* ── D6: Customer concentration ───────────────────────────── */}
          {data.concentration && (
            <CustomerConcentrationPanel c={data.concentration} />
          )}

          {/* ── D7: Visit capacity check ─────────────────────────────── */}
          {data.capacityCheck && (
            <CapacityCheckPanel check={data.capacityCheck} />
          )}

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
                    {detailDistributors.map((dist) => (
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
                              <InvestmentPanel
                                investment={dist.investment}
                                distNormKey={dist.normKey}
                                distName={dist.name}
                                stateHead={stateHead}
                                fy={fy}
                                onOverrideSaved={() => load(fy, stateHead)}
                              />
                              {dist.retailerConcentration && (
                                <RetailerConcentrationBar rc={dist.retailerConcentration} />
                              )}
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
                      <td colSpan={2} className="py-2 pr-4 text-muted-foreground">
                        {detailDistributors.length === data.distributors.length
                          ? "Party total"
                          : `Filtered total (${detailDistributors.length} of ${data.distributors.length})`}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {detailDistributors.reduce((s, d) => s + d.retailerCount, 0)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {detailDistributors.reduce((s, d) => s + d.activeCount, 0)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatINR(detailDistributors.reduce((s, d) => s + d.orderBooking, 0))}
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
                {/* Dashboard OB (authoritative — from Data tab directDealersOrder) */}
                {data.directDealer.dashboardOb != null && data.directDealer.dashboardOb > 0 && (
                  <div className="mb-3 px-3 py-2 rounded-md bg-emerald-50 border border-emerald-100 text-xs">
                    <span className="text-muted-foreground">Order Booking (Data tab)  </span>
                    <span className="font-semibold tabular-nums text-emerald-800">{formatINR(data.directDealer.dashboardOb)}</span>
                    {data.directDealer.dashboardMember && (
                      <span className="text-muted-foreground ml-1">— {data.directDealer.dashboardMember}</span>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Retailers", value: String(data.directDealer.retailerCount) },
                    { label: "Active",    value: String(data.directDealer.activeCount)   },
                    { label: "OB (sheet rows)", value: data.directDealer.orderBooking > 0 ? formatINR(data.directDealer.orderBooking) : "Rs 0" },
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

          {/* ── SD2: By-State Breakdown ─────────────────────────────── */}
          {data.byState && data.byState.length > 0 && (
            <SectionCard title="Retailer Distribution by State">
              {data.unassignedCorrelation != null && (
                <div className={`mb-3 px-3 py-2 rounded-md border text-xs flex items-start gap-2 ${
                  data.unassignedCorrelation < -0.6
                    ? "bg-amber-50 border-amber-200 text-amber-900"
                    : data.unassignedCorrelation < -0.3
                    ? "bg-yellow-50 border-yellow-200 text-yellow-900"
                    : "bg-muted/40 border-border text-muted-foreground"
                }`}>
                  <TrendingDown className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    Unassigned share vs achievement correlation:{" "}
                    <span className="font-semibold tabular-nums">r = {trunc2(data.unassignedCorrelation)}</span>
                    {data.unassignedCorrelation < -0.5
                      ? " — strong negative signal: members with more unassigned retailers tend to achieve significantly less."
                      : data.unassignedCorrelation < -0.3
                      ? " — moderate negative signal: members with more unassigned retailers tend to achieve somewhat less."
                      : " — weak signal; unassigned share does not strongly predict achievement in this territory."}
                    {" "}(Pearson r, active members with retailer data)
                  </span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-4 font-medium">State</th>
                      <th className="text-right py-2 pr-3 font-medium">Members</th>
                      <th className="text-right py-2 pr-3 font-medium">Retailers</th>
                      <th className="text-right py-2 pr-3 font-medium">None</th>
                      <th className="text-right py-2 pr-3 font-medium">None Active</th>
                      <th className="text-right py-2 pr-3 font-medium">Named Active</th>
                      <th className="text-right py-2 pr-3 font-medium">Eff. Distributors</th>
                      <th className="text-right py-2 pr-3 font-medium">Eff. Retailers</th>
                      <th className="text-right py-2 pr-3 font-medium">Coverage Gap</th>
                      <th className="text-right py-2 pr-3 font-medium">Assignment Gap</th>
                      <th className="text-left py-2 font-medium">Largest Distributor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.byState.map((s) => {
                      const noneShare = s.retailerCount > 0 ? (s.noneCount / s.retailerCount) * 100 : 0;
                      return (
                        <tr key={s.state} className="hover:bg-muted/30">
                          <td className="py-1.5 pr-4 font-medium">{s.state}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{s.memberCount}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{s.retailerCount.toLocaleString("en-IN")}</td>
                          <td className={`py-1.5 pr-3 text-right tabular-nums ${noneShare > 50 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>
                            {s.noneCount.toLocaleString("en-IN")}
                            <span className="text-xs ml-1">({trunc2(noneShare)}%)</span>
                          </td>
                          <td className={`py-1.5 pr-3 text-right tabular-nums ${
                            s.noneActivePct != null && s.noneActivePct > 15 ? "text-amber-600" : "text-muted-foreground"
                          }`}>
                            {pct(s.noneActivePct)}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-700">
                            {pct(s.namedActivePct)}
                          </td>
                          <td className={`py-1.5 pr-3 text-right tabular-nums ${
                            s.effectiveDistributors != null && s.effectiveDistributors < 2 ? "text-amber-600 font-semibold" : "text-muted-foreground"
                          }`}>
                            {s.effectiveDistributors != null ? trunc2(s.effectiveDistributors) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                            {s.effectiveRetailers != null ? trunc2(s.effectiveRetailers) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground text-xs">
                            {s.coverageGapDistricts > 0
                              ? <>{s.coverageGapRetailers.toLocaleString("en-IN")} ret / {s.coverageGapDistricts} dist</>
                              : <span className="opacity-40">—</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground text-xs">
                            {s.assignmentGapDistricts > 0
                              ? <>{s.assignmentGapRetailers.toLocaleString("en-IN")} ret / {s.assignmentGapDistricts} dist</>
                              : <span className="opacity-40">—</span>}
                          </td>
                          <td className="py-1.5 text-xs text-muted-foreground">
                            {s.topDistributorName
                              ? <>{s.topDistributorName}<span className="ml-1 text-foreground font-medium">{pct(s.topDistributorObPct)}</span></>
                              : <span className="opacity-40">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                None Active = active rate among unassigned (--) retailers. Named Active = active rate among distributor-assigned retailers.
                Eff. Distributors / Eff. Retailers = effective count (10,000 ÷ HHI on OB shares) — reads as "equivalent to N equally-sized players".
                Coverage Gap = retailers in districts with no distributor at all; Assignment Gap = unassigned retailers where a distributor already operates.
                Largest distributor share is of named-retailer OB in that state.
              </p>
            </SectionCard>
          )}

          {/* ── SD2: Near-duplicate distributor name candidates ──────── */}
          {data.namingCandidates && data.namingCandidates.length > 0 && (
            <SectionCard title={`Possible Duplicate Distributor Names (${data.namingCandidates.length})`}>
              <p className="text-xs text-muted-foreground mb-3 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                These distributor name pairs have high spelling similarity (Jaccard trigram &gt; 0.6).
                They may be the same entity entered differently across member sheets.
                Review before treating them as separate distributors. Never auto-merged.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-4 font-medium">Name A</th>
                      <th className="text-left py-2 pr-4 font-medium">Name B</th>
                      <th className="text-right py-2 font-medium">Similarity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.namingCandidates.map((c, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="py-1.5 pr-4 font-medium">{c.a}</td>
                        <td className="py-1.5 pr-4 font-medium">{c.b}</td>
                        <td className={`py-1.5 text-right tabular-nums font-semibold ${c.similarity > 0.8 ? "text-destructive" : "text-amber-600"}`}>
                          {trunc2((c.similarity * 100))}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {/* ── SD2: Per-member unassigned analysis ─────────────────── */}
          {data.perMember && data.perMember.filter(m => m.totalRetailers > 0).length > 0 && (
            <PerMemberAnalysisSection perMember={data.perMember} />
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
