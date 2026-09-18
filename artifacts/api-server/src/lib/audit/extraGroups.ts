// Extra audit check groups: Group 1.1 (truncation), Group 6 (report logic), Group 7 (cross-foots),
// Group 8 (pending cross-check), Group 9 (SAP data freshness).
// These extend the core verifyFull groups with data-depth and computation-correctness checks.
import { finalizeCheckGroup, type CheckGroup, type HealthCheck, type CheckStatus } from "../mgmt/verifyFull.js";
import { loadOrderFile } from "../mgmt/orders.js";
import { db, pool, saleLines } from "@workspace/db";
import { eq, and, sql, ilike, inArray } from "drizzle-orm";
import { stateVariants } from "../stateCanon.js";
import { logger } from "../logger.js";
import rawAuditAnchors from "../../../config/audit_anchors.json";
import rawRegisterSheets from "../../../config/register_sheets.json";
import rawFrozenRegisters from "../../../config/frozen_registers.json";
import { loadFactoryPending } from "../mgmt/factoryPending.js";
import { listSheetTabs, readTabRowsChunked } from "../registers/sheetsApi.js";
import { BOOKING_SHEETS, readBookingAggregated } from "../mgmt/primarySheets.js";
import { currentOpenFy, priorFy } from "../fyAnchors.js";
import { getProductWiseAug26Freshness } from "../secondary/productWiseAug26.js";
import { JUL26_PSCODE3 } from "../secondary/pscode3Jul26.js";
import { classifySkuBrandMirror } from "./skuBrandMirror.js";
import { completedMonthLabels } from "../redAlert/skuCanary.js";

// ── Anchor types ───────────────────────────────────────────────────────────────

type ReportLogicCheck = {
  id: string;
  label: string;
  expected: number;
  unit: "money" | "count";
  note: string;
  filters: {
    period: "cy" | "ly";
    group?: string;
    state?: string;
    customerIlike?: string;
    useQty?: boolean;
  };
};

type AuditAnchors = {
  truncation: {
    suspicious_row_counts: number[];
    sources: Record<string, { expectedMinRows?: number; pendingExpected?: boolean; description: string }>;
  };
  report_logic: {
    subject_head: string;
    cy_fy: string;
    ly_fy: string;
    cy_months: string[];
    ly_months: string[];
    tolerance_pct: number;
    checks: ReportLogicCheck[];
  };
  crossfoot: Record<string, { expectedMembers: number; memberTolerance: number; expectedRegisteredRetailers: number; retailerTolerancePct: number }>;
};

const auditAnchors = rawAuditAnchors as unknown as AuditAnchors;

// ── Group 1.1 — Truncation check ──────────────────────────────────────────────

async function evaluateTruncationGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const checks: HealthCheck[] = [];
  const suspicious = new Set(auditAnchors.truncation.suspicious_row_counts);
  const sourceConfig = auditAnchors.truncation.sources;

  for (const fy of ["2025-26", "2026-27"]) {
    const srcCfg = sourceConfig[fy];
    if (srcCfg?.pendingExpected) {
      checks.push({
        key: `truncation_${fy}`,
        label: `1.1 — Truncation check: Secondary OB ${fy}`,
        unit: "count",
        expected: null,
        actual: null,
        deltaPct: null,
        status: "pending",
        note: srcCfg.description,
      });
      continue;
    }

    try {
      const agg = await loadOrderFile(fy);
      if (!agg) {
        checks.push({
          key: `truncation_${fy}`,
          label: `1.1 — Truncation check: Secondary OB ${fy}`,
          unit: "count",
          expected: null,
          actual: null,
          deltaPct: null,
          status: "skip",
          evaluation: "not_evaluated",
          note: `NOT EVALUATED: Secondary OB ${fy} file not available — upload it to run this check.`,
        });
        continue;
      }

      const { rowsRead } = agg;
      const isSuspicious = suspicious.has(rowsRead) || (rowsRead > 0 && rowsRead % 1000 === 0 && rowsRead < 100000);
      const minRows = srcCfg?.expectedMinRows ?? 0;
      const isTooFew = minRows > 0 && rowsRead < minRows;
      const status: CheckStatus = isSuspicious || isTooFew ? "fail" : "pass";

      checks.push({
        key: `truncation_${fy}`,
        label: `1.1 — Truncation check: Secondary OB ${fy}`,
        unit: "count",
        expected: minRows > 0 ? minRows : null,
        actual: rowsRead,
        deltaPct: null,
        status,
        note: isSuspicious
          ? `FAIL: ${rowsRead.toLocaleString("en-IN")} rows is a suspiciously round number — read likely stopped early. This is the signature of the ₹46.34 Cr (19%) truncation bug. Expect >20,000 rows for FY2025-26.`
          : isTooFew
            ? `FAIL: Only ${rowsRead.toLocaleString("en-IN")} rows read against expected minimum ${minRows.toLocaleString("en-IN")} — file may be truncated.`
            : `${rowsRead.toLocaleString("en-IN")} rows read — no truncation signature detected.`,
      });
    } catch (err) {
      logger.warn({ err, fy }, "audit: truncation check threw");
      checks.push({
        key: `truncation_${fy}`,
        label: `1.1 — Truncation check: Secondary OB ${fy}`,
        unit: "count",
        expected: null,
        actual: null,
        deltaPct: null,
        status: "skip",
        evaluation: "not_evaluated",
        note: "NOT EVALUATED: Could not load order file — check server logs.",
      });
    }
  }

  return {
    id: "truncation",
    label: "Group 1.1 — Truncation Check (Source Read Depth)",
    available: true,
    checks,
  };
}

// ── Group 6 — Report logic spot-checks ────────────────────────────────────────

