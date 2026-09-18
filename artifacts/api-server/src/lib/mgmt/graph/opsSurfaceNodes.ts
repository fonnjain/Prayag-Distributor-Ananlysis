/**
 * Prompt 115 D5-D8 graph adapters.
 *
 * These are read-only boundaries around already verified readers.  They do not
 * calculate business metrics and deliberately return a partial node when one
 * prepared sub-report is unavailable.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sanitizeMetadata, type GraphNode } from "./types.js";
import { loadEnvironmentParitySnapshot } from "../../audit/environmentParity.js";
import { buildCanonicalCoverageReport } from "../../canonicalCoverageReport.js";
import { runFullVerify } from "../verifyFull.js";
import { MASTER_CATEGORIES } from "../../categoryDisplay.js";
import top80Snapshots from "../../../config/prompt105-top80-snapshots.json";
import categoryRegistry from "../../../config/prompt68-category-registry.json";

const readTime = () => new Date().toISOString();

function node(path: string, fy: string, name: string, source: string, detail: Record<string, unknown>): GraphNode {
  return {
    path, level: "time", fy, name, measures: [], population: "Prepared operational report",
    source, cutoff: "read at request time", readTime: readTime(), category: "Unmapped",
    flags: [], parent: null, children: [], childrenSumToParent: null, isGap: false, detail: sanitizeMetadata(detail),
  };
}

/** Open, acknowledged and cleared alerts. */
export async function resolveAlertStatus(fy: string): Promise<GraphNode> {
  const result = await db.execute(sql`
    SELECT id, code, entity, entity_key, entity_type, period_label, status,
           periods_open, rupees_at_stake, detail, clear_reason,
           first_seen_at, last_seen_at
      FROM alert
     WHERE fy = ${fy}
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
              last_seen_at DESC
     LIMIT 1000
  `);
  const alerts = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id, code: row.code, entity: row.entity, entityKey: row.entity_key,
    entityType: row.entity_type, period: row.period_label, status: row.status,
    periodsOpen: row.periods_open, valueAtStake: Number(row.rupees_at_stake ?? 0),
    detail: row.detail ?? {}, clearReason: row.clear_reason ?? null,
    firstSeen: row.first_seen_at, lastSeen: row.last_seen_at,
  }));
  return node(`alerts/${fy}`, fy, "Alerts and warning status", "alert persistence (alert table)", {
    availability: alerts.length ? "measured" : "partial",
    alerts, statusCounts: alerts.reduce<Record<string, number>>((out, alert) => {
      out[String(alert.status)] = (out[String(alert.status)] ?? 0) + 1; return out;
    }, {}),
  });
}

/** Data-health reports retain each source's own coverage and audit basis. */
export async function resolveDataHealth(fy: string): Promise<GraphNode> {
  const [parityResult, coverageResult, verificationResult] = await Promise.allSettled([
    loadEnvironmentParitySnapshot(),
    buildCanonicalCoverageReport(),
    runFullVerify(fy),
  ]);
  const available = <T>(result: PromiseSettledResult<T>, source: string) => result.status === "fulfilled"
    ? { availability: "measured", source, value: result.value }
    : { availability: "unavailable", source, reason: String(result.reason ?? "reader failed") };
  const parity = available(parityResult, "environmentParity");
  const coverage = available(coverageResult, "canonicalCoverageReport");
  const verification = available(verificationResult, "fullVerification");
  return node(`data-health/${fy}`, fy, "Data health", "canonical coverage, environment parity, and full verification readers", {
    availability: [parity, coverage, verification].every((item) => item.availability === "measured")
      ? "measured" : "partial",
    mrp: {
      availability: coverage.availability,
      source: "canonicalCoverageReport",
      note: "MRP freshness/coverage remains source-specific; no MRP bases are combined.",
    },
    canonicalCoverage: coverage,
    environmentParity: parity,
    audit: verification,
    expectedKeyManifest: verification.availability === "measured"
      ? (verification.value as { groups: Array<{ id: string; expectedKeys: string[]; totals: unknown }> }).groups.map((group) => ({
        id: group.id, expectedKeys: group.expectedKeys, totals: group.totals,
      }))
      : { availability: "unavailable", reason: "full verification reader unavailable" },
    environmentComparison: {
      availability: "unavailable",
      reason: "A counterpart environment snapshot is not available in this request.",
    },
  });
}

