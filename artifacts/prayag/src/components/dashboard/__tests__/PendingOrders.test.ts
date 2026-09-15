import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HeadSection,
  SourceOnlyHeadSection,
  type PendingHead,
} from "../PendingOrders";

const ZERO_COVERAGE_HEADS = [
  "GEM",
  "GOVT",
  "OTHER",
  "PAWAN KUMAR",
  "PROJECT",
];

function zeroCoverageHead(head: string): PendingHead {
  return {
    head,
    total: 100,
    parties: [{
      party: `${head} PARTY`,
      total: 100,
      byGroup: { "GARDEN PIPE": 100 },
      classification: "None",
      reconciliation: {
        parent: 100,
        children: 100,
        difference: 0,
        exact: true,
      },
    }],
    buckets: [{
      bucket: "Unassigned",
      total: 100,
      parties: [],
      reconciliation: {
        parent: 100,
        children: 100,
        difference: 0,
        exact: true,
      },
    }],
    coverage: {
      candidateCoveragePct: 0,
      safeCoveragePct: 0,
      conflictCostPp: 0,
      candidateQty: 0,
      safeQty: 0,
      conflictQty: 0,
      unassignedQty: 100,
      disputedQty: 0,
    },
    reconciliation: {
      parent: 100,
      children: 100,
      difference: 0,
      exact: true,
    },
  };
}

describe("Pending Orders zero-coverage heads", () => {
  it.each(ZERO_COVERAGE_HEADS)(
    "renders %s as a known attribution gap, not an error",
    (headName) => {
      const html = renderToStaticMarkup(
        createElement(HeadSection, {
          head: zeroCoverageHead(headName),
          groups: ["GARDEN PIPE"],
          defaultOpen: false,
        }),
      );

      expect(html).toContain(headName);
      expect(html).toContain(
        "0.00% has exactly one assignment candidate; 0.00% safely mapped after conflict holds.",
      );
      expect(html).toContain(
        "Known attribution gap — pending quantity is retained below, not missing.",
      );
      expect(html).not.toContain("Mismatch:");
      expect(html).not.toContain("Could not apply attribution");
    },
  );

  it("renders unavailable attribution as source-only data without zero-coverage claims", () => {
    const head = zeroCoverageHead("SOURCE HEAD");
    const html = renderToStaticMarkup(
      createElement(SourceOnlyHeadSection, {
        head,
        groups: ["GARDEN PIPE"],
      }),
    );

    expect(html).toContain("SOURCE HEAD");
    expect(html).toContain("Attribution unavailable — source parties and quantities only.");
    expect(html).not.toContain("0.00% has exactly one assignment candidate");
    expect(html).not.toContain("Known attribution gap");
  });
});