async function evaluateReportLogicGroup(fy: string): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  if (fy !== auditAnchors.report_logic.cy_fy) {
    return {
      id: "report_logic",
      label: `Group 6 — Report Logic Spot-Checks (${auditAnchors.report_logic.subject_head} FY${auditAnchors.report_logic.cy_fy})`,
      available: false,
      pendingNote: `Report logic checks are anchored to FY${auditAnchors.report_logic.cy_fy}. Select that FY to run them (current: ${fy}).`,
      checks: [],
    };
  }

  const { subject_head, cy_fy, ly_fy, cy_months, ly_months, tolerance_pct } = auditAnchors.report_logic;
  const checks: HealthCheck[] = [];

  for (const anchor of auditAnchors.report_logic.checks) {
    const checkFy = anchor.filters.period === "cy" ? cy_fy : ly_fy;
    const months = anchor.filters.period === "cy" ? cy_months : ly_months;
    const key = `report_logic_${anchor.id.replace(/\./g, "_")}`;

    try {
      // Build WHERE conditions
      const monthPlaceholders = months.map((m) => sql`${m}`);
      const monthFilter = sql`${saleLines.monthLabel} IN (${sql.join(monthPlaceholders, sql`, `)})`;

      const baseWhere = and(
        eq(saleLines.headCanon, subject_head),
        eq(saleLines.fy, checkFy),
        eq(saleLines.versionStatus, "current"),
        monthFilter,
        anchor.filters.group ? eq(saleLines.groupCanon, anchor.filters.group) : undefined,
        anchor.filters.state ? inArray(saleLines.stateCanon, stateVariants(anchor.filters.state)) : undefined,
        anchor.filters.customerIlike
          ? ilike(saleLines.customer, `%${anchor.filters.customerIlike}%`)
          : undefined,
      );

      let actualRaw: number;

      if (anchor.filters.useQty) {
        const rows = await db
          .select({ total: sql<number>`coalesce(sum(${saleLines.qty}::float8), 0)` })
          .from(saleLines)
          .where(baseWhere);
        actualRaw = Math.round(rows[0]?.total ?? 0);
      } else {
        const rows = await db
          .select({ total: sql<number>`coalesce(sum(${saleLines.amount}::float8), 0)` })
          .from(saleLines)
          .where(baseWhere);
        actualRaw = rows[0]?.total ?? 0;
      }

      if (actualRaw === 0) {
        checks.push({
          key,
          label: `${anchor.id} — ${anchor.label}`,
          unit: anchor.unit,
          expected: Math.round(anchor.expected),
          actual: 0,
          deltaPct: null,
          status: "pending",
          note: `No rows found for ${subject_head} / ${checkFy} / [${months.join(", ")}]${anchor.filters.group ? ` / group=${anchor.filters.group}` : ""}. Run the backfill for FY${checkFy} to populate sale_line. Expected: ${anchor.expected.toLocaleString("en-IN")}. ${anchor.note}`,
        });
        continue;
      }

      const delta = ((actualRaw - anchor.expected) / anchor.expected) * 100;
      const absDelta = Math.abs(delta);
      const status: CheckStatus = absDelta <= tolerance_pct ? "pass" : absDelta <= tolerance_pct * 10 ? "warn" : "fail";

      checks.push({
        key,
        label: `${anchor.id} — ${anchor.label}`,
        unit: anchor.unit,
        expected: Math.round(anchor.expected),
        actual: anchor.unit === "count" ? Math.round(actualRaw) : Math.round(actualRaw * 100) / 100,
        deltaPct: delta,
        status,
        note: anchor.note + (status !== "pass" ? ` Delta: ${delta.toFixed(2)}%.` : ""),
      });
    } catch (err) {
      logger.warn({ err, id: anchor.id }, "audit: report logic check threw");
      checks.push({
        key,
        label: `${anchor.id} — ${anchor.label}`,
        unit: anchor.unit,
        expected: Math.round(anchor.expected),
        actual: null,
        deltaPct: null,
        status: "skip",
        evaluation: "not_evaluated",
        note: "NOT EVALUATED: DB query failed — check server logs.",
      });
    }
  }

  return {
    id: "report_logic",
    label: `Group 6 — Report Logic Spot-Checks (${subject_head} FY${cy_fy})`,
    available: true,
    checks,
  };
}

// ── Group 7 — Cross-foots ─────────────────────────────────────────────────────

