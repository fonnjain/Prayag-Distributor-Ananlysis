import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(new URL("./sku.ts", import.meta.url), "utf8");
const routeStart = routeSource.indexOf("async function retailerProductWiseMonth");
const routeEnd = routeSource.indexOf('\nrouter.get("/sku/retailer-productwise"', routeStart);
const endpointSource = routeSource.slice(routeStart, routeEnd);

describe("Product-Wise retailer month source-line contract", () => {
  it("does not collapse differing prices into MAX/MIN or SUM aggregates", () => {
    expect(endpointSource).toContain("SELECT id, order_id, order_datetime::text AS order_datetime");
    expect(endpointSource).toContain("qty::float8 AS qty, basic_order_value::float8 AS basic_order_value");
    expect(endpointSource).toContain("discount_pct::float8 AS discount_pct");
    expect(endpointSource).toContain("order_datetime >= ${period.start}::timestamptz");
    expect(endpointSource).toContain("order_datetime <  ${period.end}::timestamptz");
    expect(endpointSource).not.toContain("SUM(qty)");
    expect(endpointSource).not.toContain("SUM(basic_order_value)");
    expect(endpointSource).not.toContain("MAX(discount_pct)");
    expect(endpointSource).not.toContain("MIN(order_datetime)");
    expect(endpointSource).not.toContain("GROUP BY dealer_id, customer_name, product_code");
  });

  it("keeps pagination count independent of the requested page", () => {
    expect(endpointSource).toContain("SELECT COUNT(*)::int AS total");
    expect(endpointSource).toContain("pagination: { limit, offset, total, hasMore:");
  });

  it("supports both August and September while retaining the August alias", () => {
    expect(routeSource).toContain('router.get("/sku/retailer-productwise"');
    expect(routeSource).toContain('router.get("/sku/retailer-aug26"');
    expect(routeSource).toContain('"Aug-26"');
    expect(routeSource).toContain('"Sep-26"');
    expect(endpointSource).toContain("monthStart: period.start");
    expect(endpointSource).toContain("monthEndExclusive: period.end");
    expect(endpointSource).toContain("completeness:");
    expect(endpointSource).toContain("cutoff:");
  });
});