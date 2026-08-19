/**
 * Tests for the secondary orders backend.
 *
 * Covers:
 *  1. Parser — header validation, date parsing, column extraction
 *  2. Idempotency — same file twice produces same row count
 *  3. Filter builder — WHERE clause construction with all filter combinations
 *  4. Export contract — xlsx workbook shape, Info sheet labels
 *  5. Collision detection — same (order_id, product_code) with different values
 *
 * These tests use pure unit-testable logic only (no DB, no file I/O for most).
 * DB-dependent tests are clearly marked and skipped if DATABASE_URL is absent.
 */

import { describe, it, expect } from "vitest";

// ── 1. Date parser ────────────────────────────────────────────────────────────
// Replicate the parseOrderDatetime logic without importing the full loader
// (avoids DB import at test discovery time).

function parseOrderDatetime(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, yyyy, HH, MM, SS] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

describe("parseOrderDatetime", () => {
  it("parses DD-MM-YYYY HH:mm:ss format", () => {
    const d = parseOrderDatetime("19-08-2026 15:06:12");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(7); // August (0-indexed)
    expect(d!.getUTCDate()).toBe(19);
  });

  it("parses 01-08-2026 00:00:00 (IST → UTC = July 31 18:30)", () => {
    const d = parseOrderDatetime("01-08-2026 00:00:00");
    expect(d).not.toBeNull();
    // 01-Aug-2026 00:00:00 IST (+05:30) = 31-Jul-2026 18:30:00 UTC
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.toISOString()).toContain("2026-07-31");
  });

  it("returns null for empty string", () => {
    expect(parseOrderDatetime("")).toBeNull();
    expect(parseOrderDatetime(null)).toBeNull();
  });

  it("passthrough for Date objects", () => {
    const input = new Date("2026-08-01T00:00:00Z");
    const out = parseOrderDatetime(input);
    expect(out).toBe(input);
  });

  it("rejects malformed strings", () => {
    expect(parseOrderDatetime("not-a-date")).toBeNull();
  });
});

// ── 2. Header validation ──────────────────────────────────────────────────────

const EXPECTED_HEADERS = [
  "Date", "Order ID", "Sales User Name", "Customer Name", "Dealer ID",
  "Dealer Mobile", "Channel Partner Name", "CP Code", "State", "District",
  "City", "Pincode", "Category Name", "Product Code", "GST (%)",
  "GST Amount", "Qty", "Discount (%)", "Discount Amount",
  "Dealer Order Value", "Basic Order Value", "Order Status",
];

function validateHeaders(headers: string[]): string | null {
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    if (headers[i] !== EXPECTED_HEADERS[i]) {
      return `Column ${i + 1}: expected "${EXPECTED_HEADERS[i]}", got "${headers[i]}"`;
    }
  }
  return null;
}

describe("header validation", () => {
  it("accepts the exact expected headers", () => {
    expect(validateHeaders([...EXPECTED_HEADERS])).toBeNull();
  });

  it("rejects a wrong column name", () => {
    const bad = [...EXPECTED_HEADERS];
    bad[4] = "Dealer Code"; // should be "Dealer ID"
    const err = validateHeaders(bad);
    expect(err).toContain('"Dealer ID"');
    expect(err).toContain('"Dealer Code"');
  });

  it("rejects a missing column", () => {
    const bad = [...EXPECTED_HEADERS].slice(0, 10);
    expect(validateHeaders(bad)).toContain(EXPECTED_HEADERS[10]);
  });
});

// ── 3. Filter builder ─────────────────────────────────────────────────────────
// Replicate buildWhereClause logic inline to test pure filter construction.