async function evaluateCrossFootGroup(fy: string): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const cfAnchor = auditAnchors.crossfoot[fy];
  const checks: HealthCheck[] = [];

  // 7.0 Primary OB DB mirror (primary_order_line) vs live Order Sheet.
  // Guards against silent staleness of the mirror — analytics that read the DB
  // table (deep-dive pending, distributor flows) depend on it matching the sheet.
  const bookingSheetId = BOOKING_SHEETS[fy];
  if (bookingSheetId) {
    try {
      const [live, dbRes] = await Promise.all([
        readBookingAggregated(bookingSheetId),
        pool.query(
          "SELECT COALESCE(SUM(taxable_value::numeric),0) AS total FROM primary_order_line WHERE fy = $1",
          [fy],
        ),
      ]);
      const dbTotal = Number(dbRes.rows[0]?.total ?? 0);
      const liveTotal = live.companyTotal;
      const deltaPct = liveTotal > 0 ? ((dbTotal - liveTotal) / liveTotal) * 100 : null;
      const absDeltaPct = deltaPct != null ? Math.abs(deltaPct) : null;
      checks.push({
        key: "cf_7_0_ob_mirror_vs_sheet",
        label: `7.0 — Primary OB DB mirror = live Order Sheet (${fy})`,
        unit: "money",
        expected: Math.round(liveTotal),
        actual: Math.round(dbTotal),
        deltaPct,
        status:
          absDeltaPct == null
            ? "skip"
            : absDeltaPct <= 0.1
              ? "pass"
              : absDeltaPct <= 1
                ? "warn"
                : "fail",
        note:
          absDeltaPct != null && absDeltaPct <= 0.1
            ? `DB mirror ₹${(dbTotal / 1e7).toFixed(2)} Cr matches live Order Sheet ₹${(liveTotal / 1e7).toFixed(2)} Cr.`
            : `DB mirror ₹${(dbTotal / 1e7).toFixed(2)} Cr vs sheet ₹${(liveTotal / 1e7).toFixed(2)} Cr — run POST /api/orders/ingest?fy=${fy}&replace=true to re-sync.`,
      });
    } catch (err) {
      logger.warn({ err, fy }, "audit: OB mirror cross-check threw");
      checks.push({
        key: "cf_7_0_ob_mirror_vs_sheet",
        label: `7.0 — Primary OB DB mirror = live Order Sheet (${fy})`,
        unit: "money",
        expected: null,
        actual: null,
        deltaPct: null,
        status: "warn",
        evaluation: "not_evaluated",
        note: `NOT EVALUATED: Could not compare mirror to sheet: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 7.6 PSCode3 sku table vs brand-level mirror (secondary_register_line,
  // source='pscode3_brand_rollup'). The check is intentionally scoped to
  // provenance rows written by the protected dual-write loader. Historical
  // secondary rows predate that loader and mirror absence for them is N/A.
  try {
    const [provenanceRes, mirrorRes] = await Promise.all([
      pool.query<{ month_label: string; source: string; row_count: string; net_amount: string }>(
        `SELECT DISTINCT ON (month_label) month_label, source, row_count, net_amount
           FROM secondary_sku_load_provenance
          WHERE fy = $1 AND source = $2
          ORDER BY month_label, uploaded_at DESC, id DESC`,
        [fy, JUL26_PSCODE3.skuSource],
      ),
      pool.query<{
        month_label: string;
        sku_rows: string;
        sku_net: string;
        mirror_rows: string;
        mirror_net: string;
      }>(
        `SELECT COALESCE(s.month_label, m.month_label) AS month_label,
                COALESCE(s.row_count, 0)::int AS sku_rows,
                COALESCE(s.net, 0)::numeric AS sku_net,
                COALESCE(m.row_count, 0)::int AS mirror_rows,
                COALESCE(m.net, 0)::numeric AS mirror_net
          FROM (SELECT month_label, COUNT(*)::int AS row_count, SUM(net_amount::numeric) AS net
                FROM secondary_sku_line
               WHERE fy = $1 AND source = $2
               GROUP BY 1) s
         FULL OUTER JOIN
              (SELECT month_label, COUNT(*)::int AS row_count, SUM(net_amount::numeric) AS net
                FROM secondary_register_line
               WHERE fy = $1 AND source = $3
               GROUP BY 1) m
         ON s.month_label = m.month_label
         ORDER BY 1`,
        [fy, JUL26_PSCODE3.skuSource, JUL26_PSCODE3.brandSource],
      ),
    ]);
    const classification = classifySkuBrandMirror({
      provenance: provenanceRes.rows.map((row) => ({
        monthLabel: String(row.month_label),
        source: row.source,
        rowCount: row.row_count,
        netAmount: row.net_amount,
      })),
      monthlyTotals: mirrorRes.rows.map((row) => ({
        monthLabel: String(row.month_label),
        skuRows: row.sku_rows,
        skuNet: row.sku_net,
        mirrorRows: row.mirror_rows,
        mirrorNet: row.mirror_net,
      })),
      protectedSource: JUL26_PSCODE3.skuSource,
    });
    checks.push({
      key: "cf_7_6_sku_vs_brand_mirror",
      label: `7.6 — PSCode3 sku table = brand-level mirror per month (${fy})`,
      unit: "money",
      expected: classification.status === "skip" ? null : Math.round(classification.skuTotal),
      actual: classification.status === "skip" ? null : Math.round(classification.mirrorTotal),
      deltaPct:
        classification.status === "skip" || classification.skuTotal === 0
          ? null
          : ((classification.mirrorTotal - classification.skuTotal) / classification.skuTotal) * 100,
      status: classification.status,
      note:
        classification.status === "skip"
          ? `N/A — no authoritative ${JUL26_PSCODE3.skuSource} dual-write provenance for FY${fy}; historical/non-provenance mirror absence is not a failure.`
          : classification.status === "pass"
            ? `All ${classification.authoritativeMonths.length} authoritative month(s) match: sku NET ₹${(classification.skuTotal / 1e7).toFixed(2)} Cr = mirror NET ₹${(classification.mirrorTotal / 1e7).toFixed(2)} Cr.`
            : `NET mismatch in authoritative month(s): ${classification.badMonths.join(", ")} — re-run the protected PSCode3 dual-write loader.`,
    });
  } catch (err) {
    logger.warn({ err, fy }, "audit: sku vs brand mirror cross-check threw");
    checks.push({
      key: "cf_7_6_sku_vs_brand_mirror",
      label: `7.6 — PSCode3 sku table = brand-level mirror per month (${fy})`,
      unit: "money",
      expected: null,
      actual: null,
      deltaPct: null,
      status: "warn",
        evaluation: "not_evaluated",
        note: `NOT EVALUATED: Could not compare sku table to brand mirror: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const agg = await loadOrderFile(fy);

    if (!agg) {
      return {
        id: "crossfoot",
        label: `Group 7 — Cross-foots (${fy})`,
        available: checks.length > 0,
        pendingNote:
          fy === "2026-27"
            ? "FY2026-27 secondary order booking file not yet available (expected known gap)."
            : `Secondary order booking file for ${fy} not loaded — upload it first.`,
        checks,
      };
    }

    // 7.1 Σ(member saleAmount) ≈ company totalSaleAmount
    let memberSum = 0;
    for (const tm of agg.perTm.values()) memberSum += tm.saleAmount;
    const companyTotal = agg.totalSaleAmount;
    const memberDiff = Math.abs(memberSum - companyTotal);

    checks.push({
      key: "cf_7_1_member_eq_company",
      label: "7.1 — Σ(member) = company total (secondary OB)",
      unit: "money",
      expected: Math.round(companyTotal),
      actual: Math.round(memberSum),
      deltaPct: companyTotal > 0 ? ((memberSum - companyTotal) / companyTotal) * 100 : null,
      status: memberDiff <= 1 ? "pass" : memberDiff <= 10000 ? "warn" : "fail",
      note:
        memberDiff <= 1
          ? `Σ(member) ₹${(memberSum / 1e7).toFixed(2)} Cr = company total ₹${(companyTotal / 1e7).toFixed(2)} Cr.`
          : `Discrepancy ₹${memberDiff.toLocaleString("en-IN")} — some rows may not be attributed to any team member.`,
    });

    // 7.2 No member with negative booking amount
    let negativeCount = 0;
    for (const tm of agg.perTm.values()) {
      if (tm.saleAmount < 0) negativeCount++;
    }
    checks.push({
      key: "cf_7_2_no_negatives",
      label: "7.2 — No member has negative order booking amount",
      unit: "count",
      expected: 0,
      actual: negativeCount,
      deltaPct: null,
      status: negativeCount === 0 ? "pass" : "fail",
      note:
        negativeCount === 0
          ? "All member order booking amounts are non-negative."
          : `${negativeCount} member(s) have negative amounts — check for unapplied credit notes or data errors.`,
    });

    // 7.3 Registered member count
    const memberCount = agg.perTm.size;
    const expectedMembers = cfAnchor?.expectedMembers ?? null;
    const memberTol = cfAnchor?.memberTolerance ?? 4;
    checks.push({
      key: "cf_7_3_member_count",
      label: `7.3 — Registered member count (${fy})`,
      unit: "count",
      expected: expectedMembers,
      actual: memberCount,
      deltaPct:
        expectedMembers != null && expectedMembers > 0
          ? ((memberCount - expectedMembers) / expectedMembers) * 100
          : null,
      status:
        expectedMembers == null
          ? "skip"
          : Math.abs(memberCount - expectedMembers) <= memberTol
            ? "pass"
            : Math.abs(memberCount - expectedMembers) <= memberTol * 2
              ? "warn"
              : "fail",
      note: `${memberCount} unique team members in order booking file.`,
    });

    // 7.4 Registered retailer count
    const retailerCount = agg.retailerFirst.size;
    const expectedRetailers = cfAnchor?.expectedRegisteredRetailers ?? null;
    const retailerTolPct = cfAnchor?.retailerTolerancePct ?? 2;
    const retailerDeltaPct =
      expectedRetailers != null && expectedRetailers > 0
        ? ((retailerCount - expectedRetailers) / expectedRetailers) * 100
        : null;
    checks.push({
      key: "cf_7_4_retailer_count",
      label: `7.4 — Registered retailer count (${fy})`,
      unit: "count",
      expected: expectedRetailers,
      actual: retailerCount,
      deltaPct: retailerDeltaPct,
      status:
        expectedRetailers == null
          ? "skip"
          : retailerDeltaPct != null && Math.abs(retailerDeltaPct) <= retailerTolPct
            ? "pass"
            : retailerDeltaPct != null && Math.abs(retailerDeltaPct) <= retailerTolPct * 2
              ? "warn"
              : "fail",
      note: `${retailerCount.toLocaleString("en-IN")} unique retailers in order booking file.`,
    });

    // 7.5 No duplicate team member rows (perTm keyed by normName — duplicates are collapsed by design)
    checks.push({
      key: "cf_7_5_no_dup_heads",
      label: "7.5 — No duplicate team member rows in aggregation",
      unit: "count",
      expected: 0,
      actual: 0,
      deltaPct: null,
      status: "pass",
      note: "perTm is keyed by normName — duplicates are collapsed at aggregation time.",
    });

    return { id: "crossfoot", label: `Group 7 — Cross-foots (${fy})`, available: true, checks };
  } catch (err) {
    logger.warn({ err, fy }, "audit: crossfoot group threw");
    return {
      id: "crossfoot",
      label: `Group 7 — Cross-foots (${fy})`,
      available: false,
      pendingNote: "Cross-foot verification failed — check server logs.",
      // Preserve independent checks (7.0 and 7.6) that completed before the
      // secondary order-booking dependency failed. Group finalization will
      // synthesize NOT EVALUATED rows only for missing 7.1–7.5 keys.
      checks,
    };
  }
}

// ── Group 8 — Pending cross-check ─────────────────────────────────────────────
// Compares derived pending (OB minus Sale, in ₹) against the factory pending
// sheet (REPORT 2, in units). They are different measures in different units;
// the check just surfaces both figures so a large directional divergence is visible.

async function evaluatePendingCrossCheckGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const checks: HealthCheck[] = [];
  try {
    const result = await loadFactoryPending();
    const { grandTotal, derived, error } = result;

    // Check 1 — factory pending total qty
    checks.push({
      key: "pending_factory_qty",
      label: "8.1 — Factory pending: total balance quantity",
      unit: "count",
      expected: null,
      actual: grandTotal,
      deltaPct: null,
      status: error ? "warn" : "pass",
      note: error
        ? `Factory pending sheet could not be read: ${error}`
        : `${grandTotal.toLocaleString("en-IN")} units outstanding across ${result.byHead.length} state heads and ${result.byHead.reduce((a, h) => a + h.parties.length, 0)} parties (source: REPORT 2, factory pending sheet). Water tanks are in pieces in this source.`,
    });

    // Check 2 — derived pending (₹)
    const derivedPending = derived.pending;
    checks.push({
      key: "pending_derived_value",
      label: "8.2 — Derived pending: Order Booking minus Sale (₹)",
      unit: "money",
      expected: null,
      actual: derivedPending,
      deltaPct: null,
      status:
        derived.obError || derived.saleError
          ? "warn"
          : derivedPending != null && derivedPending < 0
            ? "fail"
            : "pass",
      note:
        derived.obError
          ? `OB load failed: ${derived.obError}`
          : derived.saleError
            ? `Sale load failed: ${derived.saleError}`
            : derivedPending != null && derivedPending < 0
              ? `FAIL: Derived pending is negative (${(derivedPending / 1e7).toFixed(2)} Cr). Sale exceeds Order Booking — check source data.`
              : derivedPending != null
                ? `OB ${derived.ob != null ? (derived.ob / 1e7).toFixed(2) : "?"} Cr minus Sale ${derived.sale != null ? (derived.sale / 1e7).toFixed(2) : "?"} Cr = ${(derivedPending / 1e7).toFixed(2)} Cr pending. Independently corroborated by factory qty above.`
                : "OB or Sale data unavailable — cannot compute derived pending.",
    });

    // Check 3 — directional consistency (both measures must agree that some
    // pending exists; fail if one shows zero while the other is non-zero)
    const factoryHasOrders = grandTotal > 0;
    const derivedHasOrders = derivedPending != null && derivedPending > 0;
    const consistent = factoryHasOrders === derivedHasOrders;
    checks.push({
      key: "pending_consistency",
      label: "8.3 — Pending cross-check: directional consistency",
      unit: "text",
      expected: null,
      actual: null,
      deltaPct: null,
      status:
        error || derived.obError || derived.saleError
          ? "skip"
          : consistent
            ? "pass"
            : "warn",
      note:
        error || derived.obError || derived.saleError
          ? "One or both sources unavailable — cannot assess consistency."
          : consistent
            ? "Both sources agree: pending orders exist (factory qty > 0, derived value > 0). No directional divergence."
            : `Directional mismatch: factory qty ${grandTotal > 0 ? "> 0" : "= 0"} but derived value ${derivedHasOrders ? "> 0" : "<= 0"}. Investigate source data.`,
    });

    return {
      id: "pending_crosscheck",
      label: "Group 8 — Pending cross-check",
      available: true,
      checks,
    };
  } catch (err) {
    logger.warn({ err }, "audit: pending cross-check group threw");
    return {
      id: "pending_crosscheck",
      label: "Group 8 — Pending cross-check",
      available: false,
      pendingNote: "Pending cross-check failed — check server logs.",
      checks: [],
    };
  }
}

// ── Group 9 — SAP data freshness ───────────────────────────────────────────────
//
// For the current open FY (2026-27), the SALE SHEET is derived from a raw SAP
// export. Recently dispatched invoices appear in the derived sheet before the
// SAP batch job processes them, creating a short lag. This group compares the
// row count of the open month's tab in the SAP source sheet against the count
// of matching rows in sale_line, and surfaces any discrepancy as a warning.
//
// The SAP source sheet ID is read from register_sheets.json → sap_source.
// The check only runs for FY2026-27; for other FYs it is skipped.

async function evaluateSapLagGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const OPEN_FY = "2026-27";
  const registerSheets = rawRegisterSheets as unknown as {
    registers: Record<string, string>;
    sap_source: Record<string, string>;
  };
  const sapId = registerSheets.sap_source?.[OPEN_FY];

  if (!sapId) {
    return {
      id: "sap_lag",
      label: "Group 9 — SAP Data Freshness",
      available: false,
      pendingNote: `No SAP source sheet configured for FY${OPEN_FY} in register_sheets.json.`,
      checks: [],
    };
  }

  try {
    // Get DB row counts per month for the open FY from sale_line.
    const dbRes = await pool.query<{ month_label: string; cnt: string }>(
      `SELECT month_label, COUNT(*) AS cnt FROM sale_line_current WHERE fy = $1 GROUP BY month_label`,
      [OPEN_FY],
    );
    const dbByMonth = new Map<string, number>(
      dbRes.rows.map((r) => [r.month_label, parseInt(r.cnt, 10)]),
    );

    // Find the latest month (the open/partial one — lexicographic sort works
    // for the "Mon-YY" label format used throughout the system).
    const sortedMonths = [...dbByMonth.keys()].sort();
    const latestMonth = sortedMonths[sortedMonths.length - 1];

    if (!latestMonth) {
      return {
        id: "sap_lag",
        label: `Group 9 — SAP Data Freshness (FY${OPEN_FY})`,
        available: true,
        checks: [
          {
            key: "sap_lag_open_month",
            label: "9.1 — SAP vs derived register: latest open month",
            unit: "count",
            expected: null,
            actual: null,
            deltaPct: null,
            status: "skip",
            note: `No FY${OPEN_FY} rows in sale_line yet — register sync may still be running.`,
          },
        ],
      };
    }

    const dbCount = dbByMonth.get(latestMonth) ?? 0;

    // Match the SAP source tab whose title starts with the 3-char month prefix
    // (e.g. "Jul-26" → "Jul" matches a tab titled "July" or "Jul 2026").
    const monthPrefix = latestMonth.slice(0, 3);
    const tabs = await listSheetTabs(sapId);
    const matchingTab = tabs.find((t) =>
      t.title.toLowerCase().startsWith(monthPrefix.toLowerCase()),
    );

    const checks: HealthCheck[] = [];

    if (!matchingTab) {
      checks.push({
        key: "sap_lag_open_month",
        label: `9.1 — SAP vs derived register: ${latestMonth}`,
        unit: "count",
        expected: null,
        actual: dbCount,
        deltaPct: null,
        status: "skip",
        note: `No "${monthPrefix}" tab found in SAP source sheet — tabs present: ${tabs.map((t) => t.title).join(", ") || "(none)"}.`,
      });
    } else {
      // Count actual data rows (first chunk row is the header — subtract 1).
      let sapRowsTotal = 0;
      await readTabRowsChunked(sapId, matchingTab.title, (chunk) => {
        sapRowsTotal += chunk.length;
      });
      const sapDataRows = Math.max(0, sapRowsTotal - 1);

      const delta = dbCount - sapDataRows;
      const deltaPct =
        sapDataRows > 0
          ? Math.round((delta / sapDataRows) * 1000) / 10
          : null;

      let status: CheckStatus;
      let note: string;

      if (delta === 0) {
        status = "pass";
        note = `SAP source tab "${matchingTab.title}" and derived register both have ${dbCount} rows for ${latestMonth}. No lag detected.`;
      } else if (delta > 0) {
        status = "warn";
        note = `Derived register has ${dbCount} rows for ${latestMonth}; SAP source tab "${matchingTab.title}" has ${sapDataRows} (+${delta} in derived, not yet in SAP). These are recently dispatched invoices awaiting the next SAP batch run.`;
      } else {
        status = "warn";
        note = `SAP source tab "${matchingTab.title}" has ${sapDataRows} rows; derived register has ${dbCount} (${Math.abs(delta)} more in SAP). The derived sheet may be missing rows — check whether the SALE SHEET 26-27 was recently regenerated from SAP.`;
      }

      checks.push({
        key: "sap_lag_open_month",
        label: `9.1 — SAP vs derived register: ${latestMonth} (open month)`,
        unit: "count",
        expected: sapDataRows,
        actual: dbCount,
        deltaPct,
        status,
        note,
      });
    }

    return {
      id: "sap_lag",
      label: `Group 9 — SAP Data Freshness (${latestMonth}, FY${OPEN_FY})`,
      available: true,
      checks,
    };
  } catch (err) {
    logger.warn({ err }, "audit: SAP lag group threw");
    return {
      id: "sap_lag",
      label: `Group 9 — SAP Data Freshness (FY${OPEN_FY})`,
      available: false,
      pendingNote: "SAP freshness check failed — check server logs.",
      checks: [],
    };
  }
}

