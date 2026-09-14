import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeCursor,
  encodeCursor,
  applyCursor,
  checkCursor,
  dataSourceFromDatabaseName,
  ExternalSourceChangedError,
  ensureSourceStable,
  fiscalMonths,
  monthUnavailableForMargin,
  monthlyAttributionPeriodLabels,
  parseExternalRequest,
  P003_RECONCILIATION,
  queryHash,
  requestedCoverage,
  reconciliation,
  resolveExternalHoldRows,
  resolveCatalogueStatus,
} from "./externalItemAnalytics.js";

const implementation = readFileSync(new URL("./externalItemAnalytics.ts", import.meta.url), "utf8");
const migrations = readFileSync(new URL("../../../../lib/db/src/runMigrations.ts", import.meta.url), "utf8");

describe("external item request helpers", () => {
  it("builds the twelve fiscal months in chronological order", () => {
    expect(fiscalMonths("2026-27").map((month) => month.ym)).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
      "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
    ]);
    expect(fiscalMonths("2025-27")).toEqual([]);
  });

  it("requires a bounded range inside the requested FY and caps page size", () => {
    const request = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-08",
      limit: "500",
    });
    expect(request.months.map((month) => month.label)).toEqual([
      "Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26",
    ]);
    expect(() =>
      parseExternalRequest({ fy: "2026-27", from: "2025-04", to: "2026-08" }),
    ).toThrow(/within fy/);
    expect(() =>
      parseExternalRequest({ fy: "2026-27", from: "2026-04", to: "2026-08", limit: 501 }),
    ).toThrow(/between 1 and 500/);
  });

  it("round-trips a stable month/code/segment cursor", () => {
    const encoded = encodeCursor({
      month: "Apr-26",
      code: "C51",
      segment: "PTMT",
      query_hash: queryHash("2026-27", "2026-04", "2026-08"),
      source_version: "v1",
      endpoint: "margin",
    });
    expect(decodeCursor(encoded)).toEqual({
      month: "Apr-26",
      code: "C51",
      segment: "PTMT",
      query_hash: queryHash("2026-27", "2026-04", "2026-08"),
      source_version: "v1",
      endpoint: "margin",
    });
  });

  it("keeps the source-unavailable rule endpoint-specific", () => {
    expect(monthUnavailableForMargin("2026-07")).toBe(true);
    expect(monthUnavailableForMargin("2026-06")).toBe(false);
    expect(implementation).toContain("requestedCoverage(request, exclusions, readAt, false)");
    expect(implementation).toContain("requestedCoverage(request, allExclusions, readAt, true)");
    expect(implementation).toContain(".filter((month) => !heldMonths.includes(month.label))");
  });

  it("uses the active authoritative MRP generation and direct normalized code equality", () => {
    expect(implementation).toContain("FROM mrp_synced ms");
    expect(implementation).toContain("JOIN mrp_sync_generation mg");
    expect(implementation).toContain("mg.is_active = TRUE");
    expect(implementation).toContain("upper(btrim(ms.item_code)) AS code");
    expect(implementation).not.toContain("FROM mrp_master");
    expect(implementation).not.toContain("FROM mrp_history");
    expect(implementation).toContain("WITH grouped_sales AS");
    expect(implementation).toContain("LEFT JOIN active_catalogue ac ON ac.code = gs.code");
    expect(implementation).not.toContain("upper(btrim(ms.item_code)) = upper(btrim(sl.code))");
    expect(resolveCatalogueStatus(true, true)).toBe("matched");
    expect(resolveCatalogueStatus(true, false)).toBe("present_unpriced");
    expect(resolveCatalogueStatus(false, false)).toBe("absent");
  });

  it("retains accessory sales and preserves litres for unresolved tanks", () => {
    expect(implementation).not.toContain("WATER TANK LID");
    expect(implementation).not.toContain("NOT LIKE '%LID%'");
    expect(implementation).not.toContain("NOT LIKE '%ACCESS%'");
    expect(implementation).toContain("SUM(COALESCE(sl.qty_ltr, sl.qty))");
    expect(implementation).toContain("AS qty_unresolved");
    expect(implementation).toContain("qty: qtyUnresolved ? null : numeric(row.qty)");
  });

  it("reconciles FY2026-27 Apr-Aug against all requested sales months", () => {
    const request = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-08",
    });
    const coverage = {
      requested: { from: request.from, to: request.to },
      requested_periods: request.months.map((month) => month.label),
      returned: request.months.map((month) => month.label),
      held: [],
      unavailable: [],
      provisional: [],
      read_at: "2026-09-14T09:00:00.000Z",
      reconciliation: P003_RECONCILIATION,
    };
    expect(reconciliation(request, {
      row_count: 135340,
      amount: 1353400568.14,
    }, coverage).status).toBe("match");
  });

  it("merges registered holds with fallback scopes instead of duplicating them", () => {
    expect(implementation).toContain("const registeredRows = holdRowsForCode(dbRows, code).map");
    expect(implementation).toContain("const unmatchedFallbacks = fallbackRows.filter");
    expect(implementation).toContain("uniqueHolds([...registeredRows, ...unmatchedFallbacks])");
  });

  it("aliases live H3 monthly figures and applies it to both endpoints", () => {
    const fyMonths = fiscalMonths("2024-25");
    expect(fyMonths).toHaveLength(12);
    expect(monthlyAttributionPeriodLabels()).toEqual(fyMonths.map((month) => month.label));
    expect(implementation).toContain('resolveExternalHolds(months, "monthly figures", null, "H3")');
    expect(implementation).toContain("const exclusions = await resolveMonthlyAttributionHolds(request.months)");
    expect(implementation).toContain("const h3 = await resolveMonthlyAttributionHolds(request.months)");
    // The resolver receives all twelve FY months, not a representative month.
    expect(implementation).toContain("requestedPeriods: monthLabels(months)");
  });

  it("uses stable H1/H3 codes and maps their fiscal periods exactly", () => {
    const h1 = {
      id: 1,
      code: "H1",
      type: "HOLD" as const,
      title: "PTMT cost",
      scope: "PTMT margin",
      reason: "cost basis",
      fiscalYear: null,
      month: "Jan-Apr 2026",
      scopeProduct: "PTMT",
      scopeMeasure: "margin",
      resolutionUrl: "/settings/resolution/1",
    };
    const h3 = {
      id: 3,
      code: "H3",
      type: "HOLD" as const,
      title: "FY24-25 attribution",
      scope: "monthly figures",
      reason: "attribution",
      fiscalYear: "2024-25",
      month: monthlyAttributionPeriodLabels().join(", "),
      scopeProduct: null,
      scopeMeasure: "monthly figures",
      resolutionUrl: "/settings/resolution/3",
    };
    const fy2526 = fiscalMonths("2025-26");
    const salesHolds = resolveExternalHoldRows({
      measure: "monthly figures",
      requestedPeriods: fy2526.map((month) => month.label),
    }, [h1, h3], "H3");
    const salesCoverage = requestedCoverage(
      { fy: "2025-26", from: "2025-04", to: "2026-03", months: fy2526, limit: 200, cursor: null },
      salesHolds,
      "2026-09-14T09:00:00.000Z",
      false,
    );
    expect(salesCoverage.held).toEqual([]);
    expect(salesCoverage.returned).toEqual(fy2526.map((month) => month.ym));
    expect(reconciliation({ fy: "2025-26", from: "2025-04", to: "2026-03", months: fy2526, limit: 200, cursor: null }, {
      row_count: 145613,
      amount: 3609953808.51,
    }, salesCoverage).status).toBe("match");

    const margin2526 = resolveExternalHoldRows({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: fy2526.map((month) => month.label),
    }, [h1, h3], "H1");
    expect(margin2526[0]?.coverage.heldPeriods).toEqual(["Jan-26", "Feb-26", "Mar-26"]);
    expect(margin2526[0]?.coverage.heldPeriods).not.toContain("Apr-25");
    expect(margin2526[0]?.coverage.heldPeriods).not.toContain("Dec-25");

    const fy2627 = fiscalMonths("2026-27");
    const margin2627 = resolveExternalHoldRows({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: fy2627.map((month) => month.label),
    }, [h1, h3], "H1");
    expect(margin2627[0]?.coverage.heldPeriods).toEqual(["Apr-26"]);

    const fy2425 = fiscalMonths("2024-25");
    const h3Coverage = resolveExternalHoldRows({
      measure: "monthly figures",
      requestedPeriods: fy2425.map((month) => month.label),
    }, [h1, h3], "H3");
    expect(h3Coverage[0]?.coverage.heldPeriods).toEqual(fy2425.map((month) => month.label));
    expect(implementation).toContain('resolveExternalHolds(months, "monthly attribution", null, "H3")');
    expect(implementation).toContain('resolveExternalHolds(request.months, "margin", "PTMT", "H1")');
  });

  it("uses YYYY-MM machine periods while keeping labels in rows", () => {
    const request = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-08",
    });
    const coverage = requestedCoverage(request, [], "2026-09-14T09:00:00.000Z", true);
    expect(coverage.requested_periods).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    expect(coverage.returned).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(coverage.unavailable[0]?.months).toEqual(["2026-07", "2026-08"]);
    expect(coverage.reconciliation).toEqual({
      fy: "2026-27",
      control: 135340056814,
      actual: 135232056020,
      variance: -108000794,
      variance_pct: -0.0008,
      status: "unreconciled",
      reference: "P003",
    });
    expect(coverage.reconciliation).toBe(P003_RECONCILIATION);
  });

  it("uses one binary comparator across numeric and punctuation cursors", () => {
    const request = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-04",
      limit: 1,
    });
    const rows = [
      { month_label: "Apr-26", code: "2" },
      { month_label: "Apr-26", code: "10" },
      { month_label: "Apr-26", code: "A-2" },
    ];
    expect(applyCursor(rows, request).map((row) => row.code)).toEqual(["10", "2", "A-2"]);
    const nextRequest = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-04",
      limit: 1,
      cursor: encodeCursor({
        month: "Apr-26",
        code: "10",
        query_hash: queryHash("2026-27", "2026-04", "2026-04"),
        source_version: "v1",
        endpoint: "sales",
      }),
    });
    expect(applyCursor(rows, nextRequest).map((row) => row.code)).toEqual(["2", "A-2"]);
    expect(implementation).toContain('COLLATE "C"');
    expect(implementation).toContain("array_position($3::text[],");
    expect(implementation).toContain("request.limit + 1");
    expect(implementation).toContain("LIMIT $6");
    expect(implementation).toContain("LIMIT $8");
    expect(implementation).toContain("salesRangeTotalsCache");
    expect(implementation).toContain("queryHash(request.fy, request.from, request.to)}:${sourceVersion}");
    expect(implementation).toContain("sourceVersion");
  });

  it("raises a typed source conflict when the paging version changes", () => {
    const request = parseExternalRequest({
      fy: "2026-27",
      from: "2026-04",
      to: "2026-04",
      cursor: encodeCursor({
        month: "Apr-26",
        code: "10",
        query_hash: queryHash("2026-27", "2026-04", "2026-04"),
        source_version: "old",
        endpoint: "sales",
      }),
    });
    expect(() => checkCursor(request, "new", "sales")).toThrow(ExternalSourceChangedError);
  });

  it("fails closed before emitting a page when any full source revision changes", () => {
    const stable = {
      sourceVersion: "row|hold|mrp",
      dataSource: "neondb" as const,
      lastModified: {},
    };
    for (const changed of [
      "balanced-row-edit",
      "row|hold-revision|mrp",
      "row|hold|mrp-generation-revision",
    ]) {
      expect(() => ensureSourceStable(stable, {
        sourceVersion: changed,
        dataSource: "neondb",
        lastModified: {},
      })).toThrow(ExternalSourceChangedError);
    }
    expect(implementation).not.toContain("to_jsonb(sl)::text");
    expect(implementation).not.toContain("to_jsonb(mf)::text");
    expect(implementation).not.toContain("string_agg(to_jsonb");
    expect(implementation).toContain("LEFT JOIN external_source_revision revision");
    expect(implementation).toContain("COALESCE(revision.revision, 0)::text AS revision");
    expect(implementation).toContain("MAX(sl.ingested_at)::text");
    expect(implementation).toContain("MAX(mf.loaded_at)::text");
    expect(implementation).toContain("HOLD_DIGEST");
    expect(implementation).toContain("FROM resolution_item ri");
    expect(implementation).toContain("FROM mrp_sync_generation mg");
    expect(implementation).toContain("ensureSourceStable(metadata, await salesSourceMetadata(request))");
    expect(implementation).toContain("ensureSourceStable(metadata, await marginSourceMetadata(request))");
  });

  it("requires an authoritative validated database provenance", () => {
    expect(dataSourceFromDatabaseName("neondb")).toBe("neondb");
    expect(dataSourceFromDatabaseName("heliumdb")).toBe("heliumdb");
    expect(() => dataSourceFromDatabaseName("unknown_db")).toThrow(/provenance/i);
    expect(implementation).toContain("SELECT current_database()");
    expect(implementation).not.toContain("DATABASE_URL");
    expect(implementation).not.toContain("HELIUMDB_URL");
  });

  it("never serializes exception details in public 503 responses", () => {
    const route = readFileSync(new URL("../routes/external.ts", import.meta.url), "utf8");
    expect(route).toContain('res.status(503).json({ error: "External source unavailable" })');
    expect(route).not.toContain('detail: message');
    expect(route).toContain('res.status(409).json({ error: "source_changed", restart_required: true })');
  });

  it("guards the durable statement-level source revision migration", () => {
    expect(migrations).toContain('id: "108_external_source_revision"');
    expect(migrations).toContain("CREATE TABLE IF NOT EXISTS external_source_revision");
    expect(migrations).toContain("AFTER INSERT ON sale_line_all");
    expect(migrations).toContain("AFTER UPDATE ON sale_line_all");
    expect(migrations).toContain("AFTER DELETE ON sale_line_all");
    expect(migrations).toContain("AFTER INSERT ON margin_fact");
    expect(migrations).toContain("AFTER UPDATE ON margin_fact");
    expect(migrations).toContain("AFTER DELETE ON margin_fact");
    expect(migrations).toContain("SELECT fy, month_label FROM old_rows");
    expect(migrations).toContain("SELECT fy, month_label FROM new_rows");
    expect(migrations).toContain("FOR EACH STATEMENT");
    expect(migrations).toContain("revision = external_source_revision.revision + 1");
    expect(migrations).toContain("ON CONFLICT (source, fy, month_label) DO NOTHING");
  });

  it("checks the sales page and totals before caching or constructing response data", () => {
    const pageQuery = implementation.indexOf("LIMIT $6");
    const totalsRead = implementation.indexOf("readSalesRangeTotals(request, available, sourceVersion)");
    const finalCheck = implementation.indexOf("ensureSourceStable(metadata, await salesSourceMetadata(request))", totalsRead);
    const cacheWrite = implementation.indexOf("cacheSalesRangeTotals(rangeTotalsRead)", finalCheck);
    expect(pageQuery).toBeGreaterThanOrEqual(0);
    expect(totalsRead).toBeGreaterThan(pageQuery);
    expect(finalCheck).toBeGreaterThan(totalsRead);
    expect(cacheWrite).toBeGreaterThan(finalCheck);
  });
});
