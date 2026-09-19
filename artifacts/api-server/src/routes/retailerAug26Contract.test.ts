import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(new URL("./sku.ts", import.meta.url), "utf8");
const routeStart = routeSource.indexOf('router.get("/sku/retailer-aug26"');
const routeEnd = routeSource.indexOf("\n});", routeStart);
const endpointSource = routeSource.slice(routeStart, routeEnd);

describe("retailer-aug26 source-line contract", () => {
  it("does not collapse differing prices into MAX/MIN or SUM aggregates", () => {
    expect(endpointSource).toContain("SELECT id, order_id, order_datetime::text AS order_datetime");
    expect(endpointSource).toContain("qty::float8 AS qty, basic_order_value::float8 AS basic_order_value");
    expect(endpointSource).toContain("discount_pct::float8 AS discount_pct");
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
});