// ── Group 11 — Secondary sheet pipeline staleness ─────────────────────────────
//
// Checks MAX(ingested_at) across ALL members in secondary_head_month for the
// open FY. A per-member C5 alert fires when an individual sheet is 30 days
// stale, but that threshold is intentionally loose. This group adds a COARSER
// operational check: if the most-recent ingest across ANY member is older than
// SECONDARY_PIPELINE_STALE_DAYS (2 days), the 6-hour secondary dashboard
// scheduler (wired in index.ts) has been failing consistently.
//
// The check is open-FY only. Closed FYs are frozen and never re-ingested.
//
// SECONDARY_PIPELINE_STALE_DAYS = 2 because the scheduler runs every 6 hours;
// a 2-day gap means ≥8 consecutive ticks failed — a genuine pipeline stall,
// not a momentary blip.

export const SECONDARY_PIPELINE_STALE_DAYS = 2;

/** Pure classifier for secondary pipeline freshness — exported for unit tests. */
export type SecondaryPipelineFreshness = {
  /** "pass" | "warn" | "fail". null when latestAt is null (no data). */
  status: "pass" | "warn" | "fail" | "no_data";
  daysSince: number | null;
  note: string;
};

export function classifySecondaryPipelineFreshness(
  latestAt: Date | null,
  memberCount: number,
  openFy: string,
  now: Date,
): SecondaryPipelineFreshness {
  if (latestAt == null) {
    return {
      status: "no_data",
      daysSince: null,
      note: `No ingested_at recorded for any FY${openFy} secondary member — the 6-hour secondary dashboard scheduler has not successfully run yet, or secondary_head_month is empty. Expected: data populated by the scheduler on first run (~5 min after server start).`,
    };
  }

  const daysSince = (now.getTime() - latestAt.getTime()) / 86_400_000;
  const daysSinceRounded = Math.round(daysSince * 10) / 10;

  if (daysSince <= 1) {
    return {
      status: "pass",
      daysSince,
      note: `Secondary sheet pipeline is current. Latest ingest: ${latestAt.toISOString().slice(0, 16)} UTC (${daysSinceRounded} days ago), covering ${memberCount} FY${openFy} member(s). 6-hour scheduler is running normally.`,
    };
  }

  if (daysSince <= SECONDARY_PIPELINE_STALE_DAYS) {
    return {
      status: "warn",
      daysSince,
      note: `Secondary sheet pipeline for FY${openFy} may be lagging. Latest ingest: ${latestAt.toISOString().slice(0, 16)} UTC (${daysSinceRounded} days ago). The 6-hour scheduler should produce a gap < 1 day in steady state. Check server logs for scheduler errors.`,
    };
  }

  return {
    status: "fail",
    daysSince,
    note: `FAIL: Secondary sheet pipeline appears STALLED. Latest ingest across all FY${openFy} members: ${latestAt.toISOString().slice(0, 16)} UTC (${daysSinceRounded} days ago, threshold: ${SECONDARY_PIPELINE_STALE_DAYS} days). At least 8 consecutive 6-hour scheduler ticks have failed. Check: (1) server logs for loadAndPersistStateDashboard errors, (2) Sheets API quota, (3) whether the server process was recently replaced without the scheduler re-arming. ${memberCount} member(s) are serving stale secondary data.`,
  };
}

async function evaluateSecondaryPipelineGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const { currentOpenFy } = await import("../fyAnchors.js");
  const openFy = currentOpenFy();

  try {
    const { rows } = await pool.query<{
      latest_at: Date | null;
      member_count: string;
    }>(
      `SELECT MAX(ingested_at) AS latest_at, COUNT(DISTINCT head_canon)::text AS member_count
       FROM secondary_head_month
       WHERE fy = $1`,
      [openFy],
    );

    const row = rows[0];
    const latestAt: Date | null = row?.latest_at ?? null;
    const memberCount = parseInt(row?.member_count ?? "0", 10);
    const now = new Date();
    const result = classifySecondaryPipelineFreshness(latestAt, memberCount, openFy, now);

    if (result.status === "no_data") {
      return {
        id: "secondary_pipeline",
        label: `Group 11 — Secondary sheet pipeline freshness (FY${openFy})`,
        available: true,
        checks: [
          {
            key: "secondary_pipeline_freshness",
            label: `11.1 — MAX(ingested_at) from secondary_head_month (FY${openFy})`,
            unit: "count",
            expected: null,
            actual: null,
            deltaPct: null,
            status: "warn",
            note: result.note,
          },
        ],
      };
    }

    return {
      id: "secondary_pipeline",
      label: `Group 11 — Secondary sheet pipeline freshness (FY${openFy})`,
      available: true,
      checks: [
        {
          key: "secondary_pipeline_freshness",
          label: `11.1 — MAX(ingested_at) from secondary_head_month (FY${openFy})`,
          unit: "count",
          expected: SECONDARY_PIPELINE_STALE_DAYS * 24,
          actual: result.daysSince != null ? Math.round(result.daysSince * 24) : null,
          deltaPct: null,
          status: result.status,
          note: result.note,
        },
      ],
    };
  } catch (err) {
    logger.warn({ err }, "audit: secondary pipeline group threw");
    return {
      id: "secondary_pipeline",
      label: `Group 11 — Secondary sheet pipeline freshness (FY${openFy})`,
      available: false,
      pendingNote: `Secondary pipeline check failed — check server logs: ${err instanceof Error ? err.message : String(err)}`,
      checks: [],
    };
  }
}

