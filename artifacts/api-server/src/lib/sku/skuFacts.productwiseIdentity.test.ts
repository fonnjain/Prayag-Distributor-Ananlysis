import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Product-Wise SKU identity and seam guards", () => {
  const source = readFileSync(new URL("./skuFacts.ts", import.meta.url), "utf8");

  it("uses RET# dealer identity for Product-Wise customer scopes", () => {
    expect(source).toContain("UPPER(BTRIM(sol.dealer_id)) = UPPER(BTRIM(${scopeId}))");
    expect(source).not.toContain("sol.customer_name = ${scopeId}");
  });

  it("does not put Product-Wise ex-GST value into the shared trend net series", () => {
    expect(source).toContain("net: null");
    expect(source).toContain("Rupees are not comparable with PSCode3 across the permanent source seam");
  });
});