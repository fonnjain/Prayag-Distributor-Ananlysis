import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import {
  coveragePersonSql,
  getUnverifiedCoverageAliasReview,
} from "./coverageAliases.js";
import { getOpenFiscalYearStructuralReasons, shouldReportCanonicalCoverageDriftIssue } from "./canonicalCoverageDriftPolicy.js";

const FY = "2025-26";
export const ZERO_SALES_LEAVES = [
  "ARUNACHAL PRADESH",
  "DADRA AND NAGAR HAVELI",
  "MANIPUR",
  "MEGHALAYA",
  "MIZORAM",
  "NAGALAND",
  "PONDICHERRY",
  "SIKKIM",
  "TRIPURA",
] as const;

export interface CanonicalCoverageReport {
  passed: boolean;
  fy: string;
  reconciliation: {
    archivedLegacyRows: number;
    canonicalCoverageRows: number;
    mappingRows: number;
    unmappedLegacyRows: number;
  };
  sales: {
    expectedNet: number;
    beforeNet: number;
    afterNet: number;
    variances: Array<{ head: string; before: number; after: number; variance: number }>;
  };
  zeroSalesLeaves: Array<{ state_canon: string; coverageRows: number; registerRows: number }>;
  multiHeadLeaves: Array<{ state_canon: string; heads: string[]; headCount: number }>;
  tamilNaduHandover: Array<{ fy: string; month: string; head: string; net: number }>;
  tamilNaduCoverageHandover: Array<{ person: string; responsible_head: string; effective_from: string; effective_to: string | null }>;
  duplicateTerritoriesRemaining: string[];
  nonAssignableCoverage: string[];
  unassignedCoverage: Array<{ state_canon: string; effective_from: string }>;
  hiteshRegisterRows: number;
  derivedCoverage: Array<{
    fiscal_year: string;
    state_canon: string;
    coverage_person: string;
    responsible_head: string;
    customer_count: number;
    net_amount: number;
    effective_from: string;
    effective_to: string | null;
    alias_status: "UNVERIFIED ALIAS" | null;
    register_head_label: string | null;
    alias_review_note: string | null;
  }>;
  reviewWarnings: {
    coverageIsReadOnly: true;
    unverifiedAliases: Array<{
      state_canon: string;
      fiscal_year: string;
      coverage_person: string;
      responsible_head: string;
      register_head_label: string;
      customer_count: number;
      net_amount: number;
      effective_from: string;
      effective_to: string | null;
      status: "UNVERIFIED ALIAS";
      review_note: string;
    }>;
    concentrationWarnings: Array<{
      state_canon: string;
      fiscal_years: string[];
      responsible_head: string;
      coverage_person: string;
      register_head_labels: string[];
      coverage_rows: number;
      customer_count: number;
      net_amount: number;
      customer_name: string;
      state_net_amount: number;
      share_percent: number;
      message: string;
    }>;
  };
  uncoveredGaps: Array<{
    state_canon: string;
    fiscal_year: string;
    customer_count: number;
    net_amount: number;
    reason: string;
  }>;
  derivedIntegrity: {
    attributionIssues: number;
    coverageMismatches: number;
    evidenceMismatches: number;
    punjabGapMatches: boolean;
  };
  mappings: Array<{
    person: string;
    state_head: string;
    legacy_territory: string;
    state_canon: string;
    effective_from: string;
    effective_to: string | null;
    mapping_rule: string;
  }>;
}

export type CanonicalCoverageDriftIssueKind =
  | "mixed"
  | "unassigned"
  | "system-routed"
  | "unresolved"
  | "coverage-mismatch"
  | "evidence-mismatch";

export interface CanonicalCoverageDriftIssue {
  kind: CanonicalCoverageDriftIssueKind;
  stateCanon: string;
  fiscalYear: string;
  customer: string | null;
  detail: Record<string, unknown>;
}

export interface TamilNaduCoverageConcentrationWarning {
  stateCanon: "TAMIL NADU";
  fiscalYear: string;
  customer: string;
  customerCount: number;
  customerNetAmount: number;
  stateNetAmount: number;
  sharePercent: number;
  coverageRows: number;
  coveragePeople: string[];
  responsibleHeads: string[];
  message: string;
}

export interface CanonicalCoverageDriftCheck {
  checkedAt: string;
  fiscalYear: string | null;
  passed: boolean;
  issueCount: number;
  issues: CanonicalCoverageDriftIssue[];
  concentrationWarnings: TamilNaduCoverageConcentrationWarning[];
}

type DriftBuildOptions = {
  forceFresh?: boolean;
};

const driftCheckCache = new Map<string, Promise<CanonicalCoverageDriftCheck>>();

export function invalidateCanonicalCoverageDriftCache(fiscalYear?: string): void {
  if (fiscalYear == null) {
    driftCheckCache.clear();
    return;
  }
  driftCheckCache.delete(fiscalYear);
  driftCheckCache.delete("all");
}

type DriftIssueRow = {
  issue_kind: CanonicalCoverageDriftIssueKind;
  state_canon: string;
  fiscal_year: string;
  customer: string | null;
  detail: Record<string, unknown>;
};

type TamilNaduConcentrationRow = {
  fiscal_year: string;
  customer_name: string;
  customer_count: string;
  customer_net_amount: string;
  state_net_amount: string;
  share_percent: string;
  coverage_rows: string;
  coverage_people: string[];
  responsible_heads: string[];
};

/**
 * Returns material Tamil Nadu customer concentration from persisted,
 * register-derived coverage evidence. This intentionally does not depend on
 * alias-review state: a confirmed historical identity can still leave a
 * material concentration that an operator needs to see.
 */
