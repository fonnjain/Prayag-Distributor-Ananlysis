/**
 * Shared current-catalogue contract for SKU analytics.
 *
 * The active prayag-price.com cache owns present-day product existence and MRP.
 * `item_master` is optional enrichment only: it can contribute a name or local
 * taxonomy label, but it must never create a current product or current price.
 */

import { sql, type SQL } from "drizzle-orm";

export const UNMAPPED_TAXONOMY = "Unmapped";

export type CataloguePresence = {
  authorityPresent: boolean;
  localPresent: boolean;
};

export type CatalogueAuthorityResolution = {
  currentProductExists: boolean;
  currentMrpSource: "authority" | "unavailable";
  localMetadataAllowed: boolean;
  display: "authority_only" | "local_only" | "both" | "neither";
};

/**
 * The four one-sided catalogue states. This is intentionally data-source
 * agnostic so reports and UI code can use the same externally-visible rule.
 */
export function resolveCatalogueAuthority(
  presence: CataloguePresence,
): CatalogueAuthorityResolution {
  if (presence.authorityPresent && presence.localPresent) {
    return {
      currentProductExists: true,
      currentMrpSource: "authority",
      localMetadataAllowed: true,
      display: "both",
    };
  }
  if (presence.authorityPresent) {
    return {
      currentProductExists: true,
      currentMrpSource: "authority",
      localMetadataAllowed: false,
      display: "authority_only",
    };
  }
  if (presence.localPresent) {
    return {
      currentProductExists: false,
      currentMrpSource: "unavailable",
      localMetadataAllowed: true,
      display: "local_only",
    };
  }
  return {
    currentProductExists: false,
    currentMrpSource: "unavailable",
    localMetadataAllowed: false,
    display: "neither",
  };
}

/**
 * Source-only rows for the active last-known-good generation. Do not use
 * `mrp_current_catalogue` here: it includes a legacy local fallback before the
 * first sync, which is useful for migration diagnostics but not current-price
 * authority decisions.
 */
export const authoritativeCurrentMrpRows: SQL = sql`
  SELECT DISTINCT
    s.item_code,
    d.app_segment AS segment,
    s.mrp
  FROM mrp_synced s
  JOIN mrp_sync_generation g
    ON g.generation_id = s.generation_id
   AND g.is_active = TRUE
  JOIN mrp_synced_division d
    ON d.generation_id = s.generation_id
   AND d.item_code = s.item_code
  WHERE d.app_segment IS NOT NULL
    AND s.mrp IS NOT NULL
    AND s.mrp > 0
`;