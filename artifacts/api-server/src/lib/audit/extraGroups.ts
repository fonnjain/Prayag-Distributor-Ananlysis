// Extra audit check groups: Group 1.1 (truncation), Group 6 (report logic), Group 7 (cross-foots),
// Group 8 (pending cross-check), Group 9 (SAP data freshness).
// These extend the core verifyFull groups with data-depth and computation-correctness checks.
import type { CheckGroup, HealthCheck, CheckStatus } from "../mgmt/verifyFull.js";
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

export async function runTruncationGroup(): Promise<CheckGroup> {
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
          note: `Secondary OB ${fy} file not available — upload it to run this check.`,
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
        note: "Could not load order file — check server logs.",
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

export async function runReportLogicGroup(fy: string): Promise<CheckGroup> {
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
        note: "DB query failed — check server logs.",
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

export async function runCrossFootGroup(fy: string): Promise<CheckGroup> {
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
        note: `Could not compare mirror to sheet: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 7.6 PSCode3 sku table vs brand-level mirror (secondary_register_line,
  // source='pscode3_brand_rollup'). The loader refreshes both in one transaction;
  // this flags any per-month NET drift if they ever diverge (e.g. partial manual edits).
  try {
    const mirrorRes = await pool.query(
      `SELECT COALESCE(s.month_label, m.month_label) AS month_label,
              COALESCE(s.net, 0)::numeric AS sku_net,
              COALESCE(m.net, 0)::numeric AS mirror_net
       FROM (SELECT month_label, SUM(net_amount::numeric) AS net
             FROM secondary_sku_line WHERE fy = $1 GROUP BY 1) s
       FULL OUTER JOIN
            (SELECT month_label, SUM(net_amount::numeric) AS net
             FROM secondary_register_line WHERE fy = $1 AND source = 'pscode3_brand_rollup' GROUP BY 1) m
       ON s.month_label = m.month_label
       ORDER BY 1`,
      [fy],
    );
    if (mirrorRes.rows.length > 0) {
      const badMonths: string[] = [];
      let skuTotal = 0;
      let mirrorTotal = 0;
      for (const r of mirrorRes.rows as any[]) {
        const skuNet = Number(r.sku_net);
        const mirrorNet = Number(r.mirror_net);
        skuTotal += skuNet;
        mirrorTotal += mirrorNet;
        if (Math.abs(skuNet - mirrorNet) > 1) badMonths.push(String(r.month_label));
      }
      checks.push({
        key: "cf_7_6_sku_vs_brand_mirror",
        label: `7.6 — PSCode3 sku table = brand-level mirror per month (${fy})`,
        unit: "money",
        expected: Math.round(skuTotal),
        actual: Math.round(mirrorTotal),
        deltaPct: skuTotal !== 0 ? ((mirrorTotal - skuTotal) / skuTotal) * 100 : null,
        status: badMonths.length === 0 ? "pass" : "fail",
        note:
          badMonths.length === 0
            ? `All ${mirrorRes.rows.length} month(s) match: sku NET ₹${(skuTotal / 1e7).toFixed(2)} Cr = mirror NET ₹${(mirrorTotal / 1e7).toFixed(2)} Cr.`
            : `NET mismatch in month(s): ${badMonths.join(", ")} — re-run scripts/pscode3-load.ts --write (refreshes both tables in one transaction) or scripts/pscode3-brand-backfill.ts --write.`,
      });
    }
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
      note: `Could not compare sku table to brand mirror: ${err instanceof Error ? err.message : String(err)}`,
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
      checks: [],
    };
  }
}

// ── Group 8 — Pending cross-check ─────────────────────────────────────────────
// Compares derived pending (OB minus Sale, in ₹) against the factory pending
// sheet (REPORT 2, in units). They are different measures in different units;
// the check just surfaces both figures so a large directional divergence is visible.

async function runPendingCrossCheckGroup(): Promise<CheckGroup> {
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

async function runSapLagGroup(): Promise<CheckGroup> {
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
            key: "sap_lag_no_data",
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

async function runSecondaryPipelineGroup(): Promise<CheckGroup> {
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

// ── Entry point ────────────────────────────────────────────────────────────────

// ── Group 10 — Frozen register anchors (independent reconciliation) ──────────
//
// Compares the sale_line DB (current rows) against the FROZEN register anchors
// in frozen_registers.json — figures verified once against the client's
// registers and then locked. Unlike a self-referential total, this check CAN
// fail: if a sync, migration, or manual write ever changes a closed FY, the
// row count or amount drifts off its anchor and this group flags it.
export async function runFrozenAnchorGroup(): Promise<CheckGroup> {
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
    checks.push({
      key: "frozen_anchor_error",
      label: "Frozen register anchor reconciliation",
      unit: "text",
      expected: null,
      actual: null,
      deltaPct: null,
      status: "fail",
      note: `Could not read sale_line to reconcile against frozen anchors: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return {
    id: "frozen-anchors",
    label: "Group 10 — Frozen register anchors (independent reconciliation)",
    available: true,
    checks,
  };
}

export async function runExtraGroups(fy: string): Promise<CheckGroup[]> {
  const [truncation, reportLogic, crossFoot, pendingCrossCheck, sapLag, frozenAnchors, secondaryPipeline] =
    await Promise.all([
      runTruncationGroup(),
      runReportLogicGroup(fy),
      runCrossFootGroup(fy),
      runPendingCrossCheckGroup(),
      runSapLagGroup(),
      runFrozenAnchorGroup(),
      runSecondaryPipelineGroup(),
    ]);
  return [truncation, reportLogic, crossFoot, pendingCrossCheck, sapLag, frozenAnchors, secondaryPipeline];
}