export async function buildTamilNaduCoverageConcentrationWarnings(
  fiscalYear?: string,
): Promise<TamilNaduCoverageConcentrationWarning[]> {
  const { rows } = await pool.query<TamilNaduConcentrationRow>(`
    WITH coverage_evidence AS (
      SELECT
        c.coverage_id,
        c.fiscal_year,
        p.name AS coverage_person,
        COALESCE(h.name, 'Unassigned') AS responsible_head,
        e.customer_name,
        e.net_amount
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.person_id
      LEFT JOIN person h ON h.person_id = c.state_head_person_id
      JOIN person_state_coverage_customer_evidence e ON e.coverage_id = c.coverage_id
      WHERE c.source = 'derived_register'
        AND c.voided_at IS NULL
        AND c.state_canon = 'TAMIL NADU'
        AND ($1::text IS NULL OR c.fiscal_year = $1)
    ),
    customer_totals AS (
      SELECT
        fiscal_year,
        customer_name,
        COUNT(DISTINCT coverage_id)::text AS coverage_rows,
        ARRAY_AGG(DISTINCT coverage_person ORDER BY coverage_person) AS coverage_people,
        ARRAY_AGG(DISTINCT responsible_head ORDER BY responsible_head) AS responsible_heads,
        SUM(net_amount) AS customer_net_amount
      FROM coverage_evidence
      GROUP BY fiscal_year, customer_name
    ),
    state_totals AS (
      SELECT
        fiscal_year,
        COUNT(DISTINCT customer_name)::text AS customer_count,
        SUM(net_amount) AS state_net_amount
      FROM coverage_evidence
      GROUP BY fiscal_year
    )
    SELECT
      ct.fiscal_year,
      ct.customer_name,
      st.customer_count,
      ct.customer_net_amount::text,
      st.state_net_amount::text,
      (ct.customer_net_amount / NULLIF(st.state_net_amount, 0) * 100)::text AS share_percent,
      ct.coverage_rows,
      ct.coverage_people,
      ct.responsible_heads
    FROM customer_totals ct
    JOIN state_totals st ON st.fiscal_year = ct.fiscal_year
    WHERE ct.customer_net_amount / NULLIF(st.state_net_amount, 0) >= 0.8
    ORDER BY ct.fiscal_year, ct.customer_net_amount DESC, ct.customer_name
  `, [fiscalYear ?? null]);

  return rows.map((row) => {
    const sharePercent = Number(row.share_percent);
    const customerNetAmount = Number(row.customer_net_amount);
    const stateNetAmount = Number(row.state_net_amount);
    return {
      stateCanon: "TAMIL NADU",
      fiscalYear: row.fiscal_year,
      customer: row.customer_name,
      customerCount: Number(row.customer_count),
      customerNetAmount,
      stateNetAmount,
      sharePercent,
      coverageRows: Number(row.coverage_rows),
      coveragePeople: row.coverage_people,
      responsibleHeads: row.responsible_heads,
      message: `${row.customer_name} accounts for ${sharePercent.toFixed(1)}% of Tamil Nadu's ₹${stateNetAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 })} coverage evidence in FY${row.fiscal_year}. Review concentration; coverage was not changed.`,
    };
  });
}

/**
 * Re-runs the customer-level validation that guarded the original
 * register-evidenced coverage migration. This is deliberately read-only: it
 * tells an operator when the source evidence no longer supports a derived
 * coverage row, but never edits organisation coverage to match a new load.
 */
