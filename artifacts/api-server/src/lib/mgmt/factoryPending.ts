// Reads the factory pending order book from the "REPORT 2" tab of the
// internal pending sheet (1dmt6uHOdZSIT0wgNkSfuK8W8d0YO8STW51PVOAAFHvY).
//
// Sheet layout (all rows 1-indexed):
//   Row 1  : empty
//   Row 2  : grand-total row (Balance Qty=261,171, product-group subtotals)
//   Row 3  : header row — col B=State Head, col C=Party Name, col D=Balance Qty,
//             cols E-AB = product groups GARDEN PIPE … HARDWARE
//             col AC = broken VLOOKUP (#N/A) — skip
//             col AD = formula label column — skip
//   Row 4  : empty
//   Rows 5+ : data rows (94 rows as of Jul 2026)
//
// NOTE: Water tank quantities in this sheet are in PIECES, not litres.
// The sale register records tanks in litres; do NOT apply the litre rule here.
//
// State Head (col B) carries forward — it is non-empty only on the first
// party row for each head; subsequent rows for the same head leave it blank.
//
// Columns 27+ (0-indexed) are internal formula columns and must be skipped.
import { readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import { loadOrderBookSaleByHead } from "./orderBookSale.js";
import { loadStateHeadSale } from "./stateHeadSale.js";
import { normParty } from "./names.js";
import {
  loadStateHeadAttributionConflicts,
  type StateHeadAttributionConflictReport,
} from "./stateHeadAttributionConflicts.js";
import { logger } from "../logger.js";
import { pool } from "@workspace/db";
import ExcelJS from "exceljs";
import { tankLitresFromCode } from "../registers/tankResolution.js";
import {
  loadPendingCommercialData,
  PENDING_COMMERCIAL_SOURCE,
  type PendingCommercialData,
  type PendingCommercialRow,
} from "./factoryPendingCommercial.js";

const SHEET_ID = "1dmt6uHOdZSIT0wgNkSfuK8W8d0YO8STW51PVOAAFHvY";
const TAB = "REPORT 2";

// Formula helper columns start at this 0-indexed position; everything from
// here onward is a VLOOKUP/formula column, not actual product quantities.
const FORMULA_COL_START = 27;

// ── Types ──────────────────────────────────────────────────────────────────────

export type PendingParty = {
  party: string;
  total: number;
  byGroup: Record<string, number>;
  classification: PendingAttributionClassification;
  candidateEvidence: string[];
  attributionLink: string | null;
  attribution: PendingAttribution;
  reconciliation: ReconciliationCheck;
  /** Rupee amount priced from the pending quantity; null means fully unpriceable. */
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  byGroupAmount?: Record<string, number | null>;
  amountReconciliation?: ReconciliationCheck;
  commercial?: PendingCommercialMatch | PendingCommercialUnavailable;
};

export type PendingCommercialMatch = PendingCommercialRow & {
  available: true;
  source: typeof PENDING_COMMERCIAL_SOURCE;
  unavailableReason: null;
};

export type PendingCommercialUnavailable = {
  available: false;
  source: typeof PENDING_COMMERCIAL_SOURCE;
  unavailableReason: string;
};

export type PendingCommercialCoverage = {
  totalParties: number;
  matchedParties: number;
  unmatchedParties: number;
  ambiguousParties: number;
  sourceRows: number;
  source: typeof PENDING_COMMERCIAL_SOURCE;
  normalization: "normParty";
  error: string | null;
};

export type PendingAttributionClassification =
  | "Attribution Conflicts"
  | "Multiple Candidates"
  | "LEFT / departed member"
  | "Active member"
  | "Attribution unavailable"
  | "None";

export type PendingAttributionCandidate = {
  personId: number;
  member: string;
  stateHead: string | null;
  active: boolean;
  left: boolean;
  evidence: string[];
};

export type PendingAttribution = {
  classification: PendingAttributionClassification;
  candidateCount: number;
  candidates: PendingAttributionCandidate[];
  conflictEvidence: string[];
  conflictLink: string | null;
};

export type PendingBucket = {
  bucket: string;
  member: string | null;
  specialBucket: boolean;
  total: number;
  parties: PendingParty[];
  reconciliation: ReconciliationCheck;
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
  buckets: PendingBucket[];
  members: PendingBucket[];
  reconciliation: ReconciliationCheck;
  coverage: PendingCoverage;
  candidateQty: number | null;
  safeQty: number | null;
  conflictQty: number | null;
  disputedQty: number | null;
  unassignedQty: number | null;
  candidateCoveragePct: number | null;
  safeCoveragePct: number | null;
  conflictCostPp: number | null;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  amountReconciliation?: ReconciliationCheck;
};

export type DerivedPending = {
  ob: number | null;
  sale: number | null;
  pending: number | null;
  nonTerritoryOb: number | null;
  nonTerritorySale: number | null;
  nonTerritoryPending: number | null;
  obError: string | null;
  saleError: string | null;
};

export type ReconciliationCheck = {
  parent: number;
  children: number;
  difference: number;
  exact: boolean;
};

export type PendingReconciliation = {
  company: ReconciliationCheck;
  heads: Array<{ head: string } & ReconciliationCheck>;
  buckets: Array<{ head: string; bucket: string } & ReconciliationCheck>;
  parties: Array<{ head: string; bucket: string; party: string } & ReconciliationCheck>;
};

export type PendingCoverage = {
  candidateCoveragePct: number | null;
  safeCoveragePct: number | null;
  conflictCostPp: number | null;
  cost: number | null;
  candidateQty: number | null;
  safeQty: number | null;
  conflictQty: number | null;
  unassignedQty: number | null;
  disputedQty: number | null;
};

export type PendingPriceMetadata = {
  canonicalGroup: string;
  averageRealisedRate: number | null;
  medianCodeLevelRealisedRate: number | null;
  p10RealisedRate: number | null;
  p90RealisedRate: number | null;
  contributingCodeCount: number;
  contributingSalesAmount: number | null;
  amount: number | null;
  unpriceableQty: number;
  unpriceableReason: string | null;
};

export type PendingPricing = {
  byGroup: Record<string, PendingPriceMetadata>;
  source: "sale_line_current";
  fy: "2026-27";
  basis: string;
};

export type FactoryPendingResult = {
  groups: string[];
  grandTotal: number;
  byHead: PendingHead[];
  derived: DerivedPending;
  coverage: PendingCoverage;
  candidateCoveragePct: number | null;
  safeCoveragePct: number | null;
  conflictCostPp: number | null;
  cost: number | null;
  attributionConflictsLink: string;
  reconciliation: PendingReconciliation;
  attributionError: string | null;
  attributionAvailable: boolean;
  computedAt: string;
  error: string | null;
  pricingAvailable?: boolean;
  pricingError?: string | null;
  pricing?: PendingPricing | null;
  priceMetadata?: Record<string, PendingPriceMetadata>;
  pricedAmount?: number | null;
  amount?: number | null;
  unpriceableQty?: number | null;
  unpriceableReason?: string | null;
  amountReconciliation?: PendingReconciliation | null;
  commercialCoverage?: PendingCommercialCoverage;
};

// ── Cache ──────────────────────────────────────────────────────────────────────

let _cache: { ts: number; result: FactoryPendingResult } | null = null;
const TTL_MS = 30 * 60 * 1000;

export function invalidateFactoryPendingCache(): void {
  _cache = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function numVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Spreadsheet error tokens are data-quality markers, never valid people. */
export function safeSourceHead(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return /^#(?:N\/A|REF!|VALUE!|NAME\?|DIV\/0!|NULL!|NUM!)/i.test(text)
    ? "Unresolved source head"
    : text;
}

function exactDifference(parent: number, children: number): ReconciliationCheck {
  const difference = parent - children;
  return { parent, children, difference, exact: difference === 0 };
}

export type AttributionRow = {
  partyKey: string;
  customerId: string;
  customerName: string;
  assignmentId: number | null;
  personId: number | null;
  memberName: string | null;
  stateHeadName: string | null;
  personActive: boolean | null;
  leftDate: string | null;
  registryStatus: string | null;
  registryName: string | null;
};

export type AttributionIndex = Map<string, AttributionRow[]>;

export type ConflictEvidence = {
  party: string;
  state: string;
  cities: string[];
  workbookHeads: Array<{ head: string; rows: number; net: number }>;
  registerDerivedHeads: Array<{ head: string; net: number }>;
  workbookRows: number;
  workbookNet: number;
  registerNet: number;
  reason: string;
  href: "/org/attribution-conflicts";
};

export type ConflictIndex = Map<string, ConflictEvidence[]>;

function isLeft(row: AttributionRow): boolean {
  const status = (row.registryStatus ?? "").toLowerCase();
  return row.personActive === false ||
    row.leftDate != null ||
    /left|departed|inactive|deactivat|off\s*roll|resign/.test(status);
}

function isActive(row: AttributionRow): boolean {
  return row.personId != null && !isLeft(row) && row.personActive !== false;
}

type RawConflict = StateHeadAttributionConflictReport["conflicts"][number];

export function buildConflictIndex(conflicts: RawConflict[]): ConflictIndex {
  const index: ConflictIndex = new Map();
  for (const conflict of conflicts) {
    const key = normParty(conflict.customer);
    if (!key) continue;
    const reasons = [
      `state ${conflict.state}`,
      `workbook heads: ${conflict.workbookHeads.map((head) => `${head.head} (${head.rows} rows, ${head.net})`).join(", ") || "none"}`,
      `register-derived heads: ${conflict.derivedRegisterHeads.map((head) => `${head.head} (${head.net})`).join(", ") || "none"}`,
      ...(conflict.departedWorkbookHeads.length
        ? [`departed workbook heads: ${conflict.departedWorkbookHeads.join(", ")}`]
        : []),
    ];
    const evidence: ConflictEvidence = {
      party: conflict.customer,
      state: conflict.state,
      cities: conflict.cities,
      workbookHeads: conflict.workbookHeads,
      registerDerivedHeads: conflict.derivedRegisterHeads,
      workbookRows: conflict.workbookRows,
      workbookNet: conflict.workbookNet,
      registerNet: conflict.registerNet,
      reason: reasons.join("; "),
      href: "/org/attribution-conflicts",
    };
    const entries = index.get(key) ?? [];
    entries.push(evidence);
    index.set(key, entries);
  }
  return index;
}

function classifyAttribution(
  party: string,
  quantity: number,
  rows: AttributionRow[],
  conflictMatches: ConflictEvidence[],
): PendingAttribution {
  const personRows = rows.filter((row) => row.personId != null);
  const distinct = new Map<number, AttributionRow>();
  for (const row of personRows) {
    if (!distinct.has(row.personId!)) distinct.set(row.personId!, row);
  }
  const candidates = [...distinct.values()].map((row) => ({
    personId: row.personId!,
    member: row.memberName ?? row.registryName ?? `Person ${row.personId}`,
    stateHead: row.stateHeadName,
    active: isActive(row),
    left: isLeft(row),
    evidence: [
      `customer ${row.customerId} (${row.customerName})`,
      ...(row.assignmentId == null ? [] : [`open assignment ${row.assignmentId}`]),
      ...(row.registryStatus ? [`person_registry status: ${row.registryStatus}`] : []),
      ...(row.leftDate ? [`left_date: ${row.leftDate}`] : []),
    ],
  }));
  const conflictEvidence: string[] = [];
  if (conflictMatches.length > 0) {
    for (const match of conflictMatches) {
      conflictEvidence.push(
        `${match.party} — ${match.reason}; cities: ${match.cities.join(", ") || "none"}; href: ${match.href}`,
      );
    }
  }
  if (distinct.size > 1) {
    conflictEvidence.push(
      `${distinct.size} distinct person_id candidates: ${[...distinct.keys()].sort((a, b) => a - b).join(", ")}`,
    );
  }
  if (rows.length > 0 && personRows.length === 0) {
    conflictEvidence.push("Open assignment exists but has no person_id.");
  }
  let classification: PendingAttributionClassification;
  if (conflictMatches.length > 0) classification = "Attribution Conflicts";
  else if (distinct.size > 1) classification = "Multiple Candidates";
  else if (distinct.size === 1 && isLeft([...distinct.values()][0])) {
    classification = "LEFT / departed member";
  } else if (distinct.size === 1 && isActive([...distinct.values()][0])) {
    classification = "Active member";
  } else classification = "None";
  // Keep the quantity in the evidence string so an export can explain every
  // source quantity without requiring a second lookup.
  if (classification === "Attribution Conflicts" || classification === "Multiple Candidates") {
    conflictEvidence.push(`pending quantity: ${quantity}`);
    conflictEvidence.push(`party: ${party}`);
  }
  return {
    classification,
    candidateCount: distinct.size,
    candidates,
    conflictEvidence,
    conflictLink:
      classification === "Attribution Conflicts" || classification === "Multiple Candidates"
        ? "/org/attribution-conflicts"
        : null,
  };
}

async function loadAttributionIndex(): Promise<AttributionIndex> {
  const result = await pool.query<{
    customer_id: string;
    customer_name: string;
    assignment_id: number | null;
    person_id: number | null;
    member_name: string | null;
    state_head_name: string | null;
    person_active: boolean | null;
    left_date: string | null;
    registry_status: string | null;
    registry_name: string | null;
  }>(`
    SELECT c.customer_id,
           c.name AS customer_name,
           ca.id AS assignment_id,
           ca.person_id,
           p.name AS member_name,
           COALESCE(sh.name, fallback_sh.name, pr.state_head) AS state_head_name,
           p.is_active AS person_active,
           p.left_date::text AS left_date,
           pr.hr_status AS registry_status,
           pr.canonical_name AS registry_name
      FROM customer c
      LEFT JOIN customer_assignment ca
        ON ca.customer_id = c.customer_id
       AND ca.effective_to IS NULL
       AND ca.voided_at IS NULL
      LEFT JOIN person p ON p.person_id = ca.person_id
      LEFT JOIN person sh ON sh.person_id = ca.state_head_person_id
      LEFT JOIN person fallback_sh ON fallback_sh.person_id = p.state_head_person_id
      LEFT JOIN LATERAL (
        SELECT r.canonical_name, r.hr_status, r.state_head
          FROM person_registry r
         WHERE (p.employee_code IS NOT NULL AND r.employee_code = p.employee_code)
            OR lower(regexp_replace(r.canonical_name, '[^a-zA-Z0-9]', '', 'g')) =
               lower(regexp_replace(COALESCE(p.name, ''), '[^a-zA-Z0-9]', '', 'g'))
         ORDER BY CASE WHEN p.employee_code IS NOT NULL AND r.employee_code = p.employee_code THEN 0 ELSE 1 END,
                  r.id
         LIMIT 1
      ) pr ON TRUE
     WHERE c.status IS NULL OR lower(c.status) NOT IN ('voided', 'deleted')
  `);
  const index: AttributionIndex = new Map();
  for (const row of result.rows) {
    const key = normParty(row.customer_name);
    if (!key) continue;
    const entries = index.get(key) ?? [];
    entries.push({
      partyKey: key,
      customerId: row.customer_id,
      customerName: row.customer_name,
      assignmentId: row.assignment_id,
      personId: row.person_id,
      memberName: row.member_name,
      stateHeadName: row.state_head_name,
      personActive: row.person_active,
      leftDate: row.left_date,
      registryStatus: row.registry_status,
      registryName: row.registry_name,
    });
    index.set(key, entries);
  }
  return index;
}

async function loadConflictIndex(): Promise<ConflictIndex> {
  const report = await loadStateHeadAttributionConflicts();
  return buildConflictIndex(report.conflicts);
}

function buildAttribution(
  party: string,
  total: number,
  index: AttributionIndex | null,
  conflicts: ConflictIndex | null,
): PendingAttribution & { candidateQty: number; hasConflict: boolean } {
  const conflictMatches = conflicts?.get(normParty(party)) ?? [];
  const attribution = classifyAttribution(
    party,
    total,
    index?.get(normParty(party)) ?? [],
    conflictMatches,
  );
  const distinct = attribution.candidates;
  return {
    ...attribution,
    candidateQty:
      distinct.length === 1 && (distinct[0].active || distinct[0].left)
        ? total
        : 0,
    hasConflict: conflictMatches.length > 0,
  };
}

function bucketFor(party: PendingParty): string {
  switch (party.attribution.classification) {
    case "Active member":
      return party.attribution.candidates[0]?.member ?? "Unassigned";
    case "LEFT / departed member":
      return `${party.attribution.candidates[0]?.member ?? "Unknown"} (LEFT)`;
    case "Attribution Conflicts":
    case "Multiple Candidates":
      return "Attribution Conflicts";
    default:
      return "Unassigned";
  }
}

function bucketMember(bucket: string): string | null {
  return bucket === "Unassigned" || bucket === "Attribution Conflicts" ? null : bucket.replace(/ \(LEFT\)$/, "");
}

function coverageFor(
  candidateQty: number,
  safeQty: number,
  disputedQty: number,
  unassignedQty: number,
  denominator: number,
): PendingCoverage {
  const pct = (value: number): number =>
    denominator > 0 ? Number(((value / denominator) * 100).toFixed(2)) : 0;
  const candidateCoveragePct = pct(candidateQty);
  const safeCoveragePct = pct(safeQty);
  const conflictCostPp = Number(Math.max(0, candidateCoveragePct - safeCoveragePct).toFixed(2));
  return {
    candidateCoveragePct,
    safeCoveragePct,
    conflictCostPp,
    cost: conflictCostPp,
    candidateQty,
    safeQty,
    conflictQty: Math.max(0, candidateQty - safeQty),
    unassignedQty,
    disputedQty,
  };
}

function enrichSheet(
  sheet: SheetData,
  index: AttributionIndex | null,
  conflicts: ConflictIndex | null,
): {
  byHead: PendingHead[];
  coverage: PendingCoverage;
  reconciliation: PendingReconciliation;
} {
  let candidateQty = 0;
  let safeQty = 0;
  let disputedQty = 0;
  let unassignedQty = 0;
  const byHead = sheet.byHead.map((head) => {
    let headCandidateQty = 0;
    let headSafeQty = 0;
    let headDisputedQty = 0;
    let headUnassignedQty = 0;
    const parties = head.parties.map((party) => {
      const attribution = buildAttribution(party.party, party.total, index, conflicts);
      const productChildren = Object.values(party.byGroup).reduce((sum, value) => sum + value, 0);
      const enriched = {
        ...party,
        attribution,
        classification: attribution.classification,
        candidateEvidence: attribution.conflictEvidence,
        attributionLink: attribution.conflictLink,
        reconciliation: exactDifference(party.total, productChildren),
      };
      candidateQty += attribution.candidateQty;
      headCandidateQty += attribution.candidateQty;
      if (attribution.classification === "Active member") {
        safeQty += party.total;
        headSafeQty += party.total;
      }
      if (
        attribution.classification === "Attribution Conflicts" ||
        attribution.classification === "Multiple Candidates"
      ) {
        disputedQty += party.total;
        headDisputedQty += party.total;
      }
      if (attribution.classification === "None") {
        unassignedQty += party.total;
        headUnassignedQty += party.total;
      }
      return enriched;
    });
    const bucketMap = new Map<string, PendingBucket>();
    for (const party of parties) {
      const bucket = bucketFor(party);
      const entry = bucketMap.get(bucket) ?? {
        bucket,
        member: bucketMember(bucket),
        specialBucket: bucket === "Unassigned" || bucket === "Attribution Conflicts",
        total: 0,
        parties: [],
        reconciliation: exactDifference(0, 0),
      };
      entry.total += party.total;
      entry.parties.push(party);
      bucketMap.set(bucket, entry);
    }
    const buckets = [...bucketMap.values()].map((bucket) => ({
      ...bucket,
      reconciliation: exactDifference(
        bucket.total,
        bucket.parties.reduce((sum, party) => sum + party.total, 0),
      ),
    }));
    const coverage = coverageFor(
      headCandidateQty,
      headSafeQty,
      headDisputedQty,
      headUnassignedQty,
      head.total,
    );
    return {
      ...head,
      parties,
      buckets,
      members: buckets,
      coverage,
      candidateQty: coverage.candidateQty,
      safeQty: coverage.safeQty,
      conflictQty: coverage.conflictQty,
      disputedQty: coverage.disputedQty,
      unassignedQty: coverage.unassignedQty,
      candidateCoveragePct: coverage.candidateCoveragePct,
      safeCoveragePct: coverage.safeCoveragePct,
      conflictCostPp: coverage.conflictCostPp,
      reconciliation: exactDifference(
        head.total,
        buckets.reduce((sum, bucket) => sum + bucket.total, 0),
      ),
    };
  });
  const companyChildren = byHead.reduce((sum, head) => sum + head.total, 0);
  const heads = byHead.map((head) => ({ head: head.head, ...exactDifference(head.total, head.parties.reduce((sum, p) => sum + p.total, 0)) }));
  const buckets = byHead.flatMap((head) => head.buckets.map((bucket) => ({
    head: head.head,
    bucket: bucket.bucket,
    ...exactDifference(bucket.total, bucket.parties.reduce((sum, p) => sum + p.total, 0)),
  })));
  const parties = byHead.flatMap((head) => head.buckets.flatMap((bucket) => bucket.parties.map((party) => ({
    head: head.head,
    bucket: bucket.bucket,
    party: party.party,
    ...party.reconciliation,
  }))));
  const coverage = coverageFor(
    candidateQty,
    safeQty,
    disputedQty,
    unassignedQty,
    sheet.grandTotal,
  );
  return {
    byHead,
    coverage,
    reconciliation: {
      company: exactDifference(sheet.grandTotal, companyChildren),
      heads,
      buckets,
      parties,
    },
  };
}

function unavailableCoverage(): PendingCoverage {
  return {
    candidateCoveragePct: null,
    safeCoveragePct: null,
    conflictCostPp: null,
    cost: null,
    candidateQty: null,
    safeQty: null,
    conflictQty: null,
    unassignedQty: null,
    disputedQty: null,
  };
}

function addPendingCommercial(
  byHead: PendingHead[],
  data: PendingCommercialData | null,
  error: string | null,
): { byHead: PendingHead[]; coverage: PendingCommercialCoverage } {
  let matchedParties = 0;
  let unmatchedParties = 0;
  let ambiguousParties = 0;
  const attach = (party: PendingParty): PendingParty => {
    let commercial: PendingCommercialMatch | PendingCommercialUnavailable;
    if (!data) {
      commercial = {
        available: false,
        source: PENDING_COMMERCIAL_SOURCE,
        unavailableReason: error ?? "Commercial source unavailable",
      };
    } else {
      const matches = data.byParty.get(normParty(party.party)) ?? [];
      if (matches.length === 1) {
        matchedParties++;
        commercial = {
          ...matches[0],
          available: true,
          source: data.source,
          unavailableReason: null,
        };
      } else if (matches.length > 1) {
        ambiguousParties++;
        commercial = {
          available: false,
          source: data.source,
          unavailableReason: `Ambiguous normParty match: ${matches.length} source rows`,
        };
      } else {
        unmatchedParties++;
        commercial = {
          available: false,
          source: data.source,
          unavailableReason: "No exact normParty match in distributor order/sale source",
        };
      }
    }
    return { ...party, commercial };
  };

  const output = byHead.map((head) => {
    const parties = head.parties.map(attach);
    const partyByName = new Map(parties.map((party) => [party.party, party]));
    const buckets = head.buckets.map((bucket) => ({
      ...bucket,
      parties: bucket.parties.map(
        (party) => partyByName.get(party.party) ?? party,
      ),
    }));
    return { ...head, parties, buckets, members: buckets };
  });
  const totalParties = output.reduce((sum, head) => sum + head.parties.length, 0);
  if (!data) unmatchedParties = totalParties;
  return {
    byHead: output,
    coverage: {
      totalParties,
      matchedParties,
      unmatchedParties,
      ambiguousParties,
      sourceRows: data?.sourceRows ?? 0,
      source: PENDING_COMMERCIAL_SOURCE,
      normalization: "normParty",
      error,
    },
  };
}

const PRICE_BASIS =
  "FY2026-27 sale_line_current, version_status=current; group-level weighted realised price = SUM(amount)/SUM(quantity denominator).";

function canonicalPendingGroup(group: string): string {
  const key = group.trim().toUpperCase().replace(/\s+/g, " ");
  const map: Record<string, string> = {
    "WATER TANK": "WATER TANK",
    "WATER TANKS": "WATER TANK",
    "WT LID": "WATER TANK",
    "AGRI": "AGRI",
    "AGRITEC": "AGRI",
    "AGRI AGRITEC": "AGRI",
    "UPVC": "UPVC",
    "UPVC PIPE": "UPVC",
    "OPVC": "UPVC",
    "UPVC AQUAFRESH": "UPVC",
    "CPVC": "CPVC",
    "CPVC PIPE": "CPVC",
    "CPVC DURALIFE": "CPVC",
    "SWR": "SWR",
    "SWR DRAINTECH": "SWR",
    "PPR": "PPR",
    "HDPE PIPE": "HDPE",
    "GARDEN PIPE": "Garden Pipe",
    "P.V.C. GARDEN PIPE": "Garden Pipe",
    "COLUMN": "COLUMN",
    "COLUMN PIPE": "COLUMN",
    "CORRUGATED PIPE": "Corrugated Pipe",
    "PTMT": "PTMT / Faucets",
    "SEAT COVER": "PTMT / Faucets",
    "P.T.M.T. SYMET": "PTMT / Faucets",
    "VIGNETTE": "PTMT / Faucets",
    "CISTERN": "CISTERN",
    "CISTERNS & SEAT COVERS": "CISTERN",
    "C P": "CP (Chrome-Plated)",
    "CP": "CP (Chrome-Plated)",
    "CP ACCESSORIES": "CP (Chrome-Plated)",
    "CP ALLIED": "CP (Chrome-Plated)",
    "C.P-CDA": "CP (Chrome-Plated)",
    "C.P. 5000 SERIES": "CP (Chrome-Plated)",
    "C.P. 6000 SERIES": "CP (Chrome-Plated)",
    "C.P. 7000 SERIES": "CP (Chrome-Plated)",
    "C.P. 8000 SERIES": "CP (Chrome-Plated)",
    "C.P. 9000 SERIES": "CP (Chrome-Plated)",
    "SINK": "Sink",
    "PLATE RACK": "Sink",
    "CABINET": "Sink",
    "GLASS": "Sink",
    "S.STEEL SINK": "Sink",
    "SANITARYWARE": "Sanitaryware",
    "GEYSER": "Sanitaryware",
    "WATER HEATER": "Sanitaryware",
    "WASTE PIPE": "Connection / Waste",
    "CONNECTION": "Connection / Waste",
    "CONECTION": "Connection / Waste",
    "FLOOR TRAP": "Connection / Waste",
    "COCKROACH TRAPS & GRATINGS": "Connection / Waste",
    "MANHOLE COVER": "Connection / Waste",
    "HARDWARE": "Hardware",
    "TEFELON TAPE": "Hardware",
    "QUAA": "Hardware",
    "OTHER": "Hardware",
  };
  return map[key] ?? group.trim();
}

export function saleQuantityDenominator(code: string, group: string, qty: number, qtyLtr: number | null): number {
  if (group !== "WATER TANK") return qty;
  const litres = tankLitresFromCode(code);
  if (litres == null) return qty;
  return qtyLtr != null ? qty : qty / litres;
}

/**
 * Price data is deliberately loaded independently from REPORT 2.  A failure
 * here must never prevent the source quantity from being returned.
 */
export type PendingPricingSaleRow = {
  code: string | null;
  group_canon: string | null;
  group_raw: string | null;
  amount: string | number | null;
  qty: string | number | null;
  qty_ltr: string | number | null;
};

export function buildPendingPricingFromRows(rows: PendingPricingSaleRow[]): PendingPricing {
  const stats = new Map<string, {
    amount: number;
    denominator: number;
    ratesByCode: Map<string, { amount: number; denominator: number }>;
  }>();
  for (const row of rows) {
    const group = canonicalPendingGroup(
      String(row.group_canon ?? row.group_raw ?? "").trim(),
    );
    if (!group) continue;
    // NULL amount means the source did not provide a realised value. Do not
    // turn it into a zero-priced sale or let it dilute the denominator.
    if (row.amount == null) continue;
    const amount = Number(row.amount);
    const qty = Number(row.qty ?? 0);
    const qtyLtr = row.qty_ltr == null ? null : Number(row.qty_ltr);
    if (!Number.isFinite(amount) || !Number.isFinite(qty) || qty <= 0) continue;
    const denominator = saleQuantityDenominator(String(row.code ?? ""), group, qty, qtyLtr);
    if (!Number.isFinite(denominator) || denominator <= 0) continue;
    const entry = stats.get(group) ?? { amount: 0, denominator: 0, ratesByCode: new Map() };
    entry.amount += amount;
    entry.denominator += denominator;
    const code = String(row.code ?? "").trim() || "(unknown)";
    const codeEntry = entry.ratesByCode.get(code) ?? { amount: 0, denominator: 0 };
    codeEntry.amount += amount;
    codeEntry.denominator += denominator;
    entry.ratesByCode.set(code, codeEntry);
    stats.set(group, entry);
  }
  const percentile = (values: number[], p: number): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  const byGroup: Record<string, PendingPriceMetadata> = {};
  for (const [group, stat] of stats) {
    const rates = [...stat.ratesByCode.values()]
      .filter((v) => v.amount >= 0 && v.denominator > 0)
      .map((v) => v.amount / v.denominator);
    const average = stat.denominator > 0 ? stat.amount / stat.denominator : null;
    byGroup[group] = {
      canonicalGroup: group,
      averageRealisedRate: average,
      medianCodeLevelRealisedRate: rates.length
        ? [...rates].sort((a, b) => a - b)[Math.floor((rates.length - 1) / 2)]
        : null,
      p10RealisedRate: percentile(rates, 0.1),
      p90RealisedRate: percentile(rates, 0.9),
      contributingCodeCount: rates.length,
      contributingSalesAmount: stat.amount,
      amount: null,
      unpriceableQty: 0,
      unpriceableReason: null,
    };
  }
  return {
    byGroup,
    source: "sale_line_current",
    fy: "2026-27",
    basis: PRICE_BASIS,
  };
}

export async function loadPendingPricing(): Promise<PendingPricing> {
  const result = await pool.query<PendingPricingSaleRow>(`
    SELECT code, group_canon, group_raw, amount, qty, qty_ltr
      FROM sale_line_current
     WHERE fy = '2026-27'
       AND version_status = 'current'
  `);
  return buildPendingPricingFromRows(result.rows);
}

function addAmountPricing(
  sheet: Pick<SheetData, "byHead"> & Partial<Pick<SheetData, "groups" | "grandTotal">>,
  result: PendingPricing | null,
): {
  byHead: PendingHead[];
  pricedAmount: number | null;
  unpriceableQty: number | null;
  pricing: PendingPricing | null;
  amountReconciliation: PendingReconciliation | null;
} {
  if (!result) {
    return {
      byHead: sheet.byHead,
      pricedAmount: null,
      unpriceableQty: null,
      pricing: null,
      amountReconciliation: null,
    };
  }
  // Keep a metadata record for every REPORT 2 source group, including groups
  // absent from the FY sale register. Absence is an explicit null rate, never
  // an invented zero.
  const canonicalByGroup = result.byGroup;
  const sourceGroups = new Set<string>();
  for (const sourceGroup of sheet.groups ?? []) sourceGroups.add(sourceGroup);
  for (const head of sheet.byHead) {
    for (const party of head.parties) {
      for (const sourceGroup of Object.keys(party.byGroup)) {
        sourceGroups.add(sourceGroup);
      }
    }
  }
  const sourceByGroup: Record<string, PendingPriceMetadata> = {};
  for (const sourceGroup of sourceGroups) {
    const canonical = canonicalPendingGroup(sourceGroup);
    const canonicalMetadata = canonicalByGroup[canonical];
    sourceByGroup[sourceGroup] = canonicalMetadata
      ? { ...canonicalMetadata, canonicalGroup: canonical }
      : {
            canonicalGroup: canonical,
            averageRealisedRate: null,
            medianCodeLevelRealisedRate: null,
            p10RealisedRate: null,
            p90RealisedRate: null,
            contributingCodeCount: 0,
            contributingSalesAmount: null,
            amount: null,
            unpriceableQty: 0,
            unpriceableReason: "No FY2026-27 sale_line_current rows with a usable rate",
        };
  }
  result.byGroup = sourceByGroup;
  const metadataForSourceGroup = (sourceGroup: string): PendingPriceMetadata | undefined =>
    result.byGroup[sourceGroup];
  const amountForParty = (party: PendingParty): {
    cents: number; unpriceable: number; reason: string | null;
    groups: Record<string, number>; byGroupAmount: Record<string, number | null>;
  } => {
    let cents = 0;
    let unpriceable = 0;
    let hasPricedQty = false;
    const reasons: string[] = [];
    const groups: Record<string, number> = {};
    const byGroupAmount: Record<string, number | null> = {};
    for (const [sourceGroup, quantity] of Object.entries(party.byGroup)) {
      if (quantity <= 0) continue;
      const metadata = metadataForSourceGroup(sourceGroup);
      const rate = metadata?.averageRealisedRate;
      if (rate == null || rate <= 0) {
        unpriceable += quantity;
        byGroupAmount[sourceGroup] = null;
        reasons.push(`${sourceGroup}: no usable positive realised rate`);
        continue;
      }
      cents += Math.round(quantity * rate * 100);
      hasPricedQty = true;
      groups[sourceGroup] = Math.round(quantity * rate * 100);
      byGroupAmount[sourceGroup] = groups[sourceGroup] / 100;
    }
    const productQty = Object.values(party.byGroup).reduce((sum, value) => sum + value, 0);
    if (party.total > productQty) {
      unpriceable += party.total - productQty;
      reasons.push(`REPORT 2 total minus product-group columns: ${party.total - productQty} pieces`);
    }
    return {
      cents, unpriceable, reason: reasons.length ? reasons.join("; ") : null, groups, byGroupAmount,
    };
  };
  const pricedByParty = new Map<PendingParty, ReturnType<typeof amountForParty>>();
  for (const head of sheet.byHead) {
    for (const party of head.parties) pricedByParty.set(party, amountForParty(party));
  }
  const centsCheckForParty = (cents: number, groups: Record<string, number>): ReconciliationCheck => {
    const childCents = Object.values(groups).reduce((sum, value) => sum + value, 0);
    return {
      parent: cents / 100,
      children: childCents / 100,
      difference: (cents - childCents) / 100,
      exact: cents === childCents,
    };
  };
  const toAmount = (cents: number, hasQty: boolean): number | null =>
    hasQty ? cents / 100 : null;
  const centsCheck = (parentCents: number, childCents: number): ReconciliationCheck => ({
    parent: parentCents / 100,
    children: childCents / 100,
    difference: (parentCents - childCents) / 100,
    exact: parentCents === childCents,
  });
  const byHead = sheet.byHead.map((head) => {
    const parties = head.parties.map((party) => {
      const p = pricedByParty.get(party)!;
      const hasPricedQty = p.groups && Object.keys(p.groups).length > 0;
      return {
        ...party,
        pricedAmount: toAmount(p.cents, hasPricedQty),
        amount: toAmount(p.cents, hasPricedQty),
        unpriceableQty: p.unpriceable,
        unpriceableReason: p.reason,
        byGroupAmount: p.byGroupAmount,
        amountReconciliation: centsCheckForParty(p.cents, p.groups),
      };
    });
    const partyOutput = new Map(parties.map((party) => [party.party, party]));
    const buckets = head.buckets.map((bucket) => {
      const entries = bucket.parties.map((party) => pricedByParty.get(party)!);
      const cents = entries.reduce((sum, p) => sum + p.cents, 0);
      const unpriceable = entries.reduce((sum, p) => sum + p.unpriceable, 0);
      const hasPricedQty = entries.some((p) => Object.keys(p.groups).length > 0);
      return {
        ...bucket,
        parties: bucket.parties.map((party) => partyOutput.get(party.party) ?? party),
        pricedAmount: toAmount(cents, hasPricedQty),
        amount: toAmount(cents, hasPricedQty),
        unpriceableQty: unpriceable,
        unpriceableReason: unpriceable > 0 ? "One or more child quantities are unpriceable" : null,
        amountReconciliation: centsCheck(cents, entries.reduce((sum, p) => sum + p.cents, 0)),
      };
    });
    const cents = head.parties.reduce((sum, party) => sum + pricedByParty.get(party)!.cents, 0);
    const unpriceable = head.parties.reduce((sum, party) => sum + pricedByParty.get(party)!.unpriceable, 0);
    const hasPricedQty = head.parties.some((party) => Object.keys(pricedByParty.get(party)!.groups).length > 0);
    return {
      ...head,
      parties,
      buckets,
      members: buckets,
      pricedAmount: toAmount(cents, hasPricedQty),
      amount: toAmount(cents, hasPricedQty),
      unpriceableQty: unpriceable,
      unpriceableReason: unpriceable > 0 ? "One or more child quantities are unpriceable" : null,
      amountReconciliation: centsCheck(cents, head.parties.reduce((sum, party) => sum + pricedByParty.get(party)!.cents, 0)),
    };
  });
  const groupAmounts = new Map<string, number>();
  for (const head of byHead) {
    for (const party of head.parties) {
      for (const [group, qty] of Object.entries(party.byGroup)) {
        const metadata = metadataForSourceGroup(group);
        const groupAmount = party.byGroupAmount?.[group] ?? null;
        if (groupAmount != null) {
          groupAmounts.set(group, (groupAmounts.get(group) ?? 0) + Math.round(groupAmount * 100));
        } else if (qty > 0 && metadata) {
          metadata.unpriceableQty += qty;
          metadata.unpriceableReason = "No usable positive realised rate";
        }
      }
    }
  }
  for (const [group, metadata] of Object.entries(result.byGroup)) {
    const amount = groupAmounts.get(group);
    if (amount != null) metadata.amount = amount / 100;
  }
  const companyCents = byHead.reduce((sum, head) => sum + Math.round((head.pricedAmount ?? 0) * 100), 0);
  const unpriceableQty = byHead.reduce((sum, head) => sum + (head.unpriceableQty ?? 0), 0);
  const heads = byHead.map((head) => ({
    head: head.head,
    ...(head.amountReconciliation ?? centsCheck(0, 0)),
  }));
  const buckets = byHead.flatMap((head) => head.buckets.map((bucket) => ({
    head: head.head,
    bucket: bucket.bucket,
    ...(bucket.amountReconciliation ?? centsCheck(0, 0)),
  })));
  const parties = byHead.flatMap((head) => head.buckets.flatMap((bucket) => bucket.parties.map((party) => ({
    head: head.head, bucket: bucket.bucket, party: party.party,
    ...(party.amountReconciliation ?? centsCheck(0, 0)),
  }))));
  return {
    byHead,
    pricedAmount: companyCents > 0 ? companyCents / 100 : null,
    unpriceableQty,
    pricing: result,
    amountReconciliation: {
      company: centsCheck(
        companyCents,
        byHead.reduce((sum, head) => sum + Math.round((head.pricedAmount ?? 0) * 100), 0),
      ),
      heads, buckets, parties,
    },
  };
}

function preserveSheetWithoutAttribution(sheet: SheetData): {
  byHead: PendingHead[];
  coverage: PendingCoverage;
  reconciliation: PendingReconciliation;
} {
  const byHead = sheet.byHead.map((head) => {
    const parties = head.parties.map((party) => ({
      ...party,
      classification: "Attribution unavailable" as const,
      candidateEvidence: [],
      attributionLink: null,
      attribution: {
        classification: "Attribution unavailable" as const,
        candidateCount: 0,
        candidates: [],
        conflictEvidence: [],
        conflictLink: null,
      },
    }));
    return {
      ...head,
      parties,
      buckets: [],
      members: [],
      coverage: unavailableCoverage(),
      candidateQty: null,
      safeQty: null,
      conflictQty: null,
      disputedQty: null,
      unassignedQty: null,
      candidateCoveragePct: null,
      safeCoveragePct: null,
      conflictCostPp: null,
      reconciliation: exactDifference(
        head.total,
        parties.reduce((sum, party) => sum + party.total, 0),
      ),
    };
  });
  const companyChildren = byHead.reduce((sum, head) => sum + head.total, 0);
  const heads = byHead.map((head) => ({
    head: head.head,
    ...exactDifference(
      head.total,
      head.parties.reduce((sum, party) => sum + party.total, 0),
    ),
  }));
  return {
    byHead,
    coverage: unavailableCoverage(),
    reconciliation: {
      company: exactDifference(sheet.grandTotal, companyChildren),
      heads,
      buckets: [],
      parties: [],
    },
  };
}

// ── Main loader ────────────────────────────────────────────────────────────────

export type FactoryPendingDependencies = {
  readReport2?: () => Promise<SheetData>;
  loadOrderBookSaleByHead?: typeof loadOrderBookSaleByHead;
  loadStateHeadSale?: typeof loadStateHeadSale;
  loadAttributionIndex?: () => Promise<AttributionIndex>;
  loadConflictIndex?: () => Promise<ConflictIndex>;
  loadPricing?: () => Promise<PendingPricing>;
  loadCommercial?: () => Promise<PendingCommercialData>;
  now?: () => Date;
};

export async function buildFactoryPending(
  dependencies: FactoryPendingDependencies = {},
): Promise<FactoryPendingResult> {
  const useCache = Object.keys(dependencies).length === 0;
  const read = dependencies.readReport2 ?? readReport2;
  const loadOb = dependencies.loadOrderBookSaleByHead ?? loadOrderBookSaleByHead;
  const loadSale = dependencies.loadStateHeadSale ?? loadStateHeadSale;
  const loadAttribution = dependencies.loadAttributionIndex ?? loadAttributionIndex;
  const loadConflicts = dependencies.loadConflictIndex ?? loadConflictIndex;
  const shouldLoadPricing = Object.keys(dependencies).length === 0 || dependencies.loadPricing != null;
  const loadPricing = dependencies.loadPricing ?? loadPendingPricing;
  const shouldLoadCommercial =
    Object.keys(dependencies).length === 0 || dependencies.loadCommercial != null;
  const loadCommercial =
    dependencies.loadCommercial ?? loadPendingCommercialData;
  if (useCache && _cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  const [sheetResult, obResult, saleResult, attributionResult, conflictResult, pricingResult, commercialResult] = await Promise.allSettled([
    read(),
    loadOb(),
    loadSale("2026-27"),
    loadAttribution(),
    loadConflicts(),
    shouldLoadPricing ? loadPricing() : Promise.resolve(null),
    shouldLoadCommercial ? loadCommercial() : Promise.resolve(null),
  ]);

  const sheet = sheetResult.status === "fulfilled" ? sheetResult.value : null;
  const sheetError =
    sheetResult.status === "rejected"
      ? String(sheetResult.reason instanceof Error ? sheetResult.reason.message : sheetResult.reason)
      : null;

  const ob = obResult.status === "fulfilled" ? obResult.value : null;
  const sale = saleResult.status === "fulfilled" ? saleResult.value : null;
  const attribution = attributionResult.status === "fulfilled" ? attributionResult.value : null;
  const attributionError =
    attributionResult.status === "rejected"
      ? String(attributionResult.reason instanceof Error ? attributionResult.reason.message : attributionResult.reason)
      : null;
  const conflictError =
    conflictResult.status === "rejected"
      ? String(conflictResult.reason instanceof Error ? conflictResult.reason.message : conflictResult.reason)
      : null;
  const attributionLoadError = [attributionError, conflictError].filter(Boolean).join("; ") || null;
  const conflicts = conflictResult.status === "fulfilled" ? conflictResult.value : null;
  const pricing =
    pricingResult.status === "fulfilled" ? pricingResult.value : null;
  const pricingError =
    pricingResult.status === "rejected"
      ? String(pricingResult.reason instanceof Error ? pricingResult.reason.message : pricingResult.reason)
      : null;
  const commercial =
    commercialResult.status === "fulfilled" ? commercialResult.value : null;
  const commercialError =
    commercialResult.status === "rejected"
      ? String(
          commercialResult.reason instanceof Error
            ? commercialResult.reason.message
            : commercialResult.reason,
        )
      : null;
  const attributionAvailable =
    attributionResult.status === "fulfilled" && conflictResult.status === "fulfilled";

  const obTotal = ob && !ob.error ? ob.total : null;
  const saleTotal = sale && !sale.error ? sale.total : null;
  const pendingTotal =
    obTotal != null && saleTotal != null ? obTotal - saleTotal : null;
  const nonTerritoryOb = ob && !ob.error && ob.byHead instanceof Map ? (ob.byHead.get("Non-territory") ?? null) : null;
  const nonTerritorySale = sale && !sale.error && sale.byHead instanceof Map ? (sale.byHead.get("Non-territory") ?? null) : null;

  const derived: DerivedPending = {
    ob: obTotal,
    sale: saleTotal,
    pending: pendingTotal,
    nonTerritoryOb,
    nonTerritorySale,
    nonTerritoryPending:
      nonTerritoryOb != null && nonTerritorySale != null
        ? nonTerritoryOb - nonTerritorySale
        : null,
    obError: ob?.error ?? (obResult.status === "rejected" ? String(obResult.reason) : null),
    saleError:
      sale?.error ?? (saleResult.status === "rejected" ? String(saleResult.reason) : null),
  };

  const enriched = sheet && attributionAvailable
    ? enrichSheet(sheet, attribution!, conflicts!)
    : sheet
      ? preserveSheetWithoutAttribution(sheet)
    : {
        byHead: [],
        coverage: unavailableCoverage(),
        reconciliation: {
          company: exactDifference(0, 0),
          heads: [],
          buckets: [],
          parties: [],
        },
      };
  const amountPricing = addAmountPricing({ ...enriched, groups: sheet?.groups ?? [] }, pricing);
  const commercialAttachment = addPendingCommercial(
    amountPricing.byHead,
    shouldLoadCommercial ? commercial : null,
    shouldLoadCommercial ? commercialError : "Commercial source not loaded",
  );
  const result: FactoryPendingResult = {
    groups: sheet?.groups ?? [],
    grandTotal: sheet?.grandTotal ?? 0,
    byHead: commercialAttachment.byHead,
    derived,
    coverage: enriched.coverage,
    candidateCoveragePct: enriched.coverage.candidateCoveragePct,
    safeCoveragePct: enriched.coverage.safeCoveragePct,
    conflictCostPp: enriched.coverage.conflictCostPp,
    cost: enriched.coverage.conflictCostPp,
    attributionConflictsLink: "/org/attribution-conflicts",
    reconciliation: enriched.reconciliation,
    attributionError: attributionLoadError,
    attributionAvailable,
    computedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    error: sheetError,
    pricingAvailable: shouldLoadPricing && pricingResult.status === "fulfilled" && pricing != null,
    pricingError,
    pricing: amountPricing.pricing,
    priceMetadata: amountPricing.pricing?.byGroup ?? {},
    pricedAmount: amountPricing.pricedAmount,
    amount: amountPricing.pricedAmount,
    unpriceableQty: amountPricing.unpriceableQty,
    unpriceableReason:
      (amountPricing.unpriceableQty ?? 0) > 0
        ? "Includes REPORT 2 quantity not present in product-group columns and groups without a usable positive rate."
        : null,
    amountReconciliation: amountPricing.amountReconciliation,
    commercialCoverage: commercialAttachment.coverage,
  };

  if (
    useCache &&
    !sheetError &&
    attributionAvailable &&
    !attributionLoadError &&
    (!shouldLoadPricing || pricingResult.status === "fulfilled")
    && (!shouldLoadCommercial || commercialResult.status === "fulfilled")
  ) {
    _cache = { ts: Date.now(), result };
    logger.info(
      { grandTotal: result.grandTotal, heads: result.byHead.length, groups: result.groups.length },
      "factoryPending: loaded REPORT 2",
    );
  }

  return result;
}

export async function loadFactoryPending(): Promise<FactoryPendingResult> {
  return buildFactoryPending();
}

// ── Sheet reader ───────────────────────────────────────────────────────────────

export type SheetData = {
  groups: string[];
  grandTotal: number;
  byHead: PendingHead[];
};

async function readReport2(): Promise<SheetData> {
  let groups: string[] = [];
  let grandTotal = 0;
  const headsMap = new Map<string, PendingHead>();
  let currentHead = "";
  let headerFound = false;

  await readTabRowsChunked(SHEET_ID, TAB, (rows, startRow) => {
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const globalRow = startRow + ri; // 1-indexed sheet row

      if (!headerFound) {
        // The header row contains "State Head" in col B (index 1) and
        // "Party Name" in col C (index 2) and "Balance Qty" in col D (index 3).
        const b = strVal(row[1]);
        const c = strVal(row[2]);
        const d = strVal(row[3]);
        if (/state\s*head/i.test(b) && /party/i.test(c) && /balance/i.test(d)) {
          // Extract product group names from col E (index 4) onward,
          // stopping before the formula helper columns.
          for (let ci = 4; ci < Math.min(row.length, FORMULA_COL_START); ci++) {
            const name = strVal(row[ci]);
            if (name) groups.push(name);
          }
          headerFound = true;
        }
        continue;
      }

      // Grand total row is row 2 in the sheet (before the header row 3).
      // It should have been skipped by the !headerFound guard above, but
      // capture Balance Qty from any row before header that has a large total.
      // Actually: after header is found, we process data rows only.

      const headVal = safeSourceHead(strVal(row[1]));
      const party = strVal(row[2]);
      const qty = numVal(row[3]);

      if (headVal) currentHead = headVal;

      if (!party || qty <= 0) {
        // Possible blank/separator row — skip.
        if (globalRow > 200) break; // safety guard
        continue;
      }

      const head = currentHead || "Unresolved source head";
      if (!headsMap.has(head)) {
        headsMap.set(head, {
          head,
          total: 0,
          parties: [],
          buckets: [],
          members: [],
          reconciliation: exactDifference(0, 0),
          coverage: coverageFor(0, 0, 0, 0, 0),
          candidateQty: 0,
          safeQty: 0,
          conflictQty: 0,
          disputedQty: 0,
          unassignedQty: 0,
          candidateCoveragePct: 0,
          safeCoveragePct: 0,
          conflictCostPp: 0,
        });
      }
      const headEntry = headsMap.get(head)!;

      const byGroup: Record<string, number> = {};
      for (let ci = 4; ci < Math.min(row.length, FORMULA_COL_START); ci++) {
        const groupIdx = ci - 4;
        if (groupIdx >= groups.length) break;
        const v = numVal(row[ci]);
        if (v > 0) byGroup[groups[groupIdx]] = v;
      }

      headEntry.parties.push({
        party,
        total: qty,
        byGroup,
        classification: "None",
        candidateEvidence: [],
        attributionLink: null,
        attribution: {
          classification: "None",
          candidateCount: 0,
          candidates: [],
          conflictEvidence: [],
          conflictLink: null,
        },
        reconciliation: exactDifference(qty, Object.values(byGroup).reduce((sum, value) => sum + value, 0)),
      });
      headEntry.total += qty;
      grandTotal += qty;
    }
  });

  // Also pick up grand total from the totals row (row 2 in sheet, before header).
  // If we computed it from data rows it should match; prefer the data sum.
  if (grandTotal === 0) {
    // Sheet had no data rows; use computed from row 2 if we can.
    logger.warn("factoryPending: no data rows found in REPORT 2");
  }

  const byHead = Array.from(headsMap.values());
  return { groups, grandTotal, byHead };
}

function fmtInr(value: number | null | undefined): string {
  return value == null ? "" : `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The Group Rates tab is intentionally kept stable for downstream consumers. */
function obsoleteRenderer(workbook: ExcelJS.Workbook, result: FactoryPendingResult): void {
  const amountAvailable = result.pricingAvailable === true;
  const INR = "₹#,##0.00";
  const QTY = "#,##0";
  const PCT = "0.00%";
  const format = (sheet: ExcelJS.Worksheet, widths: number[]) => {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + Math.min(widths.length, 26))}1` };
    sheet.columns.forEach((column, index) => { column.width = widths[index] ?? 18; });
  };
  if (true) {
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Measure / Fact", key: "fact", width: 34 },
    { header: "Value", key: "value", width: 22 },
    { header: "Basis / Note", key: "note", width: 110 },
  ];
  summary.addRows([
    ["Factory pending quantity", result.grandTotal, "REPORT 2 balance quantity (pieces)"],
    ["Priced pending", amountAvailable ? (result.pricedAmount ?? null) : null, PRICE_BASIS],
    ["Unpriceable pieces", amountAvailable ? (result.unpriceableQty ?? null) : null, "Residual plus missing-rate product groups"],
    ["Derived pending (OB minus Sale)", result.derived.pending, "Related operational measure; no common order key"],
    ["Non-territory derived pending", result.derived.nonTerritoryPending, "Project/GOVT/GEM/JJM/Other; OB minus Sale"],
    ["Comparability statement", null, "These are related operational measures with no common order key and are not directly comparable. Derived pending includes non-territory OB-minus-Sale balances that REPORT 2 cannot identify or order-match."],
    ["Pricing error", result.pricingError ?? null, "Quantity remains available when pricing is unavailable"],
  ]);
  format(summary, [34, 22, 110]);
  summary.getColumn(2).numFmt = INR;
  summary.getCell("B2").numFmt = QTY;
  summary.getCell("B4").numFmt = QTY;
  summary.getCell("B5").numFmt = INR;
  summary.getCell("B6").numFmt = INR;

  const auditSheet = workbook.addWorksheet("AuditSheet");
  auditSheet.columns = [
    { header: "Level", key: "level", width: 16 }, { header: "State Head", key: "head", width: 22 },
    { header: "Bucket/Member", key: "bucket", width: 30 }, { header: "Party", key: "party", width: 34 },
    { header: "Product Group", key: "group", width: 24 }, { header: "Quantity", key: "quantity", width: 14 },
    { header: "Quantity Parent", key: "quantityParent", width: 16 }, { header: "Quantity Children", key: "quantityChildren", width: 17 },
    { header: "Quantity Difference", key: "quantityDifference", width: 18 }, { header: "Priced Amount", key: "amount", width: 18 },
    { header: "Amount Parent", key: "amountParent", width: 16 }, { header: "Amount Children", key: "amountChildren", width: 17 },
    { header: "Amount Difference", key: "amountDifference", width: 17 }, { header: "Unpriceable Pieces", key: "unpriceable", width: 18 },
    { header: "Classification", key: "classification", width: 28 },
  ];
  const addAuditRow = (row: Record<string, unknown>) => auditSheet.addRow(row);
  addAuditRow({
    level: "Company",
    quantity: result.grandTotal,
    quantityParent: result.reconciliation.company.parent,
    quantityChildren: result.reconciliation.company.children,
    quantityDifference: result.reconciliation.company.difference,
    amount: amountAvailable ? (result.pricedAmount ?? null) : null,
    amountParent: amountAvailable ? (result.amountReconciliation?.company.parent ?? null) : null,
    amountChildren: amountAvailable ? (result.amountReconciliation?.company.children ?? null) : null,
    amountDifference: amountAvailable ? (result.amountReconciliation?.company.difference ?? null) : null,
    unpriceable: amountAvailable ? (result.unpriceableQty ?? null) : null,
    classification: "Company total",
  });
  for (const head of result.byHead) {
    addAuditRow({ level: "Head", head: head.head, quantity: head.total, quantityParent: head.reconciliation.parent,
      quantityChildren: head.reconciliation.children, quantityDifference: head.reconciliation.difference,
      amount: amountAvailable ? (head.pricedAmount ?? null) : null, amountParent: amountAvailable ? (head.amountReconciliation?.parent ?? null) : null,
      amountChildren: amountAvailable ? (head.amountReconciliation?.children ?? null) : null, amountDifference: amountAvailable ? (head.amountReconciliation?.difference ?? null) : null,
      unpriceable: amountAvailable ? (head.unpriceableQty ?? null) : null, classification: "State Head total" });
    for (const bucket of head.buckets) {
      const label = bucket.bucket === "Attribution Conflicts" ? "Disputed (Attribution Conflicts)" : bucket.bucket === "Unassigned" ? "Unassigned" : bucket.member ?? bucket.bucket;
      addAuditRow({ level: "Bucket/Member", head: head.head, bucket: label, quantity: bucket.total, quantityParent: bucket.reconciliation.parent,
        quantityChildren: bucket.reconciliation.children, quantityDifference: bucket.reconciliation.difference,
        amount: amountAvailable ? (bucket.pricedAmount ?? null) : null, amountParent: amountAvailable ? (bucket.amountReconciliation?.parent ?? null) : null,
        amountChildren: amountAvailable ? (bucket.amountReconciliation?.children ?? null) : null, amountDifference: amountAvailable ? (bucket.amountReconciliation?.difference ?? null) : null,
        unpriceable: amountAvailable ? (bucket.unpriceableQty ?? null) : null, classification: bucket.specialBucket ? bucket.bucket : "Named member bucket" });
      for (const party of bucket.parties) {
        addAuditRow({ level: "Party", head: head.head, bucket: label, party: party.party, quantity: party.total,
          quantityParent: party.reconciliation.parent, quantityChildren: party.reconciliation.children, quantityDifference: party.reconciliation.difference,
          amount: amountAvailable ? (party.pricedAmount ?? null) : null, amountParent: amountAvailable ? (party.amountReconciliation?.parent ?? null) : null,
          amountChildren: amountAvailable ? (party.amountReconciliation?.children ?? null) : null, amountDifference: amountAvailable ? (party.amountReconciliation?.difference ?? null) : null,
          unpriceable: amountAvailable ? (party.unpriceableQty ?? null) : null, classification: party.attribution.classification });
        for (const group of result.groups) {
          const quantity = party.byGroup[group] ?? 0;
          const amount = party.byGroupAmount?.[group] ?? null;
          if (quantity <= 0 && amount == null) continue;
          addAuditRow({ level: "Product Group", head: head.head, bucket: label, party: party.party, group,
            quantity: quantity || null, quantityParent: quantity || null, quantityChildren: quantity || null, quantityDifference: quantity ? 0 : null,
            amount: amountAvailable ? amount : null, amountParent: amountAvailable ? amount : null, amountChildren: amountAvailable ? amount : null,
            amountDifference: amountAvailable && amount != null ? 0 : null, unpriceable: amountAvailable && quantity > 0 && amount == null ? quantity : null,
            classification: party.attribution.classification });
        }
      }
    }
  }
  format(auditSheet, [16, 22, 30, 34, 24, 14, 16, 17, 18, 18, 16, 17, 17, 18, 28]);
  for (const column of [6, 7, 8, 9, 14]) auditSheet.getColumn(column).numFmt = QTY;
  for (const column of [10, 11, 12, 13]) auditSheet.getColumn(column).numFmt = INR;

  }
  const rates = workbook.addWorksheet("Group Rates");
  rates.columns = [
    { header: "Source Group", key: "sourceGroup", width: 24 }, { header: "Canonical Group", key: "canonicalGroup", width: 28 },
    { header: "Pending Pieces", key: "pending", width: 16 }, { header: "Share of Factory Pending %", key: "factoryShare", width: 24 },
    { header: "Share of Allocated Pending %", key: "allocatedShare", width: 25 }, { header: "Realised Rate Used", key: "rate", width: 20 },
    { header: "Contributing FY Sales Value", key: "sales", width: 26 }, { header: "Contributing Code Count", key: "codes", width: 24 },
    { header: "Source Period", key: "period", width: 16 }, { header: "Source", key: "source", width: 30 }, { header: "Robustness Flag/Note", key: "note", width: 90 },
  ];
  const pendingByGroup = new Map(result.groups.map((group) => [group, result.byHead.reduce((sum, head) => sum + head.parties.reduce((s, party) => s + (party.byGroup[group] ?? 0), 0), 0)]));
  const allocatedTotal = result.groups.reduce((sum, group) => sum + (result.pricing?.byGroup[group]?.averageRealisedRate != null ? (pendingByGroup.get(group) ?? 0) : 0), 0);
  for (const group of result.groups) {
    const metadata = result.pricing?.byGroup[group];
    const pending = pendingByGroup.get(group) ?? 0;
    const rate = amountAvailable ? (metadata?.averageRealisedRate ?? null) : null;
    const sales = amountAvailable ? (metadata?.contributingSalesAmount ?? null) : null;
    const thin = metadata?.contributingSalesAmount != null && metadata.contributingSalesAmount < 100000;
    const pprNote = metadata?.canonicalGroup === "PPR" && rate != null && sales != null
      ? `PPR rate ${fmtInr(rate)} is based on ${fmtInr(sales)} FY sales and applied to ${pending.toLocaleString("en-IN")} pending pieces.`
      : "";
    rates.addRow({ sourceGroup: group, canonicalGroup: metadata?.canonicalGroup ?? null, pending: pending || 0,
      factoryShare: result.grandTotal > 0 ? pending / result.grandTotal : null, allocatedShare: allocatedTotal > 0 && rate != null ? pending / allocatedTotal : null,
      rate, sales, codes: metadata?.contributingCodeCount ?? null, period: "FY2026-27", source: "sale_line_current (current)",
      note: thin ? `Thin sales (< ₹100,000): ${fmtInr(sales)} FY sales. ${pprNote}` : pprNote || (metadata?.averageRealisedRate == null ? "No usable realised rate; amount unavailable" : "") });
  }
  format(rates, [24, 28, 16, 24, 25, 20, 26, 24, 16, 30, 90]);
  rates.getColumn(3).numFmt = QTY; rates.getColumn(4).numFmt = PCT; rates.getColumn(5).numFmt = PCT; rates.getColumn(6).numFmt = INR; rates.getColumn(7).numFmt = INR;

  if (true) {
  const unpriceable = workbook.addWorksheet("Unpriceable");
  unpriceable.columns = [
    { header: "State Head", key: "head", width: 24 }, { header: "Bucket/Member", key: "bucket", width: 30 }, { header: "Party", key: "party", width: 34 },
    { header: "Source Total Pieces", key: "source", width: 20 }, { header: "Allocated Group Pieces", key: "allocated", width: 22 },
    { header: "Unallocated Residual Pieces", key: "residual", width: 26 }, { header: "Missing-Rate Pieces", key: "missing", width: 22 },
    { header: "Total Unpriceable Pieces", key: "total", width: 25 }, { header: "Reason", key: "reason", width: 90 },
  ];
  if (amountAvailable) for (const head of result.byHead) for (const bucket of head.buckets) for (const party of bucket.parties) {
    const allocated = Object.values(party.byGroup).reduce((sum, qty) => sum + qty, 0);
    const residual = Math.max(0, party.total - allocated);
    const missing = Object.entries(party.byGroup).reduce((sum, [group, qty]) => sum + (qty > 0 && party.byGroupAmount?.[group] == null ? qty : 0), 0);
    const total = residual + missing;
    if (total > 0) unpriceable.addRow({ head: head.head, bucket: bucket.bucket === "Attribution Conflicts" ? "Disputed (Attribution Conflicts)" : bucket.bucket, party: party.party, source: party.total, allocated, residual, missing, total, reason: party.unpriceableReason });
  }
  format(unpriceable, [24, 30, 34, 20, 22, 26, 22, 25, 90]);
  for (const column of [4, 5, 6, 7, 8]) unpriceable.getColumn(column).numFmt = QTY;

  const info = workbook.addWorksheet("Info");
  info.columns = [{ header: "Field", key: "field", width: 34 }, { header: "Value", key: "value", width: 120 }];
  info.addRows([
    ["Price basis", PRICE_BASIS],
    ["Amount is", "Pending quantity × average realised price per product group, FY2026-27; estimated worth of outstanding orders."],
    ["Amount is NOT", "Not total pending stock, not financial order-book pending, not an amount to invoice, not the same orders as OB-minus-Sale, and not a reconciliation to derived pending."],
    ["Population scope", "REPORT 2 carries product groups, not item codes; there is no common order key to match REPORT 2 rows to OB-minus-Sale."],
    ["Derived pending note", `Non-territory (Project/GOVT/GEM/JJM/Other) OB-minus-Sale is ${result.derived.nonTerritoryPending == null ? "unavailable" : fmtInr(result.derived.nonTerritoryPending)} and REPORT 2 cannot identify/order-match those balances.`],
    ["Attribution coverage", `Candidate ${result.candidateCoveragePct ?? "unavailable"}%; safe ${result.safeCoveragePct ?? "unavailable"}%; disputed ${result.coverage.disputedQty ?? "unavailable"} pieces.`],
    ["Allocation/unpriceable", "Product-group quantities are allocated only with a usable positive realised rate. Total-minus-group residuals and missing-rate groups are unpriceable; missing rates are null, never zero."],
    ["Units", "REPORT 2 quantities are pieces. Water tank realised pricing is per tank; mapped denominators use qty when qty_ltr exists, otherwise qty / canonical litres."],
    ["PPR robustness", "Thin sales means contributing FY sales value below ₹100,000; Group Rates reports the current rate, sales value, and pending pieces dynamically."],
    ["Source period/source", "FY2026-27 sale_line_current, version_status=current"],
    ["Computed at / data read", result.computedAt],
    ["Pricing error", result.pricingError ?? null],
  ]);
  format(info, [34, 120]);
  }
}

