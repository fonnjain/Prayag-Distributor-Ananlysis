import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "catalogue.ts"), "utf8");
const pushListSource = readFileSync(resolve(import.meta.dirname, "skuPushList.ts"), "utf8");
const routeSource = readFileSync(resolve(import.meta.dirname, "../../routes/sku.ts"), "utf8");

describe("catalogue taxonomy overrides", () => {
  it("keeps the override as taxonomy enrichment rather than an authority source", () => {
    expect(source).toContain("COALESCE(sto.item_group, im.item_group)");
    expect(source).toContain("JOIN mrp_sync_generation g");
    expect(source).toContain("g.is_active = TRUE");
    expect(source).not.toContain("UPDATE mrp_synced");
    expect(source).not.toContain("UPDATE item_master");
  });

  it("uses an audited override for Push List range classification", () => {
    expect(pushListSource).toContain("LEFT JOIN sku_taxonomy_override sto ON sto.code = sl.code");
    expect(pushListSource).toContain("COALESCE(MAX(sto.item_group), MAX(im.item_group), ${UNMAPPED_TAXONOMY})");
  });

  it("serializes mapping history and derives the reviewer from the signed-in admin", () => {
    expect(source).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(source).toContain("WHERE is_active = TRUE\n       FOR UPDATE");
    expect(routeSource).toContain("req.authUser?.role !== \"admin\"");
    expect(routeSource).toContain("mappedByUserId: req.authUser!.id");
    expect(routeSource).not.toContain("body.mappedBy");
  });
});