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
  if (useCache && _cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  const [sheetResult, obResult, saleResult, attributionResult, conflictResult] = await Promise.allSettled([
    read(),
    loadOb(),
    loadSale("2026-27"),
    loadAttribution(),
    loadConflicts(),
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
  const result: FactoryPendingResult = {
    groups: sheet?.groups ?? [],
    grandTotal: sheet?.grandTotal ?? 0,
    byHead: enriched.byHead,
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
  };

  if (useCache && !sheetError && attributionAvailable && !attributionLoadError) {
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

  const detail = workbook.addWorksheet("Pending Detail");
  detail.columns = [
    { header: "State Head", key: "head", width: 24 },
    { header: "Bucket / Member", key: "bucket", width: 28 },
    { header: "Party", key: "party", width: 34 },
    { header: "Source Qty", key: "total", width: 14 },
    { header: "Classification", key: "classification", width: 25 },
    ...result.groups.map((group) => ({ header: group, key: group, width: 14 })),
    { header: "Party Difference", key: "difference", width: 16 },
    { header: "Exact", key: "exact", width: 10 },
  ];
  for (const head of result.byHead) {
    for (const bucket of head.buckets) {
      for (const party of bucket.parties) {
        detail.addRow({
          head: head.head,
          bucket: bucket.bucket,
          party: party.party,
          total: party.total,
          classification: party.attribution.classification,
          ...party.byGroup,
          difference: party.reconciliation.difference,
          exact: party.reconciliation.exact,
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
  return workbook;
}
