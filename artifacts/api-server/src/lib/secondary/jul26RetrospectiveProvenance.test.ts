import { describe, expect, it } from "vitest";
import {
  assertJulyRetrospectiveInput,
  assertJulyTotals,
  JUL26_RETROSPECTIVE_PROVENANCE,
} from "./jul26RetrospectiveProvenance.js";

describe("July retrospective provenance controls", () => {
  it("accepts only the exact existing July row and NET anchors", () => {
    const totals = { rows: 34_147, net: 223_436_806 };
    expect(() => assertJulyTotals(totals, totals)).not.toThrow();
    expect(() =>
      assertJulyTotals(totals, { rows: 34_146, net: 223_436_806 }),
    ).toThrow("metadata repair refused");
  });

  it("requires a real timestamp on the original 24 August load date", () => {
    expect(() =>
      assertJulyRetrospectiveInput({
        originalLoadedAt: "2026-08-24T08:30:00.000Z",
        recordedBy: "reviewer",
        sourceNote: "Original controls independently verified.",
      }),
    ).not.toThrow();
    expect(() =>
      assertJulyRetrospectiveInput({
        originalLoadedAt: "August 24, 2026 08:30 UTC",
        recordedBy: "reviewer",
        sourceNote: "Original controls independently verified.",
      }),
    ).toThrow("strict ISO");
    expect(() =>
      assertJulyRetrospectiveInput({
        originalLoadedAt: "2026-09-17T08:30:00.000Z",
        recordedBy: "reviewer",
        sourceNote: "Original controls independently verified.",
      }),
    ).toThrow("24 August 2026");
  });

  it("keeps commit disabled until review pins the exact original time", () => {
    expect(() =>
      assertJulyRetrospectiveInput(
        {
          originalLoadedAt: "2026-08-24T08:30:00.000Z",
          recordedBy: "reviewer",
          sourceNote: "Original controls independently verified.",
        },
        true,
      ),
    ).toThrow("commit is disabled");
  });

  it("pins the original archive and complete controls", () => {
    expect(JUL26_RETROSPECTIVE_PROVENANCE).toMatchObject({
      sourceFile:
        "PSCode_3_NEW_REPORTS_JULY2026-20260805T074609Z-1-001_1785917168364.zip",
      archiveSha256:
        "d9030146be8c34be9cfcb16c5f6930e5778e9cdfac0b96e93b95628a42f4e161",
      expected: {
        filesFound: 163,
        filesDropped: 14,
        filesLoading: 149,
        rows: 34_147,
        net: 223_436_806,
        discountPct: 49.48602677720013,
        months: ["Jul-26"],
      },
    });
  });
});