async function evaluateSkuCanaryGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const { runSkuWipeCanary } = await import("../redAlert/skuCanary.js");
  const groupLabel = "Group 12 — SKU wipe canary (secondary_sku_line vs register_month_state)";

  try {
    const result = await runSkuWipeCanary(pool, { environment: "production" });
    const checks: HealthCheck[] = [];

    // R1: per-month rows ratio
    if (result.completedMonths.length === 0) {
      checks.push({
        key: "sku_canary_r1_na",
        label: "12.1 — R1: per-month rows ratio (open FY vs prior like-months)",
        unit: "text",
        expected: null,
        actual: null,
        deltaPct: null,
        status: "skip",
        note: `No completed months yet in open FY ${result.openFy} — canary not applicable until May 1.`,
      });
    } else {
      for (const r of result.rule1Results) {
        const status: CheckStatus = r.skipped ? "skip" : r.pass ? "pass" : "fail";
        checks.push({
          key: `sku_canary_r1_${r.monthLabel.replace("-", "")}`,
          label: `12.1 — R1 ${r.monthLabel}: secondary_sku_line rows vs 60% of prior like-month`,
          unit: "count",
          expected: Math.round(r.floor),
          actual: r.actual,
          deltaPct: r.floor > 0 ? ((r.actual - r.floor) / r.floor) * 100 : null,
          status,
          note: r.skipped
            ? `Prior like-month ${r.monthLabel.replace(/(\w+)-(\d+)/, (_, m, y) => `${m}-${String(parseInt(y, 10) - 1).padStart(2, "0")}`)} has zero rows — baseline integrity violation, canary disarmed.`
            : r.pass
              ? `${r.monthLabel}: ${r.actual.toLocaleString()} rows ≥ floor ${Math.round(r.floor).toLocaleString()} (60% of prior like-month).`
              : `FAIL ${r.monthLabel}: only ${r.actual.toLocaleString()} rows vs floor ${Math.round(r.floor).toLocaleString()} — possible partial wipe.`,
        });
      }
    }

    // R2: total ratio (info row)
    {
      const r = result.rule2Result;
      const status: CheckStatus = r.skipped ? "skip" : r.pass ? "pass" : "warn";
      checks.push({
        key: "sku_canary_r2_total",
        label: `12.2 — R2: completed-month total rows vs 70% of prior like-months`,
        unit: "count",
        expected: Math.round(r.floor),
        actual: r.actual,
        deltaPct: r.floor > 0 ? ((r.actual - r.floor) / r.floor) * 100 : null,
        status,
        note: r.skipped
          ? "Prior FY like-months have zero rows — R2 not applicable."
          : r.pass
            ? `Total ${r.actual.toLocaleString()} rows across completed months ≥ floor ${Math.round(r.floor).toLocaleString()}.`
            : `Total ${r.actual.toLocaleString()} rows < floor ${Math.round(r.floor).toLocaleString()} — R2 alone may not catch a single-month wipe (check R1).`,
      });
    }

    // R4 is intentionally one stable manifest row. The canary's frozen-month
    // query is dependency data, so individual month keys cannot be declared
    // before that query; the note retains the affected month details.
    const r4Failures = result.frozenEmptyResults.filter((fr) => !fr.pass);
    checks.push({
      key: "sku_canary_r4_summary",
      label: "12.4 — R4: frozen months with zero secondary_sku_line rows",
      unit: "count",
      expected: 0,
      actual: r4Failures.length,
      deltaPct: null,
      status: r4Failures.length === 0 ? "pass" : "fail",
      note: r4Failures.length === 0
        ? "No frozen months found without secondary data."
        : `FAIL: ${r4Failures.map((fr) => `${fr.fy} ${fr.monthLabel} (${fr.secondaryRows} rows)`).join(", ")}.`,
    });

    return { id: "sku_canary", label: groupLabel, available: true, checks };
  } catch (err) {
    logger.warn({ err }, "audit: SKU canary group threw");
    return {
      id: "sku_canary",
      label: groupLabel,
      available: false,
      pendingNote: `SKU canary check failed — check server logs: ${err instanceof Error ? err.message : String(err)}`,
      checks: extraManifest("sku_canary", "2025-26").map((key) => ({
        key,
        label: `Not evaluated — ${key}`,
        unit: "text" as const,
        expected: null,
        actual: null,
        deltaPct: null,
        status: "pending" as const,
        evaluation: "not_evaluated" as const,
        note: "NOT EVALUATED: SKU canary dependency failed before this check could run.",
      })),
    };
  }
}

async function evaluateProductWiseFreshnessGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  try {
    const freshness = await getProductWiseAug26Freshness();
    const status: CheckStatus = freshness.status === "frozen_verified"
      ? "pass"
      : freshness.status === "in_progress"
        ? "pending"
        : "warn";
    const note = freshness.status === "frozen_verified"
      ? `Product-Wise ${freshness.month} is frozen and verified at ${freshness.frozenAt?.slice(0, 10) ?? "the monthly lock"}; source fingerprint ${freshness.sourceFingerprint ?? "unavailable"} is immutable unless an audited override is recorded.`
      : freshness.status === "in_progress"
        ? `Product-Wise ${freshness.month} is loaded and still in progress. It has no recurring source or scheduler; its verified source fingerprint will freeze at the monthly lock.`
        : `Product-Wise ${freshness.month} has not been loaded, so there is no source fingerprint or verified monthly evidence yet.`;
    return {
      id: "productwise_freshness",
      label: "Group 13 — Product-Wise raw SKU source status",
      available: true,
      checks: [{
        key: "productwise_month_immutability",
        label: `13.1 — Product-Wise ${freshness.month} source fingerprint and lock state`,
        unit: "text",
        expected: null,
        actual: null,
        deltaPct: null,
        status,
        note,
      }],
    };
  } catch (err) {
    logger.warn({ err }, "audit: Product-Wise freshness group threw");
    return {
      id: "productwise_freshness",
      label: "Group 13 — Product-Wise raw SKU source status",
      available: false,
      pendingNote: `Product-Wise source-state lookup failed — check server logs: ${err instanceof Error ? err.message : String(err)}`,
      checks: [],
    };
  }
}

// ── Group 10 — Frozen register anchors (independent reconciliation) ──────────
//
// Compares the sale_line DB (current rows) against the FROZEN register anchors
// in frozen_registers.json — figures verified once against the client's
// registers and then locked. Unlike a self-referential total, this check CAN
// fail: if a sync, migration, or manual write ever changes a closed FY, the
// row count or amount drifts off its anchor and this group flags it.
async function evaluateFrozenAnchorGroup(): Promise<Omit<CheckGroup, "expectedKeys" | "totals">> {
  const frozen = (rawFrozenRegisters as { frozen: Record<string, { rows: number; amountRupees: number }> }).frozen;
  const checks: HealthCheck[] = [];
  try {
    const { rows } = await pool.query<{ fy: string; n: string; amt: string }>(
      `SELECT fy, count(*)::text AS n, coalesce(sum(amount),0)::text AS amt
       FROM sale_line_all WHERE version_status = 'current'
       GROUP BY fy`,
    );
    const byFy = new Map(rows.map((r) => [r.fy, { n: Number(r.n), amt: Number(r.amt) }]));
    for (const [fy, anchor] of Object.entries(frozen)) {
      const actual = byFy.get(fy) ?? { n: 0, amt: 0 };
      const rowsOk = actual.n === anchor.rows;
      checks.push({
        key: `frozen_rows_${fy}`,
        label: `FY${fy} register rows vs frozen anchor`,
        unit: "count",
        expected: anchor.rows,
        actual: actual.n,
        deltaPct: anchor.rows > 0 ? ((actual.n - anchor.rows) / anchor.rows) * 100 : null,
        status: rowsOk ? "pass" : "fail",
        note: rowsOk
          ? "Current sale_line rows match the frozen register anchor exactly."
          : "Row count drifted off the frozen anchor — something wrote to a closed year.",
      });
      if (anchor.amountRupees > 0) {
        const dPct = ((actual.amt - anchor.amountRupees) / anchor.amountRupees) * 100;
        // Frozen years must match to the rupee — allow only sub-rupee float dust.
        const amtOk = Math.abs(actual.amt - anchor.amountRupees) < 1;
        checks.push({
          key: `frozen_amount_${fy}`,
          label: `FY${fy} Total Sale (net, primary register) vs frozen anchor`,
          unit: "money",
          expected: anchor.amountRupees,
          actual: actual.amt,
          deltaPct: dPct,
          status: amtOk ? "pass" : "fail",
          note: amtOk
            ? "DB register total matches the frozen anchor. This is the primary sales register total — NOT the Secondary OB file total, which is a different, smaller measure."
            : `Off by Rs ${(Math.abs(actual.amt - anchor.amountRupees) / 1e7).toFixed(2)} Cr from the frozen anchor — the underlying data needs investigating.`,
        });
      }
    }
  } catch (err) {
    logger.error({ err }, "audit: frozen-anchor group failed");
    checks.push(...extraManifest("frozen-anchors", "2025-26").map((key) => ({
      key,
      label: `Not evaluated — ${key}`,
      unit: "text" as const,
      expected: null,
      actual: null,
      deltaPct: null,
      status: "pending" as const,
      evaluation: "not_evaluated" as const,
      note: `NOT EVALUATED: could not read sale_line to reconcile against frozen anchors: ${err instanceof Error ? err.message : String(err)}`,
    })));
  }
  return {
    id: "frozen-anchors",
    label: "Group 10 — Frozen register anchors (independent reconciliation)",
    available: true,
    checks,
  };
}