/** Registry assignment is explicit; codes without a reviewed assignment are Unmapped. */
export async function resolveCategoryRegistry(fy: string): Promise<GraphNode> {
  const startYear = Number(fy.slice(0, 4));
  const periodStart = `${startYear}-04-01`;
  const periodEnd = `${startYear + 1}-03-31`;
  const result = await db.execute(sql`
    SELECT UPPER(BTRIM(item_code)) AS code,
           canonical_category,
           source_vocabulary AS provenance,
           effective_from, effective_to, review_status
      FROM canonical_item_category_registry
     WHERE (effective_from IS NULL OR effective_from <= ${periodEnd}::date)
       AND (effective_to IS NULL OR effective_to >= ${periodStart}::date)
     ORDER BY UPPER(BTRIM(item_code)), effective_from DESC NULLS LAST, id DESC
     LIMIT 10000
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const code = String(row.code ?? "");
    if (code && !latest.has(code)) latest.set(code, row);
  }
  const configured = (categoryRegistry as {
    assignments: Array<{ item_code: string; subcategory: string | null; master_category: string | null }>;
  }).assignments;
  const configuredByCode = new Map(configured.map((assignment) => [
    assignment.item_code.trim().toUpperCase(), assignment,
  ]));
  const assignments = [...latest.values()].map((row) => {
    const config = configuredByCode.get(String(row.code ?? "").toUpperCase());
    const reviewed = row.review_status === "seeded" || row.review_status === "confirmed";
    return {
    code: row.code,
    master: reviewed ? (config?.master_category ?? "Unmapped") : "Unmapped",
    subcategory: reviewed ? (config?.subcategory ?? row.canonical_category ?? "Unmapped") : "Unmapped",
    provenance: reviewed ? (row.provenance ?? "registry") : "Unmapped",
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
    reviewStatus: row.review_status ?? null,
    };
  });
  const unmapped = assignments.filter((row) => row.master === "Unmapped").length;
  return node(`category-registry/${fy}`, fy, "Category registry", "canonical_item_category_registry", {
    availability: assignments.length ? "measured" : "unavailable",
    masters: MASTER_CATEGORIES,
    assignments, assignedCount: assignments.length - unmapped, unmappedCount: unmapped,
    unmappedPolicy: "Unmapped is explicit; category is never inferred from code, series, division, or price.",
  });
}

/** Read the immutable approved snapshot; non-approved snapshots remain unavailable. */
export async function resolveTop80Snapshot(snapshotId?: string, fy = "2026-27"): Promise<GraphNode> {
  const snapshots = (top80Snapshots as { snapshots: Array<Record<string, unknown>> }).snapshots;
  const requested = snapshotId
    ? snapshots.find((snapshot) => snapshot.snapshotId === snapshotId)
    : snapshots.find((snapshot) => snapshot.active === true);
  if (!requested || requested.status !== "approved-reproducible" || !requested.membership) {
    return node(`top80/${snapshotId ?? "active"}`, fy, "Top-80 frozen snapshot", "prompt105-top80-snapshots.json", {
      availability: "unavailable",
      reason: "No approved reproducible membership exists for the requested snapshot.",
      requestedSnapshot: snapshotId ?? "active",
    });
  }
  return node(`top80/${String(requested.snapshotId)}`, String(requested.fiscalYear ?? fy),
    "Top-80 frozen snapshot", "prompt105-top80-snapshots.json", {
      availability: "measured", snapshotId: requested.snapshotId, frozenAt: requested.frozenAt,
      sourceDate: requested.sourceDate, period: requested.period, codeCount: requested.codeCount,
      totalValueInr: requested.totalValueInr, sourceTotalInr: requested.sourceTotalInr,
      membership: requested.membership,
    });
}