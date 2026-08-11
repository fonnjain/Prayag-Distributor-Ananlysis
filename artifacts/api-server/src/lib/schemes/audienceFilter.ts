// Audience filter helpers for scheme tracking queries.
//
// Q2 scheme audiences map to customer populations as follows:
//   sub_dealer       = retailer customers (NOT in distributor_identity)
//   direct_dealer    = direct dealer customers (would require a direct_dealer
//                      table; type_raw is NULL on all sale_line rows so this
//                      channel cannot be precisely filtered from sale_line data)
//   distributor      = customers in distributor_identity
//
// Identification of distributors: distributor_identity.norm_key stores an
// uppercase letter/digit/space representation of each distributor name. The
// same normalisation applied to sale_line.customer lets us match them.
//
// SQL normalisation expression:
//   UPPER(REGEXP_REPLACE(TRIM(<customerCol>), '[^A-Z0-9 ]', '', 'g'))
//
// LIMITATION: Only distributors registered in distributor_identity (~269 entries)
// are excluded. Unregistered intermediaries pass through as retailer rows.

/**
 * Build the SQL WHERE fragment that restricts sale_line rows to the given
 * scheme audience. The fragment always starts with AND so it can be
 * interpolated directly into a WHERE clause.
 *
 * @param audience  audience[] from scheme table (e.g. ["sub_dealer"])
 * @param tableAlias  alias for the sale_line table in the query (default "sl")
 */
export function buildAudienceFilterSQL(
  audience: string[],
  tableAlias = "sl",
): string {
  const hasSub    = audience.includes("sub_dealer");
  const hasDirect = audience.includes("direct_dealer");
  const hasDist   = audience.includes("distributor");

  if (hasSub && !hasDirect && !hasDist) {
    // Retailer-only: exclude customers that are registered distributors.
    // Uses a normalised name match against distributor_identity.norm_key.
    return `
      AND NOT EXISTS (
        SELECT 1 FROM distributor_identity di
        WHERE di.norm_key = UPPER(REGEXP_REPLACE(TRIM(${tableAlias}.customer), '[^A-Z0-9 ]', '', 'g'))
      )`;
  }

  if (hasDist && !hasSub && !hasDirect) {
    // Distributor-only: include only customers present in distributor_identity.
    return `
      AND EXISTS (
        SELECT 1 FROM distributor_identity di
        WHERE di.norm_key = UPPER(REGEXP_REPLACE(TRIM(${tableAlias}.customer), '[^A-Z0-9 ]', '', 'g'))
      )`;
  }

  if (hasDirect && !hasSub && !hasDist) {
    // Direct-dealer-only: a direct_dealer_identity table does not yet exist and
    // type_raw is NULL on all sale_line rows, so we cannot isolate direct dealers
    // from sale_line data. Return a guard that fails closed rather than silently
    // returning all non-distributor rows.
    return `
      AND false -- direct_dealer-only audience: no sale_line signal available`;
  }

  // Mixed audience (e.g. direct_dealer + sub_dealer, or distributor + direct_dealer)
  // or empty/unknown audience → no customer-type restriction.
  return "";
}