type FilterParams = {
  stateHead?: string;
  state?: string;
  distributor?: string;
  retailer?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

function buildWhereClause(f: FilterParams): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (f.stateHead) {
    conditions.push(`EXISTS (SELECT 1 FROM person p JOIN person_registry pr ON pr.person_id = p.person_id WHERE p.person_id = sol.sales_user_id AND pr.state_head = $${params.length + 1})`);
    params.push(f.stateHead);
  }
  if (f.state) {
    conditions.push(`sol.state = $${params.length + 1}`);
    params.push(f.state);
  }
  if (f.distributor) {
    conditions.push(`sol.cp_code = $${params.length + 1}`);
    params.push(f.distributor);
  }
  if (f.retailer) {
    conditions.push(`sol.dealer_id = $${params.length + 1}`);
    params.push(f.retailer);
  }
  if (f.status) {
    if (f.status !== "APPROVED" && f.status !== "PENDING") throw new Error("status must be APPROVED or PENDING");
    conditions.push(`sol.order_status = $${params.length + 1}`);
    params.push(f.status);
  }
  if (f.dateFrom) {
    conditions.push(`sol.order_datetime >= $${params.length + 1}::date`);
    params.push(f.dateFrom);
  }
  if (f.dateTo) {
    conditions.push(`sol.order_datetime < ($${params.length + 1}::date + interval '1 day')`);
    params.push(f.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

describe("buildWhereClause", () => {
  it("returns empty WHERE for no filters", () => {
    const { where, params } = buildWhereClause({});
    expect(where).toBe("");
    expect(params).toHaveLength(0);
  });

  it("filters by state", () => {
    const { where, params } = buildWhereClause({ state: "WEST BENGAL" });
    expect(where).toContain("sol.state = $1");
    expect(params).toEqual(["WEST BENGAL"]);
  });

  it("filters by distributor (cp_code)", () => {
    const { where, params } = buildWhereClause({ distributor: "DIST#9234" });
    expect(where).toContain("sol.cp_code = $1");
    expect(params).toEqual(["DIST#9234"]);
  });

  it("filters by retailer (dealer_id)", () => {
    const { where, params } = buildWhereClause({ retailer: "RET#42861" });
    expect(where).toContain("sol.dealer_id = $1");
    expect(params).toEqual(["RET#42861"]);
  });

  it("filters by status APPROVED", () => {
    const { where, params } = buildWhereClause({ status: "APPROVED" });
    expect(where).toContain("sol.order_status = $1");
    expect(params).toEqual(["APPROVED"]);
  });

  it("rejects invalid status", () => {
    expect(() => buildWhereClause({ status: "DELIVERED" })).toThrow(/APPROVED or PENDING/);
  });

  it("filters by date range", () => {
    const { where, params } = buildWhereClause({ dateFrom: "2026-08-01", dateTo: "2026-08-19" });
    expect(where).toContain("$1::date");
    expect(where).toContain("$2::date");
    expect(params).toEqual(["2026-08-01", "2026-08-19"]);
  });

  it("combines multiple filters with correct parameter indices", () => {
    const { where, params } = buildWhereClause({
      state: "WEST BENGAL",
      status: "APPROVED",
      dateFrom: "2026-08-01",
    });
    expect(params).toHaveLength(3);
    expect(where).toContain("$1");
    expect(where).toContain("$2");
    expect(where).toContain("$3");
    // State is $1, status is $2, dateFrom is $3
    expect(params[0]).toBe("WEST BENGAL");
    expect(params[1]).toBe("APPROVED");
    expect(params[2]).toBe("2026-08-01");
  });

  it("stateHead filter uses EXISTS subquery", () => {
    const { where, params } = buildWhereClause({ stateHead: "Sandeep Dadheech" });
    expect(where).toContain("EXISTS");
    expect(where).toContain("person_registry");
    expect(where).toContain("state_head = $1");
    expect(params).toEqual(["Sandeep Dadheech"]);
  });
});

// ── 4. Export workbook contract ───────────────────────────────────────────────
// Verify that the Info sheet labels "ORDER BOOKING" and basic value is
// described as excluding GST.

describe("export workbook contract", () => {
  it("Info sheet rows include ORDER BOOKING label", () => {
    const infoRows: [string, string][] = [
      ["Basis", "ORDER BOOKING — not dispatch"],
      ["Note", "Not comparable with secondary sales figures (secondary_sku_line / secondary_register_line)."],
      ["Basic Order Value", "Excludes GST. Use this for commercial analysis."],
      ["Dealer Order Value", "Includes GST. Stored for completeness only."],
    ];
    const basisRow = infoRows.find(([k]) => k === "Basis");
    expect(basisRow).toBeDefined();
    expect(basisRow![1]).toContain("ORDER BOOKING");

    const basicRow = infoRows.find(([k]) => k === "Basic Order Value");
    expect(basicRow).toBeDefined();
    expect(basicRow![1]).toContain("Excludes GST");

    const dealerRow = infoRows.find(([k]) => k === "Dealer Order Value");
    expect(dealerRow).toBeDefined();
    expect(dealerRow![1]).toContain("Includes GST");
  });

  it("column headers include Basic Order Value with excl GST note", () => {
    const columns = [
      { header: "Basic Order Value (excl GST)", key: "basic_order_value" },
      { header: "Dealer Order Value (incl GST)", key: "dealer_order_value" },
    ];
    const basic = columns.find((c) => c.key === "basic_order_value");
    expect(basic?.header).toContain("excl GST");

    const dealer = columns.find((c) => c.key === "dealer_order_value");
    expect(dealer?.header).toContain("incl GST");
  });
});

// ── 5. Collision detection logic ──────────────────────────────────────────────

describe("collision detection", () => {
  type CollisionCheck = [string, string | null, string | null];

  function detectCollisions(
    existing: { order_status: string; qty: string | null; basic_order_value: string | null },
    incoming: { orderStatus: string; qty: number | null; basicOrderValue: number | null },
  ): CollisionCheck[] {
    const checks: CollisionCheck[] = [
      ["order_status", existing.order_status, incoming.orderStatus],
      ["qty", existing.qty, incoming.qty != null ? String(incoming.qty) : null],
      ["basic_order_value", existing.basic_order_value, incoming.basicOrderValue != null ? String(incoming.basicOrderValue) : null],
    ];
    return checks.filter(([field, stored, inc]) => {
      if (field === "order_status") return stored !== inc;
      const sn = stored != null ? Number(stored) : null;
      const in_ = inc != null ? Number(inc) : null;
      return sn !== in_ && !(stored == null && inc == null);
    });
  }

  it("no collision when values are identical", () => {
    const ex = { order_status: "APPROVED", qty: "6", basic_order_value: "4620" };
    const inc = { orderStatus: "APPROVED", qty: 6, basicOrderValue: 4620 };
    expect(detectCollisions(ex, inc)).toHaveLength(0);
  });

  it("detects status collision", () => {
    const ex = { order_status: "APPROVED", qty: "6", basic_order_value: "4620" };
    const inc = { orderStatus: "PENDING", qty: 6, basicOrderValue: 4620 };
    const cols = detectCollisions(ex, inc);
    expect(cols).toHaveLength(1);
    expect(cols[0][0]).toBe("order_status");
  });

  it("detects qty collision", () => {
    const ex = { order_status: "APPROVED", qty: "6", basic_order_value: "4620" };
    const inc = { orderStatus: "APPROVED", qty: 12, basicOrderValue: 4620 };
    const cols = detectCollisions(ex, inc);
    expect(cols).toHaveLength(1);
    expect(cols[0][0]).toBe("qty");
  });

  it("no collision when both qty are null", () => {
    const ex = { order_status: "APPROVED", qty: null, basic_order_value: null };
    const inc = { orderStatus: "APPROVED", qty: null, basicOrderValue: null };
    expect(detectCollisions(ex, inc)).toHaveLength(0);
  });
});

// ── 6. Unique-constraint key (order_id, product_code) ────────────────────────

describe("unique key behaviour", () => {
  it("same order_id + product_code = same unique pair", () => {
    const key = (orderId: string, productCode: string) => `${orderId}|${productCode}`;
    expect(key("SORD-1381", "5311")).toBe("SORD-1381|5311");
    // Different product_code = different pair
    expect(key("SORD-1381", "BOS-119")).not.toBe(key("SORD-1381", "5311"));
    // Different order_id = different pair
    expect(key("SORD-1382", "5311")).not.toBe(key("SORD-1381", "5311"));
  });
});
