/**
 * Live compatibility names used when comparing historical register evidence
 * with already-persisted coverage. Historic migrations keep their own literal
 * record of the rules that ran; this is the single source for current reports.
 *
 * An unverified alias never proves identity or authorizes a reassignment. It
 * only lets an operator see which persisted historical coverage needs review.
 */
export type CoverageAliasVerification = "confirmed" | "unverified_alias";

export type CoverageHeadAlias = {
  registerHead: string;
  coveragePerson: string;
  verification: CoverageAliasVerification;
};

export const COVERAGE_HEAD_ALIASES: readonly CoverageHeadAlias[] = [
  {
    registerHead: "Babu",
    coveragePerson: "Taninki Ramesh Babu",
    verification: "unverified_alias",
  },
  {
    registerHead: "Pawan Sharma",
    coveragePerson: "Pawan Kumar Sharma",
    verification: "confirmed",
  },
  {
    registerHead: "Syed Aqil Rizvi",
    coveragePerson: "Aqil Rizvi",
    verification: "confirmed",
  },
  {
    registerHead: "Suresh Nair",
    coveragePerson: "Suresh Kumar Nair",
    verification: "confirmed",
  },
] as const;

export type UnverifiedCoverageAliasReview = {
  registerHead: string;
  coveragePerson: string;
  stateCanon: string;
  fiscalYears: readonly string[];
  status: "UNVERIFIED ALIAS";
  reviewNote: string;
};

export const UNVERIFIED_COVERAGE_ALIAS_REVIEWS: readonly UnverifiedCoverageAliasReview[] = [
  {
    registerHead: "Babu",
    coveragePerson: "Taninki Ramesh Babu",
    stateCanon: "TAMIL NADU",
    fiscalYears: ["2023-24", "2024-25"],
    status: "UNVERIFIED ALIAS",
    reviewNote:
      "The register label Babu is preserved for review. HR contains a separate departed S.Babu record, so Prayag must confirm identity before any coverage change.",
  },
] as const;

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Produces a static SQL CASE expression from the registry above. The column
 * name is supplied only by repository code, never by a request parameter.
 */
export function coveragePersonSql(column: string): string {
  const branches = COVERAGE_HEAD_ALIASES
    .map((alias) => `WHEN ${quoteSqlLiteral(alias.registerHead)} THEN ${quoteSqlLiteral(alias.coveragePerson)}`)
    .join("\n                ");
  return `CASE ${column}
                ${branches}
                ELSE ${column}
              END`;
}

export function getUnverifiedCoverageAliasReview(input: {
  coveragePerson: string | null | undefined;
  stateCanon: string;
  fiscalYear: string | null | undefined;
}): UnverifiedCoverageAliasReview | null {
  return UNVERIFIED_COVERAGE_ALIAS_REVIEWS.find((review) =>
    review.coveragePerson === input.coveragePerson
    && review.stateCanon === input.stateCanon
    && input.fiscalYear != null
    && review.fiscalYears.includes(input.fiscalYear),
  ) ?? null;
}

function unverifiedCoverageAliasMatchesSql(
  coverageAlias: string,
  personNameSql: string,
): Array<{ review: UnverifiedCoverageAliasReview; match: string }> {
  return UNVERIFIED_COVERAGE_ALIAS_REVIEWS.map((review) => {
    const years = review.fiscalYears.map(quoteSqlLiteral).join(", ");
    return {
      review,
      match: `(${coverageAlias}.state_canon = ${quoteSqlLiteral(review.stateCanon)}
          AND ${coverageAlias}.fiscal_year IN (${years})
          AND ${personNameSql} = ${quoteSqlLiteral(review.coveragePerson)})`,
    };
  });
}

export function unverifiedCoverageAliasReviewSql(
  coverageAlias: string,
  personNameSql: string,
): { status: string; registerHeadLabel: string; reviewNote: string } {
  const matches = unverifiedCoverageAliasMatchesSql(coverageAlias, personNameSql);
  const caseExpression = (value: (review: UnverifiedCoverageAliasReview) => string) =>
    `CASE ${matches.map(({ review, match }) => `WHEN ${match} THEN ${quoteSqlLiteral(value(review))}`).join(" ")} ELSE NULL END`;

  return {
    status: caseExpression((review) => review.status),
    registerHeadLabel: caseExpression((review) => review.registerHead),
    reviewNote: caseExpression((review) => review.reviewNote),
  };
}

/**
 * Static SQL fragment for people-detail coverage rows. It only labels existing
 * records; it does not update a person, coverage, customer, or sale row.
 */
export function unverifiedCoverageAliasStatusSql(
  coverageAlias: string,
  personNameSql: string,
): string {
  return unverifiedCoverageAliasReviewSql(coverageAlias, personNameSql).status;
}