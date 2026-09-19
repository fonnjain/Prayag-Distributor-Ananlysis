import { describe, expect, it } from "vitest";
import {
  assertGenericProductWiseOrderMonth,
  indiaMonthLabel,
  productWiseOrderMonthPlan,
} from "./monthReplacement.js";
import {
  APPROVED_PRODUCT_WISE_MANIFESTS,
  resolveApprovedProductWiseManifest,
} from "./approvedManifests.js";
import { assertManifestReplacementAllowed } from "./loader.js";

const row = (orderId: string, occurrence = 1) => ({ orderId, productCode: "100", occurrence });

describe("Product-Wise order month replacement", () => {
  it("resolves only versioned approved workbook manifests", () => {
    const manifest = resolveApprovedProductWiseManifest(APPROVED_PRODUCT_WISE_MANIFESTS[0]!.sourceSha256);
    expect(manifest).toMatchObject({ version: "sep26-partial-v1", month: "Sep-26", completeness: "partial" });
    expect(() => resolveApprovedProductWiseManifest("0".repeat(64))).toThrow(/No approved/);
  });

  it("enforces monotonic manifest cutoffs and protects complete periods", () => {
    const base = {
      incomingCutoff: new Date("2026-09-17T18:16:26Z"),
      incomingCompleteness: "partial" as const,
      incomingManifestId: "sep26-partial-v1",
      incomingSha256: "a".repeat(64),
      existingMaxOrderDatetime: new Date("2026-09-18T00:00:00Z"),
      existingCompleteness: ["partial"],
      existingManifestIds: ["older"],
      existingManifestShas: ["b".repeat(64)],
    };
    expect(() => assertManifestReplacementAllowed(base)).toThrow(/monotonic/);
    expect(() => assertManifestReplacementAllowed({
      ...base, incomingCutoff: new Date("2026-09-19T00:00:00Z"),
      existingCompleteness: ["complete"],
    })).toThrow(/complete/);
    expect(() => assertManifestReplacementAllowed({
      ...base, existingManifestIds: ["sep26-partial-v1"],
      existingManifestShas: ["a".repeat(64)],
    })).not.toThrow();
  });

  it("derives Sep-26 from 1 September 00:00:26 IST, not UTC", () => {
    expect(indiaMonthLabel(new Date("2026-08-31T18:30:26.000Z"))).toBe("Sep-26");
  });

  it("plans a partial-to-full replacement by stable occurrence identity", () => {
    const plan = productWiseOrderMonthPlan({
      month: "Sep-26",
      existing: [row("SORD-1")],
      incoming: [row("SORD-1"), row("SORD-2")],
      now: new Date("2026-09-20T12:00:00Z"),
    });
    expect(plan.action).toBe("replace");
    expect(plan.removeKeys).toEqual([]);
    expect(plan.insertKeys).toEqual(["SORD-2\u0000100\u00001"]);
    expect(plan.unchangedKeys).toEqual(["SORD-1\u0000100\u00001"]);
  });

  it("plans the same file as idempotent with no removals or inserts", () => {
    const rows = [row("SORD-1"), row("SORD-2", 2)];
    const plan = productWiseOrderMonthPlan({
      month: "Sep-26", existing: rows, incoming: rows,
      now: new Date("2026-09-20T12:00:00Z"),
    });
    expect(plan).toMatchObject({ action: "replace", removeKeys: [], insertKeys: [] });
    expect(plan.unchangedKeys).toHaveLength(2);
  });

  it("removes rows absent from a later replacement file", () => {
    const plan = productWiseOrderMonthPlan({
      month: "Sep-26",
      existing: [row("SORD-1"), row("SORD-2")],
      incoming: [row("SORD-1")],
      now: new Date("2026-09-20T12:00:00Z"),
    });
    expect(plan.removeKeys).toEqual(["SORD-2\u0000100\u00001"]);
  });

  it("protects August from the generic order-table path", () => {
    expect(() => assertGenericProductWiseOrderMonth("Aug-26")).toThrow(/protected/);
    expect(productWiseOrderMonthPlan({
      month: "Aug-26", existing: [row("SORD-1")], incoming: [row("SORD-2")],
      now: new Date("2026-09-01T00:00:00Z"),
    }).action).toBe("protected");
  });

  it("freezes September replacement at 1 January 2027 00:00 IST", () => {
    const before = productWiseOrderMonthPlan({
      month: "Sep-26", existing: [], incoming: [row("SORD-1")],
      now: new Date("2026-12-31T18:29:59.999Z"),
    });
    expect(before.action).toBe("replace");
    const atFreeze = productWiseOrderMonthPlan({
      month: "Sep-26", existing: [], incoming: [row("SORD-1")],
      now: new Date("2026-12-31T18:30:00.000Z"),
    });
    expect(atFreeze.action).toBe("frozen");
    expect(atFreeze.freezeAt).toEqual(new Date("2026-12-31T18:30:00.000Z"));
  });
});