async function buildCanonicalCoverageDriftCheckUncached(
  fiscalYear?: string,
): Promise<CanonicalCoverageDriftCheck> {
  const [issueResult, concentrationWarnings] = await Promise.all([
    pool.query<DriftIssueRow>(`
    WITH selected_lines AS (
      SELECT sl.state_canon, sl.fy, sl.customer, sl.head_canon, sl.amount,
             sl.invoice_date, sl.month_label,
              ${coveragePersonSql("sl.head_canon")} AS person_name
      FROM sale_line sl
      WHERE (
        sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
        OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
      )
        AND ($1::text IS NULL OR sl.fy = $1)
    ),
    customer_attribution AS (
      SELECT
        s.state_canon,
        s.fy,
        s.customer,
        array_agg(DISTINCT COALESCE(s.head_canon, '__UNASSIGNED__')
          ORDER BY COALESCE(s.head_canon, '__UNASSIGNED__')) AS register_heads,
        COUNT(DISTINCT s.head_canon) FILTER (WHERE s.head_canon IS NOT NULL) AS real_head_count,
        BOOL_OR(s.head_canon IS NULL) AS has_unassigned,
        BOOL_OR(p.person_id IS NULL AND s.head_canon IS NOT NULL) AS has_unresolved,
        BOOL_OR(COALESCE(p.is_system_coverage, false)) AS has_system
      FROM selected_lines s
      LEFT JOIN person p ON p.name = s.person_name
      GROUP BY s.state_canon, s.fy, s.customer
    ),
    attribution_issues AS (
      SELECT
        CASE
          WHEN real_head_count > 1 THEN 'mixed'
          WHEN has_unassigned THEN 'unassigned'
          WHEN has_system THEN 'system-routed'
          WHEN has_unresolved THEN 'unresolved'
        END::text AS issue_kind,
        state_canon,
        fy AS fiscal_year,
        customer,
        jsonb_build_object(
          'registerHeads', register_heads,
          'realHeadCount', real_head_count,
          'hasUnassigned', has_unassigned,
          'hasSystem', has_system,
          'hasUnresolved', has_unresolved
        ) AS detail
      FROM customer_attribution
      WHERE real_head_count <> 1
         OR has_unassigned
         OR has_system
         OR has_unresolved
    ),
    expected_coverage AS (
      SELECT
        state_canon,
        fy,
        person_name,
        COUNT(DISTINCT customer)::integer AS customer_count,
        SUM(amount) AS net_amount,
        DATE_TRUNC('month', MIN(COALESCE(invoice_date, TO_DATE(month_label, 'Mon-YY'))))::date AS effective_from,
        (DATE_TRUNC('month', MAX(COALESCE(invoice_date, TO_DATE(month_label, 'Mon-YY'))))
          + INTERVAL '1 month - 1 day')::date AS effective_to
      FROM selected_lines
      WHERE head_canon IS NOT NULL
      GROUP BY state_canon, fy, person_name
    ),
    actual_coverage AS (
      SELECT
        c.state_canon,
        c.fiscal_year AS fy,
        p.name AS person_name,
        c.evidence_customer_count AS customer_count,
        c.evidence_net_amount AS net_amount,
        c.effective_from,
        c.effective_to
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.person_id
      WHERE c.source = 'derived_register'
        AND c.voided_at IS NULL
        AND ($1::text IS NULL OR c.fiscal_year = $1)
    ),
    coverage_diffs AS (
      SELECT
        COALESCE(e.state_canon, a.state_canon) AS state_canon,
        COALESCE(e.fy, a.fy) AS fiscal_year,
        COALESCE(e.person_name, a.person_name) AS person_name,
        jsonb_build_object(
          'expected', jsonb_build_object(
            'customerCount', e.customer_count,
            'netAmount', e.net_amount,
            'effectiveFrom', e.effective_from,
            'effectiveTo', e.effective_to
          ),
          'coverage', jsonb_build_object(
            'customerCount', a.customer_count,
            'netAmount', a.net_amount,
            'effectiveFrom', a.effective_from,
            'effectiveTo', a.effective_to
           ),
           'currentRegisterEvidence', jsonb_build_object(
            'customerCount', e.customer_count,
            'netAmount', e.net_amount,
            'effectiveFrom', e.effective_from,
            'effectiveTo', e.effective_to
           ),
           'persistedCoverageEvidence', jsonb_build_object(
            'customerCount', a.customer_count,
            'netAmount', a.net_amount,
            'effectiveFrom', a.effective_from,
            'effectiveTo', a.effective_to
           ),
           'structural', jsonb_build_object(
            'currentPersonName', e.person_name,
            'persistedPersonName', a.person_name
           ),
           'difference', jsonb_build_object(
            'customerCount', COALESCE(e.customer_count, 0) - COALESCE(a.customer_count, 0),
            'netAmount', COALESCE(e.net_amount, 0) - COALESCE(a.net_amount, 0),
            'effectiveFromChanged', e.effective_from IS DISTINCT FROM a.effective_from,
            'effectiveToChanged', e.effective_to IS DISTINCT FROM a.effective_to,
            'effectiveFromDays', CASE
              WHEN e.effective_from IS NULL OR a.effective_from IS NULL THEN NULL
              ELSE e.effective_from - a.effective_from
            END,
            'effectiveToDays', CASE
              WHEN e.effective_to IS NULL OR a.effective_to IS NULL THEN NULL
              ELSE e.effective_to - a.effective_to
            END
          )
        ) AS detail
      FROM expected_coverage e
      FULL OUTER JOIN actual_coverage a
        ON a.state_canon = e.state_canon
       AND a.fy = e.fy
       AND a.person_name = e.person_name
      WHERE e.customer_count IS DISTINCT FROM a.customer_count
         OR e.net_amount IS DISTINCT FROM a.net_amount
         OR e.effective_from IS DISTINCT FROM a.effective_from
         OR e.effective_to IS DISTINCT FROM a.effective_to
    ),
    expected_evidence AS (
      SELECT
        state_canon,
        fy,
        customer,
        ARRAY_AGG(DISTINCT person_name ORDER BY person_name) AS person_names,
        SUM(amount) AS net_amount
      FROM selected_lines
      WHERE head_canon IS NOT NULL
      GROUP BY state_canon, fy, customer
    ),
    actual_evidence AS (
      SELECT
        c.state_canon,
        c.fiscal_year AS coverage_fiscal_year,
        e.fiscal_year AS evidence_fiscal_year,
        ARRAY_AGG(DISTINCT p.name ORDER BY p.name) AS person_names,
        e.customer_name AS customer,
        SUM(e.net_amount) AS net_amount
      FROM person_state_coverage_customer_evidence e
      JOIN person_state_coverage c ON c.coverage_id = e.coverage_id
      JOIN person p ON p.person_id = c.person_id
      WHERE c.source = 'derived_register'
        AND c.voided_at IS NULL
        AND ($1::text IS NULL OR c.fiscal_year = $1)
      GROUP BY c.state_canon, c.fiscal_year, e.fiscal_year, e.customer_name
    ),
    evidence_diffs AS (
      SELECT
        COALESCE(e.state_canon, a.state_canon) AS state_canon,
        COALESCE(e.fy, a.coverage_fiscal_year) AS fiscal_year,
        COALESCE(e.customer, a.customer) AS customer,
        jsonb_build_object(
          'person', COALESCE(e.person_names[1], a.person_names[1]),
          'sourceFiscalYear', COALESCE(e.fy, a.coverage_fiscal_year),
          'evidenceFiscalYear', a.evidence_fiscal_year,
          'expectedNetAmount', e.net_amount,
          'evidenceNetAmount', a.net_amount,
          'currentRegisterEvidence', jsonb_build_object(
            'fiscalYear', e.fy,
            'netAmount', e.net_amount,
            'heads', e.person_names
          ),
          'persistedEvidence', jsonb_build_object(
            'coverageFiscalYear', a.coverage_fiscal_year,
            'evidenceFiscalYear', a.evidence_fiscal_year,
            'netAmount', a.net_amount,
            'heads', a.person_names
          ),
          'structural', jsonb_build_object(
            'headChanged', e.person_names IS DISTINCT FROM a.person_names,
            'customerPresenceChanged', (e.customer IS NULL) IS DISTINCT FROM (a.customer IS NULL),
            'currentPersonName', e.person_names[1],
            'persistedPersonName', a.person_names[1]
          ),
          'difference', jsonb_build_object(
            'netAmount', COALESCE(e.net_amount, 0) - COALESCE(a.net_amount, 0),
            'fiscalYearChanged', e.fy IS DISTINCT FROM a.evidence_fiscal_year
          )
        ) AS detail
      FROM expected_evidence e
      FULL OUTER JOIN actual_evidence a
        ON a.state_canon = e.state_canon
       AND a.coverage_fiscal_year = e.fy
       AND a.customer = e.customer
      WHERE e.net_amount IS DISTINCT FROM a.net_amount
         OR e.person_names IS DISTINCT FROM a.person_names
         OR a.coverage_fiscal_year IS DISTINCT FROM a.evidence_fiscal_year
    )
    SELECT issue_kind::text, state_canon, fiscal_year, customer, detail
    FROM attribution_issues
    UNION ALL
    SELECT 'coverage-mismatch', state_canon, fiscal_year, NULL, detail
    FROM coverage_diffs
    UNION ALL
    SELECT 'evidence-mismatch', state_canon, fiscal_year, customer, detail
    FROM evidence_diffs
    ORDER BY fiscal_year, state_canon, issue_kind, customer NULLS LAST
    `, [fiscalYear ?? null]),
    buildTamilNaduCoverageConcentrationWarnings(fiscalYear),
  ]);
  const { rows } = issueResult;

  const issues = rows.map((row) => {
    const detail = row.detail ?? {};
    const currentRegisterEvidence = detail.currentRegisterEvidence
      ?? detail.expected
      ?? (row.issue_kind === "mixed" || row.issue_kind === "unassigned"
        || row.issue_kind === "system-routed" || row.issue_kind === "unresolved"
        ? { registerHeads: detail.registerHeads ?? [] }
        : null);
    const persistedEvidence = detail.persistedCoverageEvidence
      ?? detail.persistedEvidence
      ?? detail.coverage
      ?? null;

    const issue: CanonicalCoverageDriftIssue = {
      kind: row.issue_kind,
      stateCanon: row.state_canon,
      fiscalYear: row.fiscal_year,
      customer: row.customer,
      detail: {
        ...detail,
        review: {
          canonicalLeaf: row.state_canon,
          fiscalYear: row.fiscal_year,
          customer: row.customer,
          currentRegisterEvidence,
          persistedEvidence,
          difference: detail.difference ?? null,
          coverageWasChanged: false,
        },
      },
    };
    const structuralReasons = getOpenFiscalYearStructuralReasons(issue);
    return {
      ...issue,
      detail: {
        ...issue.detail,
        structuralReasons,
      },
    };
  }).filter(shouldReportCanonicalCoverageDriftIssue);

  return {
    checkedAt: new Date().toISOString(),
    fiscalYear: fiscalYear ?? null,
    passed: issues.length === 0,
    issueCount: issues.length,
    issues,
    concentrationWarnings,
  };
}

