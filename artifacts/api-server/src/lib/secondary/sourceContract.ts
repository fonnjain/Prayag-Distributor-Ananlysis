/**
 * Immutable source seam for secondary SKU facts.
 *
 * This module is deliberately pure: it does not load or write source data.
 * Consumers can attach the returned metadata to rows and nodes, while
 * cross-source arithmetic must explicitly opt in after parity is accepted.
 */
export type SecondarySource = "pscode3_xlsx" | "productwise_xlsx";
export type SecondaryValueBasis = "net_amount" | "basic_order_value_ex_gst";
export type SecondaryCompleteness = "complete" | "partial" | "unavailable";

export type SecondarySourceMetadata = {
  source: SecondarySource;
  value_basis: SecondaryValueBasis;
  month: string;
  cutoff: string;
  completeness: SecondaryCompleteness;
};

export type SecondarySeam = {
  from: SecondarySourceMetadata;
  to: SecondarySourceMetadata;
  crossesSourceBoundary: true;
  approvedEquivalence: boolean;
  disclosure: string;
};

const MONTH_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/;

export function secondarySourceForMonth(month: string): SecondarySource {
  const match = month.match(MONTH_RE);
  if (!match) throw new Error(`Invalid secondary month '${month}'; expected Mon-YY`);
  const year = Number(month.slice(-2));
  const monthName = month.slice(0, 3);
  const beforeAugust = year < 26 || (year === 26 && ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].includes(monthName));
  return beforeAugust ? "pscode3_xlsx" : "productwise_xlsx";
}

export function expectedSecondaryValueBasis(source: SecondarySource): SecondaryValueBasis {
  return source === "pscode3_xlsx" ? "net_amount" : "basic_order_value_ex_gst";
}

export function assertSecondarySourceMonth(metadata: SecondarySourceMetadata): void {
  const expected = secondarySourceForMonth(metadata.month);
  if (metadata.source !== expected) {
    throw new Error(
      `Secondary source-month mismatch: ${metadata.source} is not allowed for ${metadata.month}; expected ${expected}`,
    );
  }
  if (metadata.value_basis !== expectedSecondaryValueBasis(metadata.source)) {
    throw new Error(
      `Secondary value basis mismatch: ${metadata.source} requires ${expectedSecondaryValueBasis(metadata.source)}`,
    );
  }
  if (!metadata.cutoff.trim()) throw new Error("Secondary source cutoff is required");
  if (!metadata.completeness) throw new Error("Secondary source completeness is required");
}

export function secondarySeam(
  from: SecondarySourceMetadata,
  to: SecondarySourceMetadata,
  approvedEquivalence = false,
): SecondarySeam {
  assertSecondarySourceMonth(from);
  assertSecondarySourceMonth(to);
  if (from.source === to.source) {
    throw new Error("A secondary seam requires two different sources");
  }
  return {
    from,
    to,
    crossesSourceBoundary: true,
    approvedEquivalence,
    disclosure: approvedEquivalence
      ? `Secondary source seam: ${from.month} ${from.source}/${from.value_basis} to ${to.month} ${to.source}/${to.value_basis}; approved equivalence recorded.`
      : `Secondary source seam: ${from.month} ${from.source}/${from.value_basis} to ${to.month} ${to.source}/${to.value_basis}; values must not be aggregated until equivalence is approved.`,
  };
}

export function assertSecondaryAggregationAllowed(metadata: SecondarySourceMetadata[], approvedEquivalence = false): void {
  metadata.forEach(assertSecondarySourceMonth);
  const sources = new Set(metadata.map((entry) => entry.source));
  if (sources.size > 1 && !approvedEquivalence) {
    throw new Error("Secondary cross-source aggregation refused: July-to-August equivalence is not approved.");
  }
}