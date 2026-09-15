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
  if (useCache && _cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  const [sheetResult, obResult, saleResult, attributionResult, conflictResult, pricingResult] = await Promise.allSettled([
    read(),
    loadOb(),
    loadSale("2026-27"),
    loadAttribution(),
    loadConflicts(),
    shouldLoadPricing ? loadPricing() : Promise.resolve(null),
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
  const attributionAvailable =
    attributionResult.status === "fulfilled" && conflictResult.status === "fulfilled";

  const obTotal = ob && !ob.error ? ob.total : null;
  const saleTotal = sale && !sale.error ? sale.total : null;
  const pendingTotal =
    obTotal != null && saleTotal != null ? obTotal - saleTotal : null;

  const derived: DerivedPending = {
    ob: obTotal,
    sale: saleTotal,
    pending: pendingTotal,
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
  const amountPricing = addAmountPricing(enriched, pricing);
  const result: FactoryPendingResult = {
    groups: sheet?.groups ?? [],
    grandTotal: sheet?.grandTotal ?? 0,
    byHead: amountPricing.byHead,
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
  };

  if (
    useCache &&
    !sheetError &&
    attributionAvailable &&
    !attributionLoadError &&
    (!shouldLoadPricing || pricingResult.status === "fulfilled")
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

      const headVal = strVal(row[1]);
      const party = strVal(row[2]);
      const qty = numVal(row[3]);

      if (headVal) currentHead = headVal;

      if (!party || qty <= 0) {
        // Possible blank/separator row — skip.
        if (globalRow > 200) break; // safety guard
        continue;
      }

      const head = currentHead || "Unknown";
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

/**
 * Build the XLSX used by the pending-order audit route.  The detail sheet is
 * deliberately denormalised: a reviewer can trace company → head → bucket →
 * party → product group without relying on formulas or hidden workbook tabs.
 */
export function buildFactoryPendingWorkbook(result: FactoryPendingResult): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Audit Summary");
  summary.columns = [
    { header: "Measure", key: "measure", width: 34 },
    { header: "Value", key: "value", width: 18 },
    { header: "Basis", key: "basis", width: 72 },
  ];
  summary.addRows([
    ["Grand total", result.grandTotal, "REPORT 2 source quantity"],
    ["Candidate coverage %", result.candidateCoveragePct, "Unique active or LEFT/departed candidate quantity ÷ company total"],
    ["Safe coverage %", result.safeCoveragePct, "Unique active member quantity ÷ company total"],
    ["Conflict cost (percentage points)", result.conflictCostPp, "Candidate coverage less safe coverage"],
    ["Unassigned quantity", result.coverage.unassignedQty, "No current customer assignment candidate"],
    ["Disputed quantity", result.coverage.disputedQty, "Attribution Conflicts or Multiple Candidates"],
    ["Company reconciliation difference", result.reconciliation.company.difference, "Parent less sum of head children; must be zero"],
  ]);
  summary.getRow(1).font = { bold: true };
  summary.addRow([]);
  summary.addRow(["Derived", "Order book", ""]);
  summary.addRow(["Derived", result.derived.ob, "Order-book total"]);
  summary.addRow(["Derived", result.derived.sale, "Sale total"]);
  summary.addRow(["Derived", result.derived.pending, "Order book less sale"]);

  summary.addRow(["Priced amount", result.pricedAmount, PRICE_BASIS]);
  summary.addRow(["Unpriceable quantity", result.unpriceableQty ?? null, "REPORT 2 residual plus groups without a usable positive rate"]);
  summary.addRow(["Pricing error", result.pricingError ?? null, "Quantity and attribution remain available when pricing is unavailable"]);

  const detail = workbook.addWorksheet("Pending Detail");
  detail.columns = [
    { header: "State Head", key: "head", width: 24 },
    { header: "Bucket / Member", key: "bucket", width: 28 },
    { header: "Party", key: "party", width: 34 },
    { header: "Source Qty", key: "total", width: 14 },
    { header: "Priced Amount (₹)", key: "pricedAmount", width: 18 },
    { header: "Unpriceable Qty", key: "unpriceableQty", width: 16 },
    { header: "Classification", key: "classification", width: 25 },
    ...result.groups.flatMap((group) => [
      { header: `${group} Qty`, key: group, width: 14 },
      { header: `${group} Amount (₹)`, key: `${group}__amount`, width: 18 },
      { header: `${group} Unpriceable`, key: `${group}__unpriceable`, width: 16 },
    ]),
    { header: "Party Difference", key: "difference", width: 16 },
    { header: "Exact", key: "exact", width: 10 },
    { header: "Amount Difference", key: "amountDifference", width: 18 },
    { header: "Amount Exact", key: "amountExact", width: 12 },
  ];
  const exportGroupCells = (parties: PendingParty[]): Record<string, number | null> => {
    const cells: Record<string, number | null> = {};
    for (const group of result.groups) {
      const qty = parties.reduce((sum, party) => sum + (party.byGroup[group] ?? 0), 0);
      const amounts = parties
        .map((party) => party.byGroupAmount?.[group] ?? null)
        .filter((amount): amount is number => amount != null);
      cells[group] = qty > 0 ? qty : null;
      cells[`${group}__amount`] = result.pricingAvailable === true && amounts.length
        ? amounts.reduce((sum, amount) => sum + amount, 0)
        : null;
      cells[`${group}__unpriceable`] = result.pricingAvailable === true
        ? parties.reduce((sum, party) => sum + (
            party.byGroup[group] != null && party.byGroupAmount?.[group] == null
              ? party.byGroup[group]
              : 0
          ), 0)
        : null;
    }
    return cells;
  };
  for (const head of result.byHead) {
    detail.addRow({
      head: head.head,
      bucket: "TOTAL",
      party: "",
      total: head.total,
      pricedAmount: head.pricedAmount ?? null,
      unpriceableQty: head.unpriceableQty ?? null,
      classification: "State Head total",
      amountDifference: head.amountReconciliation?.difference ?? null,
      amountExact: head.amountReconciliation?.exact ?? null,
      ...exportGroupCells(head.parties),
    });
    for (const bucket of head.buckets) {
      detail.addRow({
        head: head.head,
        bucket: bucket.bucket,
        party: "",
        total: bucket.total,
        pricedAmount: bucket.pricedAmount ?? null,
        unpriceableQty: bucket.unpriceableQty ?? null,
        classification: "Bucket total",
        amountDifference: bucket.amountReconciliation?.difference ?? null,
        amountExact: bucket.amountReconciliation?.exact ?? null,
        ...exportGroupCells(bucket.parties),
      });
      for (const party of bucket.parties) {
        detail.addRow({
          head: head.head,
          bucket: bucket.bucket,
          party: party.party,
          total: party.total,
          pricedAmount: party.pricedAmount ?? null,
          unpriceableQty: party.unpriceableQty ?? 0,
          classification: party.attribution.classification,
          ...exportGroupCells([party]),
          difference: party.reconciliation.difference,
          exact: party.reconciliation.exact,
          amountDifference: party.amountReconciliation?.difference ?? null,
          amountExact: party.amountReconciliation?.exact ?? null,
        });
      }
    }
  }
  detail.getRow(1).font = { bold: true };

  const evidence = workbook.addWorksheet("Attribution Evidence");
  evidence.columns = [
    { header: "State Head", key: "head", width: 24 },
    { header: "Bucket", key: "bucket", width: 28 },
    { header: "Party", key: "party", width: 34 },
    { header: "Classification", key: "classification", width: 25 },
    { header: "Candidate person IDs", key: "personIds", width: 22 },
    { header: "Candidates", key: "candidates", width: 48 },
    { header: "Conflict evidence", key: "evidence", width: 72 },
    { header: "Review link", key: "link", width: 32 },
  ];
  for (const head of result.byHead) {
    for (const bucket of head.buckets) {
      for (const party of bucket.parties) {
        const attribution = party.attribution;
        evidence.addRow({
          head: head.head,
          bucket: bucket.bucket,
          party: party.party,
          classification: attribution.classification,
          personIds: attribution.candidates.map((candidate) => candidate.personId).join(", "),
          candidates: attribution.candidates.map((candidate) => `${candidate.member} (${candidate.active ? "active" : "LEFT/departed"})`).join("; "),
          evidence: attribution.conflictEvidence.join("; "),
          link: attribution.conflictLink ?? "",
        });
      }
    }
  }
  evidence.getRow(1).font = { bold: true };
  const reconciliation = workbook.addWorksheet("Reconciliation");
  reconciliation.columns = [
    { header: "Level", key: "level", width: 14 },
    { header: "State Head", key: "head", width: 24 },
    { header: "Bucket", key: "bucket", width: 28 },
    { header: "Party / Product Group", key: "party", width: 34 },
    { header: "Parent (₹)", key: "parent", width: 16 },
    { header: "Children (₹)", key: "children", width: 16 },
    { header: "Difference (₹)", key: "difference", width: 16 },
    { header: "Exact", key: "exact", width: 10 },
    { header: "Measure", key: "measure", width: 12 },
    { header: "Source", key: "source", width: 42 },
  ];
  const amountSource = PRICE_BASIS;
  reconciliation.addRow({
    level: "Company",
    parent: result.amountReconciliation?.company.parent ?? null,
    children: result.amountReconciliation?.company.children ?? null,
    difference: result.amountReconciliation?.company.difference ?? null,
    exact: result.amountReconciliation?.company.exact ?? null,
    measure: "Amount",
    source: amountSource,
  });
  for (const row of result.amountReconciliation?.heads ?? []) {
    reconciliation.addRow({ level: "State Head", ...row, measure: "Amount", source: amountSource });
  }
  for (const row of result.amountReconciliation?.buckets ?? []) {
    reconciliation.addRow({ level: "Bucket", ...row, measure: "Amount", source: amountSource });
  }
  for (const row of result.amountReconciliation?.parties ?? []) {
    reconciliation.addRow({ level: "Party", ...row, measure: "Amount", source: amountSource });
  }
  if (!result.amountReconciliation) {
    for (const head of result.byHead) {
      reconciliation.addRow({ level: "State Head", head: head.head, parent: null, children: null, difference: null, exact: null, measure: "Amount", source: amountSource });
      for (const bucket of head.buckets) {
        reconciliation.addRow({ level: "Bucket", head: head.head, bucket: bucket.bucket, parent: null, children: null, difference: null, exact: null, measure: "Amount", source: amountSource });
        for (const party of bucket.parties) {
          reconciliation.addRow({ level: "Party", head: head.head, bucket: bucket.bucket, party: party.party, parent: null, children: null, difference: null, exact: null, measure: "Amount", source: amountSource });
        }
      }
    }
  }
  for (const group of result.groups) {
    const values = result.byHead.flatMap((head) =>
      head.parties
        .map((party) => party.byGroupAmount?.[group] ?? null)
        .filter((amount): amount is number => amount != null),
    );
    const groupAmount = values.reduce((sum, value) => sum + value, 0);
    reconciliation.addRow({
      level: "Product Group",
      party: group,
      parent: values.length ? groupAmount : null,
      children: values.length ? groupAmount : null,
      difference: values.length ? 0 : null,
      exact: values.length ? true : null,
      measure: "Amount",
      source: amountSource,
    });
  }
  reconciliation.getRow(1).font = { bold: true };
  const info = workbook.addWorksheet("Info");
  info.columns = [
    { header: "Field", key: "field", width: 34 },
    { header: "Value", key: "value", width: 110 },
  ];
  info.addRows([
    ["Price basis", PRICE_BASIS],
    ["Amount interpretation", "Pending value = pending quantity x average realised price per product group, FY2026-27. Estimated worth of outstanding orders, not an invoiced amount. The source carries product groups, not item codes, so this is a group-level estimate."],
    ["Source", "sale_line_current (current rows only; version_status=current)"],
    ["Fiscal year", "FY2026-27"],
    ["Grain", "Coarse product-group weighted realised rate; not SKU-level pending allocation"],
    ["Water tank denominator", "REPORT 2 is pieces. For mapped WT/WCT suffixes, use qty when qty_ltr is present, otherwise qty / canonical per-tank litres; unmapped accessories use qty. Confirm price is per tank."],
    ["Partial/unpriceable disclosure", "Amount is blank when fully unpriceable. Unpriceable quantity includes REPORT 2 total-minus-product-group residuals and any product group without a usable positive rate. Missing rates are null, never zero."],
  ]);
  info.getRow(1).font = { bold: true };
  return workbook;
}
