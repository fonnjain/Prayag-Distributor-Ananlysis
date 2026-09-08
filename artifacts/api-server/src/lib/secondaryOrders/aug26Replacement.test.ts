import { describe, expect, it } from "vitest";
import {
  AUG26_HEADERS,
  EXPECTED_CONTROLS,
  EXPECTED_REMOVED_LINES,
  assertExpectedControls,
  assertRemovalConfirmations,
  buildAug26HeaderIndex,
  parseAug26Replacement,
  protectedFingerprintsEqual,
  resolveFingerprintEntries,
} from "./aug26Replacement.js";

describe("Prompt 67 August replacement guards", () => {
  it("accepts the 25 required headers by name even when reordered", () => {
    const reordered = [...AUG26_HEADERS].reverse();
    const index = buildAug26HeaderIndex(reordered);
    expect(index.get("Order ID")).toBe(reordered.indexOf("Order ID") + 1);
    expect(index.get("Reporting Manager")).toBe(reordered.indexOf("Reporting Manager") + 1);
  });

  it("rejects missing or duplicate headers", () => {
    expect(() => buildAug26HeaderIndex(AUG26_HEADERS.slice(1))).toThrow(/25 unique/);
    expect(() => buildAug26HeaderIndex(AUG26_HEADERS.map((header) =>
      header === "GST Type" ? "GST (%)" : header,
    ))).toThrow(/25 unique/);
  });

  it("rejects any control drift, including the two SORD blocks", () => {
    expect(() => assertExpectedControls(EXPECTED_CONTROLS)).not.toThrow();
    expect(() => assertExpectedControls({ ...EXPECTED_CONTROLS, highOrders: 1555 }))
      .toThrow(/highOrders/);
  });

  it("requires the exact six source removals and explicit confirmations", () => {
    const confirmations = EXPECTED_REMOVED_LINES.map((line) => ({ ...line, confirmed: true as const }));
    expect(() => assertRemovalConfirmations(EXPECTED_REMOVED_LINES, confirmations)).not.toThrow();
    expect(() => assertRemovalConfirmations(EXPECTED_REMOVED_LINES, confirmations.slice(1)))
      .toThrow(/six removed lines/);
    expect(() => assertRemovalConfirmations(EXPECTED_REMOVED_LINES.slice(1), confirmations))
      .toThrow(/six lines confirmed/);
  });

  it("rejects workbook bytes that do not have the approved SHA before parsing", async () => {
    await expect(parseAug26Replacement(Buffer.from("not the approved workbook")))
      .rejects.toThrow(/SHA-256/);
  });

  it("resolves fingerprint promises and compares JSONB-reordered keys safely", async () => {
    const resolved = await resolveFingerprintEntries([
      ["orders", Promise.resolve("orders-sha")],
      ["sales", Promise.resolve("sales-sha")],
    ]);
    expect(resolved).toEqual({ orders: "orders-sha", sales: "sales-sha" });
    const jsonbOrder = JSON.parse('{"sales":"sales-sha","orders":"orders-sha"}');
    expect(protectedFingerprintsEqual(resolved, jsonbOrder)).toBe(true);
    expect(protectedFingerprintsEqual(resolved, { ...jsonbOrder, sales: "changed" })).toBe(false);
  });
});