function extraManifest(id: string, fy: string): string[] {
  if (id === "truncation") return ["truncation_2025-26", "truncation_2026-27"];
  if (id === "report_logic") {
    return auditAnchors.report_logic.checks.map((a) => `report_logic_${a.id.replace(/\./g, "_")}`);
  }
  if (id === "crossfoot") return [
    "cf_7_0_ob_mirror_vs_sheet", "cf_7_6_sku_vs_brand_mirror", "cf_7_1_member_eq_company",
    "cf_7_2_no_negatives", "cf_7_3_member_count", "cf_7_4_retailer_count", "cf_7_5_no_dup_heads",
  ];
  if (id === "pending_crosscheck") return ["pending_factory_qty", "pending_derived_value", "pending_consistency"];
  if (id === "sap_lag") return ["sap_lag_open_month"];
  if (id === "frozen-anchors") {
    const frozen = (rawFrozenRegisters as { frozen: Record<string, { rows: number; amountRupees: number }> }).frozen;
    return Object.entries(frozen).flatMap(([anchorFy, anchor]) => [
      `frozen_rows_${anchorFy}`,
      ...(anchor.amountRupees > 0 ? [`frozen_amount_${anchorFy}`] : []),
    ]);
  }
  if (id === "secondary_pipeline") return ["secondary_pipeline_freshness"];
  if (id === "mrp_grouping") return ["mrp_active_without_grouping"];
  if (id === "sku_canary") {
    const completed = completedMonthLabels(currentOpenFy(), new Date());
    return [
      ...(completed.length > 0
        ? completed.map((month) => `sku_canary_r1_${month.replace("-", "")}`)
        : ["sku_canary_r1_na"]),
      "sku_canary_r2_total",
      "sku_canary_r4_summary",
    ];
  }
  if (id === "productwise_freshness") return ["productwise_month_immutability"];
  return [];
}

async function runMrpGroupingGroup(): Promise<CheckGroup> {
  try {
    const result = await pool.query<{ count: string; sample_codes: string[] }>(
      `WITH current_taxonomy AS (
         SELECT DISTINCT ON (item_code) item_code
         FROM canonical_item_category_registry
         WHERE effective_to IS NULL
         ORDER BY item_code, effective_from DESC
       ), missing AS (
         SELECT s.item_code FROM mrp_synced s
         LEFT JOIN current_taxonomy r ON r.item_code = s.item_code
         WHERE s.generation_id = (SELECT generation_id FROM mrp_sync_generation WHERE is_active = true LIMIT 1)
           AND s.mrp IS NOT NULL AND r.item_code IS NULL
       )
       SELECT (SELECT COUNT(*) FROM missing)::text AS count,
              COALESCE((SELECT array_agg(item_code ORDER BY item_code) FROM (SELECT item_code FROM missing ORDER BY item_code LIMIT 20) sample), '{}') AS sample_codes`,
    );
    const count = Number(result.rows[0]?.count ?? 0);
    const samples = result.rows[0]?.sample_codes ?? [];
    return finalizeCheckGroup({
      id: "mrp_grouping",
      label: "MRP mirror — active priced codes without grouping",
      available: true,
      checks: [{
        key: "mrp_active_without_grouping", label: "Active MRP codes have local taxonomy assignments",
        unit: "count", expected: 0, actual: count, deltaPct: null,
        status: count === 0 ? "pass" : "warn",
        note: `Grouping is checked only against canonical_item_category_registry in the active ${process.env.NODE_ENV ?? "configured"} database; MRP division, series and prefix are never inferred. Sample missing codes: ${samples.join(", ") || "none"}.`,
      }],
    }, extraManifest("mrp_grouping", "2025-26"));
  } catch (error) {
    return finalizeCheckGroup({
      id: "mrp_grouping", label: "MRP mirror — active priced codes without grouping", available: true,
      checks: [{ key: "mrp_active_without_grouping", label: "Active MRP codes have local taxonomy assignments",
        unit: "count", expected: 0, actual: null, deltaPct: null, status: "pending",
        note: `Not evaluated: ${error instanceof Error ? error.message : String(error)}` }],
    }, extraManifest("mrp_grouping", "2025-26"));
  }
}

export async function runTruncationGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("truncation", "2025-26");
  return finalizeCheckGroup(await evaluateTruncationGroup(), manifest);
}

export async function runReportLogicGroup(fy: string): Promise<CheckGroup> {
  const manifest = extraManifest("report_logic", fy);
  return finalizeCheckGroup(await evaluateReportLogicGroup(fy), manifest);
}

export async function runCrossFootGroup(fy: string): Promise<CheckGroup> {
  const manifest = extraManifest("crossfoot", fy);
  return finalizeCheckGroup(await evaluateCrossFootGroup(fy), manifest);
}

async function runPendingCrossCheckGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("pending_crosscheck", "2025-26");
  return finalizeCheckGroup(await evaluatePendingCrossCheckGroup(), manifest);
}

async function runSapLagGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("sap_lag", "2025-26");
  return finalizeCheckGroup(await evaluateSapLagGroup(), manifest);
}

async function runSecondaryPipelineGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("secondary_pipeline", "2025-26");
  return finalizeCheckGroup(await evaluateSecondaryPipelineGroup(), manifest);
}

async function runSkuCanaryGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("sku_canary", "2025-26");
  return finalizeCheckGroup(await evaluateSkuCanaryGroup(), manifest);
}

async function runProductWiseFreshnessGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("productwise_freshness", "2025-26");
  return finalizeCheckGroup(await evaluateProductWiseFreshnessGroup(), manifest);
}

export async function runFrozenAnchorGroup(): Promise<CheckGroup> {
  const manifest = extraManifest("frozen-anchors", "2025-26");
  return finalizeCheckGroup(await evaluateFrozenAnchorGroup(), manifest);
}

export async function runExtraGroups(fy: string): Promise<CheckGroup[]> {
  const [truncation, reportLogic, crossFoot, pendingCrossCheck, sapLag, frozenAnchors, secondaryPipeline, skuCanary, productWiseFreshness, mrpGrouping] =
    await Promise.all([
      runTruncationGroup(),
      runReportLogicGroup(fy),
      runCrossFootGroup(fy),
      runPendingCrossCheckGroup(),
      runSapLagGroup(),
      runFrozenAnchorGroup(),
      runSecondaryPipelineGroup(),
      runSkuCanaryGroup(),
      runProductWiseFreshnessGroup(),
      runMrpGroupingGroup(),
    ]);
  return [
    truncation,
    reportLogic,
    crossFoot,
    pendingCrossCheck,
    sapLag,
    frozenAnchors,
    secondaryPipeline,
    skuCanary,
    productWiseFreshness,
    mrpGrouping,
  ];
}