export async function buildCanonicalCoverageDriftCheck(
  fiscalYear?: string,
  options: DriftBuildOptions = {},
): Promise<CanonicalCoverageDriftCheck> {
  const key = fiscalYear ?? "all";
  if (options.forceFresh) return buildCanonicalCoverageDriftCheckUncached(fiscalYear);

  const cached = driftCheckCache.get(key);
  if (cached) return cached;

  const build = buildCanonicalCoverageDriftCheckUncached(fiscalYear);
  driftCheckCache.set(key, build);
  try {
    return await build;
  } catch (err) {
    driftCheckCache.delete(key);
    throw err;
  }
}

/**
 * Stores a reviewable result for every automated or operator-triggered check.
 * The coverage tables are intentionally never written from this path.
 */
export async function auditCanonicalCoverageDrift(
  trigger: "register_sync" | "manual",
  fiscalYear?: string,
): Promise<CanonicalCoverageDriftCheck> {
  const check = await buildCanonicalCoverageDriftCheck(fiscalYear);
  await pool.query(
    `INSERT INTO canonical_coverage_drift_event
       (trigger_fy, trigger_source, report_fy, status, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      fiscalYear ?? "all",
      trigger,
      check.fiscalYear,
      check.passed ? "ok" : "drift",
      JSON.stringify({
        passed: check.passed,
        issueCount: check.issueCount,
        issues: check.issues,
         concentrationWarnings: check.concentrationWarnings,
      }),
    ],
  );
  return check;
}

const DUPLICATES = [
  "Andhra Pradesh", "Karnataka", "Rajasthan", "Tamil Nadu",
  "Jammu and Kashmir", "Delhi", "Haryana",
];

export async function buildCanonicalCoverageReport(): Promise<CanonicalCoverageReport> {
  const [
    countsRes,
    salesRes,
    zeroRes,
    multiHeadRes,
    tamilRes,
    tamilCoverageRes,
    duplicateRes,
    nonAssignableRes,
    unassignedRes,
    hiteshRes,
    mappingRes,
    derivedRes,
    uncoveredRes,
    derivedIntegrityRes,
  ] = await Promise.all([
    pool.query<{
      archived_legacy_rows: string; canonical_coverage_rows: string; mapping_rows: string; unmapped_legacy_rows: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM person_territory_archive)::text AS archived_legacy_rows,
        (SELECT COUNT(*) FROM person_state_coverage)::text AS canonical_coverage_rows,
        (SELECT COUNT(*) FROM person_state_coverage_mapping)::text AS mapping_rows,
        (SELECT COUNT(*) FROM person_territory_archive a
         WHERE NOT EXISTS (
           SELECT 1 FROM person_state_coverage_mapping m
           WHERE m.legacy_person_id = a.person_id
             AND m.legacy_territory_id = a.territory_id
             AND m.effective_from = a.effective_from
         ))::text AS unmapped_legacy_rows
    `),
    pool.query<{ head: string; before_net: string; after_net: string }>(`
      SELECT COALESCE(b.head_canon, a.head_canon) AS head,
             COALESCE(b.net_amount, 0)::text AS before_net,
             COALESCE(a.net_amount, 0)::text AS after_net
      FROM (
        SELECT fy, head_canon, net_amount
        FROM canonical_coverage_sales_snapshot
        WHERE snapshot_stage = 'before' AND fy = $1
      ) b
      FULL OUTER JOIN (
        SELECT fy, head_canon, net_amount
        FROM canonical_coverage_sales_snapshot
        WHERE snapshot_stage = 'after' AND fy = $1
      ) a ON a.fy = b.fy AND a.head_canon = b.head_canon
      ORDER BY 1
    `, [FY]),
    pool.query<{ state_canon: string; coverage_rows: string; register_rows: string }>(`
      SELECT sh.state_canon,
             COUNT(psc.coverage_id)::text AS coverage_rows,
             COUNT(sl.*)::text AS register_rows
      FROM state_hierarchy sh
       LEFT JOIN person_state_coverage psc
         ON psc.state_canon = sh.state_canon AND psc.voided_at IS NULL
      LEFT JOIN sale_line sl ON sl.state_canon = sh.state_canon AND sl.fy = $1
      WHERE sh.state_canon = ANY($2::text[])
      GROUP BY sh.state_canon
      ORDER BY sh.state_canon
    `, [FY, [...ZERO_SALES_LEAVES]]),
    pool.query<{ state_canon: string; heads: string[]; head_count: string }>(`
      SELECT c.state_canon, array_agg(DISTINCT h.name ORDER BY h.name) AS heads,
             COUNT(DISTINCT c.state_head_person_id)::text AS head_count
      FROM person_state_coverage c
      JOIN person h ON h.person_id = c.state_head_person_id
       WHERE h.is_system_coverage = false AND c.voided_at IS NULL
      GROUP BY c.state_canon
      HAVING COUNT(DISTINCT c.state_head_person_id) > 1
      ORDER BY c.state_canon
    `),
    pool.query<{ fy: string; month: string; head: string; net: string }>(`
      SELECT fy, month_label AS month, COALESCE(head_canon, '__UNASSIGNED__') AS head,
             SUM(amount)::text AS net
      FROM sale_line
      WHERE state_canon IN ('TAMIL NADU', 'TAMILNADU (S)')
      GROUP BY fy, month_label, COALESCE(head_canon, '__UNASSIGNED__')
      ORDER BY fy, MIN(invoice_date) NULLS LAST, month_label, head
    `),
    pool.query<{ person: string; responsible_head: string; effective_from: string; effective_to: string | null }>(`
      SELECT p.name AS person, h.name AS responsible_head,
             c.effective_from::text, c.effective_to::text
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.person_id
      JOIN person h ON h.person_id = c.state_head_person_id
      WHERE c.state_canon = 'TAMIL NADU'
         AND c.voided_at IS NULL
        AND p.name IN ('Taninki Ramesh Babu', 'Sandeep Dadheech')
      ORDER BY c.effective_from, p.name
    `),
    pool.query<{ name: string }>(
      `SELECT name FROM territory WHERE name = ANY($1::text[]) ORDER BY name`,
      [DUPLICATES],
    ),
    pool.query<{ state_canon: string }>(`
      SELECT DISTINCT c.state_canon
      FROM person_state_coverage c
      JOIN state_hierarchy sh ON sh.state_canon = c.state_canon
       WHERE sh.picker_visible = false AND c.voided_at IS NULL
      ORDER BY c.state_canon
    `),
    pool.query<{ state_canon: string; effective_from: string }>(`
      SELECT c.state_canon, c.effective_from::text
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.person_id
       WHERE p.is_system_coverage = true AND p.name = 'Unassigned coverage'
         AND c.voided_at IS NULL
      ORDER BY c.state_canon
    `),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sale_line WHERE state_canon = 'HITESH'`,
    ),
    pool.query<{
      person: string; state_head: string; legacy_territory: string; state_canon: string;
      effective_from: string; effective_to: string | null; mapping_rule: string;
    }>(`
      SELECT p.name AS person, sh.name AS state_head, m.legacy_territory,
             m.state_canon, m.effective_from::text, m.effective_to::text, m.mapping_rule
      FROM person_state_coverage_mapping m
      JOIN person p ON p.person_id = m.legacy_person_id
      JOIN person sh ON sh.person_id = m.state_head_person_id
      ORDER BY m.legacy_territory, p.name, m.state_canon
    `),
    pool.query<{
      fiscal_year: string; state_canon: string; coverage_person: string;
      responsible_head: string; customer_count: string; net_amount: string;
      effective_from: string; effective_to: string | null;
    }>(`
      SELECT c.fiscal_year, c.state_canon, p.name AS coverage_person,
             h.name AS responsible_head, c.evidence_customer_count::text AS customer_count,
             c.evidence_net_amount::text AS net_amount,
             c.effective_from::text, c.effective_to::text
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.person_id
      JOIN person h ON h.person_id = c.state_head_person_id
       WHERE c.source = 'derived_register' AND c.voided_at IS NULL
      ORDER BY c.state_canon, c.fiscal_year, p.name
    `),
    pool.query<{
      state_canon: string; fiscal_year: string; customer_count: string; net_amount: string; reason: string;
    }>(`
      SELECT state_canon, fiscal_year, customer_count::text, net_amount::text, reason
      FROM canonical_coverage_uncovered_gap
      ORDER BY state_canon, fiscal_year
    `),
    pool.query<{
      attribution_issues: string; coverage_mismatches: string;
      evidence_mismatches: string; punjab_gap_matches: boolean;
    }>(`
      WITH selected_lines AS (
        SELECT sl.state_canon, sl.fy, sl.customer, sl.head_canon, sl.amount,
               sl.invoice_date, sl.month_label,
                ${coveragePersonSql("sl.head_canon")} AS person_name
        FROM sale_line sl
        WHERE sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
           OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
      ),
      attribution_issue_rows AS (
        SELECT s.state_canon, s.fy, s.customer
        FROM selected_lines s
        LEFT JOIN person p ON p.name = s.person_name
        GROUP BY s.state_canon, s.fy, s.customer
        HAVING COUNT(DISTINCT COALESCE(s.head_canon, '__NULL__')) <> 1
            OR BOOL_OR(s.head_canon IS NULL OR p.person_id IS NULL OR p.is_system_coverage)
      ),
      expected_coverage AS (
        SELECT state_canon, fy, person_name,
               COUNT(DISTINCT customer)::integer AS customer_count, SUM(amount) AS net_amount,
               DATE_TRUNC('month', MIN(COALESCE(invoice_date, TO_DATE(month_label, 'Mon-YY'))))::date AS effective_from,
               (DATE_TRUNC('month', MAX(COALESCE(invoice_date, TO_DATE(month_label, 'Mon-YY'))))
                 + INTERVAL '1 month - 1 day')::date AS effective_to
        FROM selected_lines
        WHERE head_canon IS NOT NULL
        GROUP BY state_canon, fy, person_name
      ),
      actual_coverage AS (
        SELECT c.state_canon, c.fiscal_year AS fy, p.name AS person_name,
               c.evidence_customer_count AS customer_count, c.evidence_net_amount AS net_amount,
               c.effective_from, c.effective_to
        FROM person_state_coverage c
        JOIN person p ON p.person_id = c.person_id
        WHERE c.source = 'derived_register' AND c.voided_at IS NULL
      ),
      coverage_diffs AS (
        SELECT 1
        FROM expected_coverage e
        FULL OUTER JOIN actual_coverage a
          ON a.state_canon = e.state_canon AND a.fy = e.fy AND a.person_name = e.person_name
        WHERE COALESCE(a.customer_count, -1) <> COALESCE(e.customer_count, -1)
           OR COALESCE(a.net_amount, -1) <> COALESCE(e.net_amount, -1)
           OR COALESCE(a.effective_from, DATE '0001-01-01') <> COALESCE(e.effective_from, DATE '0001-01-01')
           OR COALESCE(a.effective_to, DATE '0001-01-01') <> COALESCE(e.effective_to, DATE '0001-01-01')
      ),
      expected_evidence AS (
        SELECT state_canon, fy, person_name, customer, SUM(amount) AS net_amount
        FROM selected_lines
        WHERE head_canon IS NOT NULL
        GROUP BY state_canon, fy, person_name, customer
      ),
      actual_evidence AS (
        SELECT c.state_canon, c.fiscal_year AS fy, p.name AS person_name,
               e.customer_name AS customer, SUM(e.net_amount) AS net_amount
        FROM person_state_coverage_customer_evidence e
        JOIN person_state_coverage c ON c.coverage_id = e.coverage_id
        JOIN person p ON p.person_id = c.person_id
        WHERE c.source = 'derived_register' AND c.voided_at IS NULL
        GROUP BY c.state_canon, c.fiscal_year, p.name, e.customer_name
      ),
      evidence_diffs AS (
        (SELECT * FROM expected_evidence EXCEPT ALL SELECT * FROM actual_evidence)
        UNION ALL
        (SELECT * FROM actual_evidence EXCEPT ALL SELECT * FROM expected_evidence)
      ),
      expected_punjab_gap AS (
        SELECT COUNT(DISTINCT customer)::integer AS customer_count, SUM(amount) AS net_amount
        FROM sale_line WHERE state_canon = 'PUNJAB' AND fy = '2023-24'
      )
      SELECT
        (SELECT COUNT(*)::text FROM attribution_issue_rows) AS attribution_issues,
        (SELECT COUNT(*)::text FROM coverage_diffs) AS coverage_mismatches,
        (SELECT COUNT(*)::text FROM evidence_diffs) AS evidence_mismatches,
        EXISTS (
          SELECT 1 FROM canonical_coverage_uncovered_gap g, expected_punjab_gap e
          WHERE g.state_canon = 'PUNJAB' AND g.fiscal_year = '2023-24'
            AND g.customer_count = e.customer_count AND g.net_amount = e.net_amount
        ) AND NOT EXISTS (
          SELECT 1 FROM person_state_coverage
          WHERE source = 'derived_register' AND voided_at IS NULL
            AND state_canon = 'PUNJAB' AND fiscal_year = '2023-24'
        ) AS punjab_gap_matches
    `),
  ]);

  const sales = salesRes.rows.map((row) => ({
    head: row.head === "__UNASSIGNED__" ? "Unassigned register head" : row.head,
    before: Number(row.before_net),
    after: Number(row.after_net),
    variance: Number(row.after_net) - Number(row.before_net),
  }));
  const beforeNet = sales.reduce((sum, row) => sum + row.before, 0);
  const afterNet = sales.reduce((sum, row) => sum + row.after, 0);
  const reconciliation = countsRes.rows[0];
  const zeroSalesLeaves = zeroRes.rows.map((row) => ({
    state_canon: row.state_canon,
    coverageRows: Number(row.coverage_rows),
    registerRows: Number(row.register_rows),
  }));
  const nonAssignableCoverage = nonAssignableRes.rows.map((row) => row.state_canon);
  const duplicateTerritoriesRemaining = duplicateRes.rows.map((row) => row.name);
  const expectedNet = 3_609_953_808.51;
  const tamilHeads = new Set(tamilRes.rows.map((row) => row.head));
  const hasTamilHandover = tamilCoverageRes.rows.some(
    (row) => row.person === "Taninki Ramesh Babu"
      && row.effective_from === "2024-04-01"
      && row.effective_to === "2025-03-31",
  ) && tamilCoverageRes.rows.some(
    (row) => row.person === "Sandeep Dadheech" && row.effective_from === "2025-04-01",
  );
  const derivedCoverage = derivedRes.rows.map((row) => {
    const review = getUnverifiedCoverageAliasReview({
      coveragePerson: row.coverage_person,
      stateCanon: row.state_canon,
      fiscalYear: row.fiscal_year,
    });
    return {
      fiscal_year: row.fiscal_year,
      state_canon: row.state_canon,
      coverage_person: row.coverage_person,
      responsible_head: row.responsible_head,
      customer_count: Number(row.customer_count),
      net_amount: Number(row.net_amount),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      alias_status: review?.status ?? null,
      register_head_label: review?.registerHead ?? null,
      alias_review_note: review?.reviewNote ?? null,
    };
  });
  const unverifiedAliases = derivedCoverage
    .filter((row) => row.alias_status === "UNVERIFIED ALIAS")
    .map((row) => ({
      state_canon: row.state_canon,
      fiscal_year: row.fiscal_year,
      coverage_person: row.coverage_person,
      responsible_head: row.responsible_head,
      register_head_label: row.register_head_label!,
      customer_count: row.customer_count,
      net_amount: row.net_amount,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      status: "UNVERIFIED ALIAS" as const,
      review_note: row.alias_review_note!,
    }));
  const concentrationWarnings = (await buildTamilNaduCoverageConcentrationWarnings()).map((row) => {
    return {
      state_canon: row.stateCanon,
      fiscal_years: [row.fiscalYear],
      responsible_head: row.responsibleHeads.join(", "),
      coverage_person: row.coveragePeople.join(", "),
      register_head_labels: [],
      coverage_rows: row.coverageRows,
      customer_count: row.customerCount,
      net_amount: row.customerNetAmount,
      customer_name: row.customer,
      state_net_amount: row.stateNetAmount,
      share_percent: row.sharePercent,
      message: row.message,
    };
  });
  const uncoveredGaps = uncoveredRes.rows.map((row) => ({
    state_canon: row.state_canon,
    fiscal_year: row.fiscal_year,
    customer_count: Number(row.customer_count),
    net_amount: Number(row.net_amount),
    reason: row.reason,
  }));
  const derivedIntegrity = {
    attributionIssues: Number(derivedIntegrityRes.rows[0]?.attribution_issues ?? 0),
    coverageMismatches: Number(derivedIntegrityRes.rows[0]?.coverage_mismatches ?? 0),
    evidenceMismatches: Number(derivedIntegrityRes.rows[0]?.evidence_mismatches ?? 0),
    punjabGapMatches: derivedIntegrityRes.rows[0]?.punjab_gap_matches === true,
  };

  return {
    passed:
      Number(reconciliation.unmapped_legacy_rows) === 0
      && sales.every((row) => row.variance === 0)
      && beforeNet === afterNet
      && Math.abs(beforeNet - expectedNet) < 0.01
      && duplicateTerritoriesRemaining.length === 0
      && nonAssignableCoverage.length === 0
      && zeroSalesLeaves.length === ZERO_SALES_LEAVES.length
      && zeroSalesLeaves.every((row) => row.coverageRows > 0)
      && tamilHeads.has("Babu") && tamilHeads.has("Sandeep Dadheech")
      && hasTamilHandover
      && derivedCoverage.length === 40
      && uncoveredGaps.length === 1
      && uncoveredGaps[0]?.state_canon === "PUNJAB"
      && uncoveredGaps[0]?.fiscal_year === "2023-24"
      && derivedIntegrity.attributionIssues === 0
      && derivedIntegrity.coverageMismatches === 0
      && derivedIntegrity.evidenceMismatches === 0
      && derivedIntegrity.punjabGapMatches,
    fy: FY,
    reconciliation: {
      archivedLegacyRows: Number(reconciliation.archived_legacy_rows),
      canonicalCoverageRows: Number(reconciliation.canonical_coverage_rows),
      mappingRows: Number(reconciliation.mapping_rows),
      unmappedLegacyRows: Number(reconciliation.unmapped_legacy_rows),
    },
    sales: {
      // This is ₹360.9954 Cr rounded to four decimals; retain the exact frozen
      // register amount in the audit so a ₹0.51 rounding remainder is never
      // reported as a sales migration variance.
      expectedNet,
      beforeNet,
      afterNet,
      variances: sales,
    },
    zeroSalesLeaves,
    multiHeadLeaves: multiHeadRes.rows.map((row) => ({
      state_canon: row.state_canon,
      heads: row.heads,
      headCount: Number(row.head_count),
    })),
    tamilNaduHandover: tamilRes.rows.map((row) => ({
      fy: row.fy, month: row.month, head: row.head, net: Number(row.net),
    })),
    tamilNaduCoverageHandover: tamilCoverageRes.rows,
    duplicateTerritoriesRemaining,
    nonAssignableCoverage,
    unassignedCoverage: unassignedRes.rows,
    hiteshRegisterRows: Number(hiteshRes.rows[0]?.count ?? 0),
    mappings: mappingRes.rows,
    derivedCoverage,
    reviewWarnings: {
      coverageIsReadOnly: true,
      unverifiedAliases,
      concentrationWarnings,
    },
    uncoveredGaps,
    derivedIntegrity,
  };
}

export async function buildCanonicalCoverageWorkbook(report: CanonicalCoverageReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prayag Sales Intelligence";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Verification");
  summary.columns = [{ width: 34 }, { width: 24 }];
  summary.addRows([
    ["Canonical state coverage verification", report.passed ? "PASS" : "FAIL"],
    ["FY", report.fy],
    ["Archived legacy rows", report.reconciliation.archivedLegacyRows],
    ["Canonical coverage rows", report.reconciliation.canonicalCoverageRows],
    ["Mapping rows", report.reconciliation.mappingRows],
    ["Unmapped legacy rows", report.reconciliation.unmappedLegacyRows],
    ["FY net before", report.sales.beforeNet],
    ["FY net after", report.sales.afterNet],
    ["Expected FY net", report.sales.expectedNet],
    ["Duplicate territories remaining", report.duplicateTerritoriesRemaining.join(", ") || "none"],
    ["Non-assignable coverage", report.nonAssignableCoverage.join(", ") || "none"],
    ["HITESH register anomaly rows", report.hiteshRegisterRows],
    ["Derived coverage rows", report.derivedCoverage.length],
    ["Explicitly uncovered gaps", report.uncoveredGaps.length],
    ["Source attribution issues", report.derivedIntegrity.attributionIssues],
    ["Derived coverage mismatches", report.derivedIntegrity.coverageMismatches],
    ["Customer evidence mismatches", report.derivedIntegrity.evidenceMismatches],
    ["Punjab FY2023-24 gap reconciles", report.derivedIntegrity.punjabGapMatches ? "yes" : "NO"],
    ["Unverified coverage aliases", report.reviewWarnings.unverifiedAliases.length],
    ["Coverage concentration warnings", report.reviewWarnings.concentrationWarnings.length],
    ["Automatic coverage changes", "never — review only"],
  ]);
  summary.getRow(1).font = { bold: true };

  const mapping = workbook.addWorksheet("Mapping ledger");
  mapping.columns = [
    { header: "Person", key: "person", width: 27 },
    { header: "Responsible state head", key: "state_head", width: 27 },
    { header: "Legacy territory", key: "legacy_territory", width: 25 },
    { header: "Canonical leaf", key: "state_canon", width: 25 },
    { header: "Effective from", key: "effective_from", width: 15 },
    { header: "Effective to", key: "effective_to", width: 15 },
    { header: "Review status", key: "alias_status", width: 20 },
    { header: "Register label", key: "register_head_label", width: 20 },
    { header: "Review note", key: "alias_review_note", width: 75 },
    { header: "Rule", key: "mapping_rule", width: 45 },
  ];
  mapping.addRows(report.mappings);
  mapping.getRow(1).font = { bold: true };
  mapping.views = [{ state: "frozen", ySplit: 1 }];

  const derived = workbook.addWorksheet("Register-derived coverage");
  derived.columns = [
    { header: "FY", key: "fiscal_year", width: 12 },
    { header: "Canonical leaf", key: "state_canon", width: 24 },
    { header: "Coverage person", key: "coverage_person", width: 27 },
    { header: "Responsible state head", key: "responsible_head", width: 27 },
    { header: "Customers", key: "customer_count", width: 13 },
    { header: "Net amount", key: "net_amount", width: 18 },
    { header: "Effective from", key: "effective_from", width: 15 },
    { header: "Effective to", key: "effective_to", width: 15 },
  ];
  derived.addRows(report.derivedCoverage);
  derived.getRow(1).font = { bold: true };
  derived.views = [{ state: "frozen", ySplit: 1 }];

  const review = workbook.addWorksheet("Coverage review warnings");
  review.columns = [
    { header: "Type", key: "type", width: 26 },
    { header: "Canonical leaf", key: "state_canon", width: 24 },
    { header: "FY", key: "fiscal_years", width: 20 },
    { header: "Coverage person", key: "coverage_person", width: 27 },
    { header: "Responsible head", key: "responsible_head", width: 27 },
    { header: "Customer / register label", key: "customer_name", width: 30 },
    { header: "Customers", key: "customer_count", width: 13 },
    { header: "Net amount", key: "net_amount", width: 18 },
    { header: "Review note", key: "note", width: 80 },
  ];
  review.addRows([
    ...report.reviewWarnings.unverifiedAliases.map((row) => ({
      type: row.status,
      state_canon: row.state_canon,
      fiscal_years: row.fiscal_year,
      coverage_person: row.coverage_person,
      responsible_head: row.responsible_head,
      customer_name: row.register_head_label,
      customer_count: row.customer_count,
      net_amount: row.net_amount,
      note: row.review_note,
    })),
    ...report.reviewWarnings.concentrationWarnings.map((row) => ({
      type: "CONCENTRATION REVIEW",
      state_canon: row.state_canon,
      fiscal_years: row.fiscal_years.join(", "),
      coverage_person: row.coverage_person,
      responsible_head: row.responsible_head,
      customer_name: row.customer_name,
      customer_count: row.customer_count,
      net_amount: row.net_amount,
      note: row.message,
    })),
  ]);
  review.getRow(1).font = { bold: true };
  review.views = [{ state: "frozen", ySplit: 1 }];

  const gaps = workbook.addWorksheet("Explicit uncovered gaps");
  gaps.columns = [
    { header: "Leaf", key: "state_canon", width: 24 },
    { header: "FY", key: "fiscal_year", width: 12 },
    { header: "Customers", key: "customer_count", width: 13 },
    { header: "Net amount", key: "net_amount", width: 18 },
    { header: "Reason", key: "reason", width: 70 },
  ];
  gaps.addRows(report.uncoveredGaps);
  gaps.getRow(1).font = { bold: true };

  const heads = workbook.addWorksheet("Sales by head");
  heads.columns = [
    { header: "Head", key: "head", width: 30 },
    { header: "Before", key: "before", width: 18 },
    { header: "After", key: "after", width: 18 },
    { header: "Variance", key: "variance", width: 18 },
  ];
  heads.addRows(report.sales.variances);
  heads.getRow(1).font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}