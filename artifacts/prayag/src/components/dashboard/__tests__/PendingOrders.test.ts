import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HeadSection,
  ReconText,
  RELATED_MEASURES_DESCRIPTION,
  formatPprCaveat,
  PENDING_EXPORT_LABEL,
  formatNonTerritoryPending,
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
  it("uses corrected operational-measure wording and dynamic caveat values", () => {
    expect(RELATED_MEASURES_DESCRIPTION).toContain("no common order key");
    expect(RELATED_MEASURES_DESCRIPTION).toContain("not directly comparable");
    expect(RELATED_MEASURES_DESCRIPTION).not.toContain("expected to agree in magnitude");
    expect(formatPprCaveat(225.95, 59426, 5898)).toContain("₹225.95");
    expect(formatPprCaveat(225.95, 59426, 5898)).toContain("₹59,426.00");
    expect(formatPprCaveat(225.95, 59426, 5898)).toContain("5,898 pending pieces");
    expect(formatPprCaveat(null, null, 5898)).toBeNull();
    expect(PENDING_EXPORT_LABEL).toBe("Download both measures");
    expect(formatNonTerritoryPending(29300000)).toContain("2.93 Cr");
    expect(formatNonTerritoryPending(null)).toBe("—");
  });

  it("formats amount reconciliation in rupees rather than quantity units", () => {
    const markup = renderToStaticMarkup(createElement(ReconText, {
      measure: "amount",
      rec: { parent: 1250.5, children: 1250.5, difference: 0, exact: true },
    }));
    expect(markup).toContain("Parent ₹1,250.50");
    expect(markup).toContain("Children ₹1,250.50");
    expect(markup).toContain("Difference ₹0.00");
  });

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

  it("renders a blank grey amount for a fully unpriceable row and preserves the amount basis surface", () => {
    const head = zeroCoverageHead("AMOUNT HEAD");
    head.pricedAmount = null;
    head.unpriceableQty = 100;
    head.unpriceableReason = "No usable positive realised rate";
    const html = renderToStaticMarkup(
      createElement(HeadSection, {
        head,
        groups: ["GARDEN PIPE"],
        defaultOpen: true,
        measure: "amount",
      }),
    );
    expect(html).toContain("Priced amount");
    expect(html).toContain("Unpriceable");
    expect(html).toContain("bg-muted/50");
    expect(html).toContain("No usable positive realised rate");
  });

  it("renders genuine zero amount rather than treating it as missing", () => {
    const head = zeroCoverageHead("ZERO AMOUNT");
    head.pricedAmount = 0;
    head.unpriceableQty = 0;
    head.parties[0].byGroupAmount = { "GARDEN PIPE": 0 };
    const html = renderToStaticMarkup(
      createElement(HeadSection, {
        head,
        groups: ["GARDEN PIPE"],
        defaultOpen: true,
        measure: "amount",
      }),
    );
    expect(html).toContain("₹0.00");
  });

  it("shows the matching Sandeep amount reconciliation while quantity stays in pieces", () => {
    const head = zeroCoverageHead("Sandeep");
    head.pricedAmount = 0;
    head.unpriceableQty = 0;
    head.amountReconciliation = { parent: 0, children: 0, difference: 0, exact: true };
    head.parties[0].byGroupAmount = { "GARDEN PIPE": 0 };
    head.parties[0].amountReconciliation = { parent: 0, children: 0, difference: 0, exact: true };
    head.buckets![0].amountReconciliation = { parent: 0, children: 0, difference: 0, exact: true };
    const amount = renderToStaticMarkup(createElement(HeadSection, {
      head, groups: ["GARDEN PIPE"], defaultOpen: true, measure: "amount",
    }));
    expect(amount).toContain("Sandeep");
    expect(amount).toContain("Parent ₹0.00, Children ₹0.00, Difference ₹0.00");
    const quantity = renderToStaticMarkup(createElement(HeadSection, {
      head, groups: ["GARDEN PIPE"], defaultOpen: true, measure: "quantity",
    }));
    expect(quantity).toContain("Parent 100, Children 100, Difference 0");
  });
});