function addGroupRatesSheet(workbook: ExcelJS.Workbook, result: FactoryPendingResult): void {
  const sheet = workbook.addWorksheet("Group Rates");
  sheet.columns = [
    { header: "Source Group", width: 24 }, { header: "Canonical Group", width: 28 },
    { header: "Pending Pieces", width: 16 }, { header: "Share of Factory Pending %", width: 24 },
    { header: "Share of Allocated Pending %", width: 25 }, { header: "Realised Rate Used", width: 20 },
    { header: "Contributing FY Sales Value", width: 26 }, { header: "Contributing Code Count", width: 24 },
    { header: "Source Period", width: 16 }, { header: "Source", width: 30 }, { header: "Robustness Flag/Note", width: 90 },
  ];
  const pending = (group: string) => result.byHead.reduce((sum, h) =>
    sum + h.parties.reduce((s, p) => s + (p.byGroup[group] ?? 0), 0), 0);
  const allocated = result.groups.reduce((sum, group) =>
    sum + (result.pricing?.byGroup[group]?.averageRealisedRate != null ? pending(group) : 0), 0);
  for (const group of result.groups) {
    const metadata = result.pricing?.byGroup[group];
    const qty = pending(group);
    const rate = result.pricingAvailable === true ? (metadata?.averageRealisedRate ?? null) : null;
    const sales = result.pricingAvailable === true ? (metadata?.contributingSalesAmount ?? null) : null;
    const thin = sales != null && sales < 100000;
    const pprNote = metadata?.canonicalGroup === "PPR" && rate != null && sales != null
      ? `PPR rate ${fmtInr(rate)} is based on ${fmtInr(sales)} FY sales and applied to ${qty.toLocaleString("en-IN")} pending pieces.`
      : "";
    sheet.addRow([group, metadata?.canonicalGroup ?? null, qty,
      result.grandTotal > 0 ? qty / result.grandTotal : null,
      allocated > 0 && rate != null ? qty / allocated : null, rate, sales,
      metadata?.contributingCodeCount ?? null, "FY2026-27", "sale_line_current (current)",
      thin ? `Thin sales (< ₹100,000): ${fmtInr(sales)} FY sales. ${pprNote}` :
        pprNote || (metadata?.averageRealisedRate == null ? "No usable realised rate; amount unavailable" : "")]);
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn(3).numFmt = "#,##0"; sheet.getColumn(4).numFmt = "0.00%";
  sheet.getColumn(5).numFmt = "0.00%"; sheet.getColumn(6).numFmt = "₹#,##0.00";
  sheet.getColumn(7).numFmt = "₹#,##0.00";
}

/** Six-tab audit export.  The hierarchy is deliberately represented twice:
 * Summary is for reading, while Reconciliation is for arithmetic review. */
export function buildFactoryPendingWorkbook(result: FactoryPendingResult): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const amountAvailable = result.pricingAvailable === true;
  const QTY = "#,##0";
  const INR = "₹#,##0.00";
  const PCT = "0.00%";
  const SUMMARY_QTY = "#,##,##0";
  const SUMMARY_INR = "₹#,##,##0.00";
  const SUMMARY_PCT = "0.0%";
  const SIGN_CONVENTION =
    "Order vs Sale sign: positive = ordered and not yet dispatched; negative = dispatched more than booked this period, drawing down earlier orders.";
  const COMMERCIAL_FILL = "FFE2F0D9";
  const PENDING_FILL = "FFD9EAF7";
  const UNAVAILABLE_FILL = "FFE7E6E6";
  const divider = { style: "medium" as const, color: { argb: "FF4472C4" } };
  const dash = (v: unknown): unknown => v == null || v === "" || v === "None" ? "—" : v;
  const setup = (sheet: ExcelJS.Worksheet, freeze = 1, filter = true) => {
    sheet.views = [{ state: "frozen", ySplit: freeze }];
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    if (filter) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  };
  const addSummaryRow = (sheet: ExcelJS.Worksheet, row: unknown[], fill = true) => {
    const values = fill ? row.map(dash) : row.slice();
    if (sheet.name === "Summary" && typeof values[4] === "number") values[4] = Math.round((values[4] as number) * 100) / 100;
    const r = sheet.addRow(values);
    r.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; });
    return r;
  };
  const commercialAggregate = (parties: PendingParty[]) => {
    const matched = parties.filter(
      (party): party is PendingParty & { commercial: PendingCommercialMatch } =>
        party.commercial?.available === true,
    );
    const totalOrder = matched.reduce((sum, party) => sum + party.commercial.totalOrder, 0);
    const sale = matched.reduce((sum, party) => sum + party.commercial.sale, 0);
    const assignedMembers = matched.reduce(
      (sum, party) => sum + party.commercial.assignedMembers,
      0,
    );
    const difference = totalOrder - sale;
    return {
      matched: matched.length,
      total: parties.length,
      totalOrder: matched.length ? totalOrder : null,
      sale: matched.length ? sale : null,
      difference: matched.length ? difference : null,
      differencePct:
        matched.length && totalOrder !== 0 ? difference / totalOrder : null,
      assignedMembers: matched.length ? assignedMembers : null,
      avgOrderBooking:
        matched.length && assignedMembers > 0
          ? totalOrder / assignedMembers
          : null,
      perPersonPerMonth:
        matched.length && assignedMembers > 0
          ? totalOrder / assignedMembers / 12
          : null,
    };
  };
  const annotateCommercial = (
    row: ExcelJS.Row,
    aggregate: ReturnType<typeof commercialAggregate>,
    startColumn: number,
  ) => {
    if (aggregate.matched === aggregate.total) return;
    const reason =
      aggregate.matched === 0
        ? `Commercial measures unavailable: 0 of ${aggregate.total} parties matched by normParty.`
        : `Partial commercial measures: ${aggregate.matched} of ${aggregate.total} parties matched by normParty; unmatched parties are excluded.`;
    for (let column = startColumn; column < startColumn + 7; column++) {
      const cell = row.getCell(column);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: UNAVAILABLE_FILL },
      };
      cell.note = reason;
    }
  };
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { width: 25 }, { width: 30 }, { width: 14 },
    { width: 18 }, { width: 18 }, { width: 20 }, { width: 18 },
    { width: 18 }, { width: 20 }, { width: 20 },
    { width: 16 }, { width: 18 }, { width: 18 },
    { width: 16 }, { width: 28 }, { width: 28 },
  ];
  [4, 5, 6, 9, 10, 12].forEach((column) => summary.getColumn(column).numFmt = SUMMARY_INR);
  summary.getColumn(7).numFmt = "0.00%";
  [3, 8, 11, 13].forEach((column) => summary.getColumn(column).numFmt = SUMMARY_QTY);
  summary.getColumn(14).numFmt = SUMMARY_PCT;
  const blockRows = (head: PendingHead, company = false) => {
    const coverage = head.safeCoveragePct == null ? null : head.safeCoveragePct / 100;
    const title = company ? "Company" : head.head;
    const labels = summary.addRow([null, "State Head", "State", "Coverage"]);
    labels.font = { bold: true };
    const identity = summary.addRow([null, title, null, coverage ?? "Unavailable"]);
    if (coverage != null) identity.getCell(4).numFmt = `${SUMMARY_PCT} "mapped"`;
    if (company) {
      identity.getCell(5).value = SIGN_CONVENTION;
      identity.getCell(5).font = { italic: true, color: { argb: "FF7F6000" } };
      identity.getCell(5).alignment = { wrapText: true, vertical: "top" };
      identity.height = 34;
    }
    summary.addRow([]);
    const total = head.total;
    const totalCommercial = commercialAggregate(head.parties);
    const totalRow = addSummaryRow(summary, [null, null, null, "TOTAL", head.parties.length,
      totalCommercial.totalOrder, totalCommercial.sale, totalCommercial.difference,
      totalCommercial.differencePct, totalCommercial.assignedMembers,
      totalCommercial.avgOrderBooking, totalCommercial.perPersonPerMonth,
      total, amountAvailable ? head.pricedAmount : null,
      amountAvailable ? head.unpriceableQty : null], false);
    totalRow.font = { bold: true };
    totalRow.getCell(5).numFmt = SUMMARY_QTY;
    [6, 7, 8, 11, 12, 14].forEach((column) => totalRow.getCell(column).numFmt = SUMMARY_INR);
    totalRow.getCell(9).numFmt = "0.00%";
    [10, 13, 15].forEach((column) => totalRow.getCell(column).numFmt = SUMMARY_QTY);
    annotateCommercial(totalRow, totalCommercial, 6);
    const columns = ["State", "Member", "Parties", "Total Order", "Sale",
      "Difference (Order vs Sale)", "Difference %", "Assigned members",
      "AVG Order Booking", "Per Person per month", "Pending qty",
      "Priced pending", "Unpriceable qty", "Share of head",
      "Largest group", "Second group"];
    const repeated = summary.addRow(columns);
    repeated.font = { bold: true, color: { argb: "FFFFFFFF" } };
    for (let column = 1; column <= repeated.cellCount; column++) {
      const cell = repeated.getCell(column);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: column >= 4 && column <= 10 ? "FF548235" : column >= 11 && column <= 13 ? "FF1F4E78" : "FF595959" },
      };
    }
    repeated.getCell(10).border = { right: divider };
    if (company) {
      for (const child of result.byHead) {
        const commercial = commercialAggregate(child.parties);
        const childGroups = Object.entries(child.parties.reduce<Record<string, number>>((m, p) => {
          for (const [g, q] of Object.entries(p.byGroup)) m[g] = (m[g] ?? 0) + q;
          return m;
        }, {})).sort((a, b) => b[1] - a[1]);
        const row = addSummaryRow(summary, [child.head, null, child.parties.length,
          commercial.totalOrder, commercial.sale, commercial.difference,
          commercial.differencePct, commercial.assignedMembers,
          commercial.avgOrderBooking, commercial.perPersonPerMonth,
          child.total, amountAvailable ? child.pricedAmount : null,
          amountAvailable ? child.unpriceableQty : null,
          total > 0 ? child.total / total : null,
          childGroups[0] ? `${childGroups[0][0]} (${childGroups[0][1].toLocaleString("en-IN")})` : null,
          childGroups[1] ? `${childGroups[1][0]} (${childGroups[1][1].toLocaleString("en-IN")})` : null], false);
        annotateCommercial(row, commercial, 4);
        row.getCell(10).border = { right: divider };
      }
      summary.addRow([]);
      return;
    }
    const buckets = head.buckets.length ? head.buckets : [{ bucket: "- Not assigned -", member: null, specialBucket: true, total: total, parties: head.parties, reconciliation: head.reconciliation }];
    const rank = (bucket: PendingBucket): number =>
      bucket.bucket === "Attribution Conflicts" ? 2 : bucket.specialBucket ? 1 : 0;
    const ordered = buckets.slice().sort((a, b) => rank(a) - rank(b));
    for (const bucket of ordered) {
      const commercial = commercialAggregate(bucket.parties);
      const group = (bucket.parties.length ? Object.entries(bucket.parties.reduce<Record<string, number>>((m, p) => {
        for (const [g, q] of Object.entries(p.byGroup)) m[g] = (m[g] ?? 0) + q; return m;
      }, {})).sort((a, b) => b[1] - a[1]) : []);
      const partyCount = bucket.parties.length;
      const bucketLabel = bucket.bucket === "Attribution Conflicts" || bucket.bucket === "Disputed attribution"
        ? "- Disputed attribution -" : bucket.specialBucket ? "- Not assigned -" : (bucket.member ?? bucket.bucket);
      const row = addSummaryRow(summary, [title, bucketLabel, partyCount,
        commercial.totalOrder, commercial.sale, commercial.difference,
        commercial.differencePct, commercial.assignedMembers,
        commercial.avgOrderBooking, commercial.perPersonPerMonth,
        bucket.total, amountAvailable ? bucket.pricedAmount : null,
        amountAvailable ? bucket.unpriceableQty : null,
        total > 0 ? bucket.total / total : null,
        group[0] ? `${group[0][0]} (${group[0][1].toLocaleString("en-IN")})` : null,
        group[1] ? `${group[1][0]} (${group[1][1].toLocaleString("en-IN")})` : null], false);
      annotateCommercial(row, commercial, 4);
      row.getCell(10).border = { right: divider };
    }
    summary.addRow([]);
  };
  const company: PendingHead = {
    ...result.byHead[0], head: "Company", total: result.grandTotal,
    parties: result.byHead.flatMap((h) => h.parties),
    buckets: result.byHead.map((h) => ({ bucket: h.head, member: h.head, specialBucket: false, total: h.total, parties: h.parties, reconciliation: h.reconciliation })),
    pricedAmount: result.pricedAmount, unpriceableQty: result.unpriceableQty,
    safeCoveragePct: result.safeCoveragePct,
  };
  blockRows(company, true);
  for (const head of result.byHead) blockRows(head);
  summary.views = [{ state: "frozen", ySplit: 5 }];

  const detail = workbook.addWorksheet("Detail");
  detail.columns = [{ width: 25 }, { width: 30 }, { width: 35 },
    { width: 18 }, { width: 18 }, { width: 20 }, { width: 18 }, { width: 18 },
    { width: 20 }, { width: 20 }, { width: 16 }, { width: 18 }, { width: 18 },
    ...result.groups.map(() => ({ width: 16 }))];
  const detailNote = detail.addRow([SIGN_CONVENTION]);
  detail.mergeCells(1, 1, 1, detail.columnCount);
  detailNote.font = { italic: true, color: { argb: "FF7F6000" } };
  const detailHeader = detail.addRow(["State head", "Member or bucket", "Party",
    "Total Order", "Sale", "Difference (Order vs Sale)", "Difference %",
    "Assigned members", "AVG Order Booking", "Per Person per month",
    "Pending qty", "Priced pending", "Unpriceable qty", ...result.groups]);
  detailHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  for (let column = 1; column <= detail.columnCount; column++) {
    detailHeader.getCell(column).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: column >= 4 && column <= 10 ? "FF548235" : column >= 11 ? "FF1F4E78" : "FF595959" },
    };
  }
  detailHeader.getCell(10).border = { right: divider };
  for (const head of result.byHead) for (const bucket of head.buckets) for (const p of bucket.parties) {
    const bucketLabel = bucket.bucket === "Attribution Conflicts" || bucket.bucket === "Disputed attribution"
      ? "- Disputed attribution -" : bucket.specialBucket ? "- Not assigned -" : (bucket.member ?? bucket.bucket);
    const commercial = p.commercial?.available === true ? p.commercial : null;
    const row = addSummaryRow(detail, [head.head, bucketLabel, p.party,
      commercial?.totalOrder ?? null, commercial?.sale ?? null,
      commercial?.difference ?? null, commercial?.differencePct ?? null,
      commercial?.assignedMembers ?? null, commercial?.avgOrderBooking ?? null,
      commercial?.perPersonPerMonth ?? null, p.total,
      amountAvailable && p.pricedAmount != null ? Math.round(p.pricedAmount * 100) / 100 : null,
      amountAvailable ? p.unpriceableQty : null,
      ...result.groups.map((g) => Object.prototype.hasOwnProperty.call(p.byGroup, g) ? p.byGroup[g] : null)], false);
    row.getCell(10).border = { right: divider };
    if (!commercial) {
      const reason = p.commercial?.unavailableReason ?? "Commercial source unavailable";
      for (let column = 4; column <= 10; column++) {
        const cell = row.getCell(column);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: UNAVAILABLE_FILL } };
        cell.note = reason;
      }
    }
  }
  detail.views = [{ state: "frozen", ySplit: 2 }];
  detail.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: detail.columnCount } };
  [4, 5, 6, 9, 10, 12].forEach((column) => detail.getColumn(column).numFmt = INR);
  detail.getColumn(7).numFmt = "0.00%";
  [8, 11, 13].forEach((column) => detail.getColumn(column).numFmt = QTY);
  for (let i = 14; i <= detail.columnCount; i++) detail.getColumn(i).numFmt = QTY;

  addGroupRatesSheet(workbook, result);

  const unpriceable = workbook.addWorksheet("Unpriceable");
  unpriceable.columns = [{ header: "State Head", width: 25 }, { header: "Bucket/Member", width: 30 }, { header: "Party", width: 35 },
    { header: "Source Total Pieces", width: 20 }, { header: "Allocated Group Pieces", width: 22 }, { header: "Unallocated Residual Pieces", width: 26 },
    { header: "Missing-Rate Pieces", width: 22 }, { header: "Total Unpriceable Pieces", width: 25 }, { header: "Reason Code", width: 18 }];
  const urows: unknown[][] = [];
  if (amountAvailable) for (const head of result.byHead) for (const bucket of head.buckets) for (const p of bucket.parties) {
    const allocated = Object.values(p.byGroup).reduce((a, b) => a + b, 0);
    const residual = Math.max(0, p.total - allocated);
    const missing = Object.entries(p.byGroup).reduce((a, [g, q]) => a + (q > 0 && p.byGroupAmount?.[g] == null ? q : 0), 0);
    const label = bucket.bucket === "Attribution Conflicts" || bucket.bucket === "Disputed attribution"
      ? "- Disputed attribution -" : bucket.specialBucket ? "- Not assigned -" : (bucket.member ?? bucket.bucket);
    if (residual + missing > 0) urows.push([head.head, label, p.party, p.total, allocated, residual, missing, residual + missing,
      residual > 0 && missing > 0 ? "RESIDUAL_AND_RATE" : residual > 0 ? "RESIDUAL" : "MISSING_RATE"]);
  }
  urows.sort((a, b) => Number(b[5]) - Number(a[5]) || Number(b[6]) - Number(a[6]) || Number(b[7]) - Number(a[7]));
  urows.forEach((r) => addSummaryRow(unpriceable, r)); setup(unpriceable);
  for (let i = 4; i <= 8; i++) unpriceable.getColumn(i).numFmt = QTY;

  const reconciliation = workbook.addWorksheet("Reconciliation");
  reconciliation.columns = [{ header: "Level", width: 14 }, { header: "State head", width: 25 }, { header: "Member/bucket", width: 30 }, { header: "Party", width: 35 },
    { header: "Quantity parent", width: 18 }, { header: "Quantity children", width: 20 }, { header: "Quantity difference", width: 20 }, { header: "Quantity exact", width: 15 },
    { header: "Amount parent", width: 18 }, { header: "Amount children", width: 20 }, { header: "Amount difference", width: 20 }, { header: "Amount exact", width: 15 }, { header: "Source / basis", width: 48 }];
  const paise = (v: number | null | undefined): number | null =>
    v == null ? null : Math.round(v * 100) / 100;
  const recon = (level: string, head: string, bucket: string, party: string, q: ReconciliationCheck, a?: ReconciliationCheck) =>
    addSummaryRow(reconciliation, [level, head, bucket, party, q.parent, q.children, q.difference, q.exact,
      paise(a?.parent), paise(a?.children), paise(a?.difference), a?.exact ?? null,
      "Quantity: REPORT 2; amount: REPORT 2 × sale_line_current"], false);
  recon("Company", "Company", "—", "—", result.reconciliation.company,
    amountAvailable ? result.amountReconciliation?.company : undefined);
  for (const h of result.byHead) {
    recon("Head", h.head, "—", "—", h.reconciliation,
      amountAvailable ? h.amountReconciliation : undefined);
    for (const b of h.buckets) {
      recon("Bucket", h.head, b.member ?? b.bucket, "—", b.reconciliation,
        amountAvailable ? b.amountReconciliation : undefined);
      for (const p of b.parties) {
        recon("Party", h.head, b.member ?? b.bucket, p.party, p.reconciliation,
          amountAvailable ? p.amountReconciliation : undefined);
      }
    }
  }
  setup(reconciliation); [5, 6, 7].forEach((i) => reconciliation.getColumn(i).numFmt = QTY); [9, 10, 11].forEach((i) => reconciliation.getColumn(i).numFmt = INR);

  const info = workbook.addWorksheet("Info");
  info.columns = [{ header: "Field", width: 38 }, { header: "Value", width: 120 }, { header: "Source / basis", width: 80 }];
  [["Commercial Order vs Sale", "Total Order and Sale are FY2025-26 rupee measures. Difference = Total Order − Sale; Difference % = Difference ÷ Total Order.", PENDING_COMMERCIAL_SOURCE],
    ["Commercial sign convention", "Positive = ordered and not yet dispatched. Negative = dispatched more than booked this period, drawing down earlier orders; it is not a shortfall.", PENDING_COMMERCIAL_SOURCE],
    ["Commercial party match", `${result.commercialCoverage?.matchedParties ?? 0} of ${result.commercialCoverage?.totalParties ?? result.byHead.flatMap((head) => head.parties).length} REPORT 2 parties matched; ${result.commercialCoverage?.unmatchedParties ?? "unavailable"} unmatched; ${result.commercialCoverage?.ambiguousParties ?? "unavailable"} ambiguous.`, "Exact normParty match; no fuzzy fallback"],
    ["Commercial Summary totals", "Commercial totals sum matched party rows only. Grey cells have an Excel note stating incomplete match coverage; unmatched parties remain blank, never zero.", PENDING_COMMERCIAL_SOURCE],
    ["Assigned members", "Count comes from the dashboard distributor row and supports AVG Order Booking and Per Person per month. It is not the current pending-hierarchy attribution count.", PENDING_COMMERCIAL_SOURCE],
    ["Commercial versus REPORT 2", "Order/Sale/Difference are rupees from the dashboard. Pending qty is pieces from REPORT 2. They are independently sourced and have no common order key.", `${PENDING_COMMERCIAL_SOURCE}; REPORT 2`],
    ["Price basis", PRICE_BASIS, "sale_line_current"],
    ["Amount is", "Pending quantity × average realised price per product group, FY2026-27; estimated worth of outstanding orders.", "REPORT 2 × sale_line_current"],
    ["Amount is NOT", "Not total pending stock, not financial order-book pending, not an amount to invoice, not the same orders as OB-minus-Sale, and not a reconciliation to derived pending.", "Basis limitation"],
    ["Population scope", "REPORT 2 carries product groups, not item codes; there is no common order key to match REPORT 2 rows to OB-minus-Sale.", "REPORT 2"],
    ["Derived pending note", "Non-territory OB-minus-Sale cannot be identified or order-matched in REPORT 2.", "OB-minus-Sale versus REPORT 2"],
    ["Attribution coverage", `Candidate ${result.candidateCoveragePct ?? "unavailable"}%; safe ${result.safeCoveragePct ?? "unavailable"}%; disputed ${result.coverage.disputedQty ?? "unavailable"} pieces.`, "customer_assignment/person"],
    ["Allocation/unpriceable", "Product-group quantities are allocated only with a usable positive realised rate. Residuals and missing-rate groups are unpriceable; missing rates are null, never zero.", "REPORT 2 and sale_line_current"],
    ["Units", "REPORT 2 quantities are pieces. Water tank realised pricing is per tank; mapped denominators use qty when qty_ltr exists, otherwise qty / canonical litres.", "REPORT 2 and tank mapping"],
    ["PPR robustness", "Thin sales means contributing FY sales value below ₹100,000; Group Rates reports rate, sales value, and pending pieces dynamically.", "sale_line_current"],
    ["Source period/source", "FY2026-27 sale_line_current, version_status=current", "sale_line_current"],
    ["Factory pending qty", result.grandTotal, "REPORT 2 balance qty, pieces"],
    ["Priced pending", result.pricedAmount, "REPORT 2 × sale_line_current realised rates"],
    ["Unpriceable pieces", result.unpriceableQty, "REPORT 2 residual and missing-rate groups"],
    ["Derived pending", result.derived.pending, "Order book minus sale; no common order key"],
    ["Non-territory derived pending", result.derived.nonTerritoryPending, "OB-minus-Sale non-territory heads"],
    ["Comparability", "Related measures are not directly comparable; REPORT 2 cannot be order-matched.", "REPORT 2 versus OB-minus-Sale"],
    ["Pricing error", result.pricingError, "Pricing loader"],
    ["Computed / data-read timestamp", result.computedAt, "Application computation and source read"]].forEach((r) => addSummaryRow(info, r));
  addSummaryRow(info, ["Reason codes", "RESIDUAL = source total exceeds allocated groups; MISSING_RATE = group has no positive realised rate; RESIDUAL_AND_RATE = both.", "REPORT 2 and sale_line_current"]);
  setup(info);
  info.eachRow((row) => {
    const label = String(row.getCell(1).value ?? "");
    if (label === "Factory pending qty" || label === "Unpriceable pieces") row.getCell(2).numFmt = QTY;
    if (label === "Priced pending" || label === "Derived pending" || label === "Non-territory derived pending") {
      row.getCell(2).numFmt = INR;
      if (typeof row.getCell(2).value === "number") row.getCell(2).value = Math.round((row.getCell(2).value as number) * 100) / 100;
    }
  });
  return workbook;
}
