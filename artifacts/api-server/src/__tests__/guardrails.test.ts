// Unit tests for spec Task 8 ingestion guardrails (pure functions, no DB).
import { describe, it, expect } from "vitest";
import {
  assertSumConsistency,
  assertNoNegativeAmounts,
} from "../lib/registers/ingest.js";

type Canon = string | null;

const line = (
  amount: string,
  groupCanon: Canon = "AGARBATTI",
  headCanon: Canon = "SANDEEP JI",
  stateCanon: Canon = "UTTAR PRADESH",
  raws: { groupRaw?: Canon; headRaw?: Canon; stateRaw?: Canon } = {},
) => ({
  amount,
  groupCanon,
  headCanon,
  stateCanon,
  groupRaw: raws.groupRaw !== undefined ? raws.groupRaw : groupCanon,
  headRaw: raws.headRaw !== undefined ? raws.headRaw : headCanon,
  stateRaw: raws.stateRaw !== undefined ? raws.stateRaw : stateCanon,
});

describe("assertSumConsistency", () => {
  it("passes when every row lands in a bucket per dimension", () => {
    const [a] = assertSumConsistency([
      line("100.50"),
      line("200.25", "DHOOP", "RAHUL JI", "BIHAR"),
      line("299.25"),
    ]);
    expect(a.passed).toBe(true);
    expect(a.detail).toContain("grand=600");
    expect(a.detail).toContain("(2 buckets)");
  });

  it("fails when normalization dropped a group despite a raw value", () => {
    const [a] = assertSumConsistency([
      line("100"),
      line("50", null, "SANDEEP JI", "BIHAR", { groupRaw: "MYSTERY GROUP" }),
    ]);
    expect(a.passed).toBe(false);
    expect(a.detail).toContain("1 rows lost group_canon despite raw value");
  });

  it("fails when head or state canon was dropped despite a raw value", () => {
    const [head] = assertSumConsistency([
      line("10", "AGARBATTI", null, "BIHAR", { headRaw: "UNKNOWN HEAD" }),
    ]);
    expect(head.passed).toBe(false);
    expect(head.detail).toContain("lost head_canon");

    const [state] = assertSumConsistency([
      line("10", "AGARBATTI", "SANDEEP JI", null, { stateRaw: "??" }),
    ]);
    expect(state.passed).toBe(false);
    expect(state.detail).toContain("lost state_canon");
  });

  it("passes rows whose source cells were genuinely blank, bucketing them separately", () => {
    const [a] = assertSumConsistency([
      line("100"),
      line("50", "AGARBATTI", null, null, { headRaw: null, stateRaw: "" }),
    ]);
    expect(a.passed).toBe(true);
    expect(a.detail).toContain("source blanks:");
    expect(a.detail).toContain("head blank=50");
    expect(a.detail).toContain("state blank=50");
  });

  it("fails on non-numeric amounts", () => {
    const [a] = assertSumConsistency([line("100"), line("not-a-number")]);
    expect(a.passed).toBe(false);
    expect(a.detail).toContain("1 rows with non-numeric amount");
  });

  it("passes an empty batch (grand and buckets all zero)", () => {
    const [a] = assertSumConsistency([]);
    expect(a.passed).toBe(true);
  });
});

describe("assertNoNegativeAmounts", () => {
  it("passes when all amounts are non-negative", () => {
    const [a] = assertNoNegativeAmounts([
      { amount: "0", invoiceNo: "INV-1", code: "C1" },
      { amount: "150.75", invoiceNo: null, code: "C2" },
    ]);
    expect(a.passed).toBe(true);
    expect(a.detail).toBe("none");
  });

  it("fails and samples offending lines when negatives exist", () => {
    const [a] = assertNoNegativeAmounts([
      { amount: "100", invoiceNo: "INV-1", code: "C1" },
      { amount: "-5", invoiceNo: "INV-2", code: "C2" },
      { amount: "-1.25", invoiceNo: null, code: "C3" },
    ]);
    expect(a.passed).toBe(false);
    expect(a.detail).toContain("2 negative amounts");
    expect(a.detail).toContain("INV-2/C2: -5");
    expect(a.detail).toContain("?/C3: -1.25");
  });
});
