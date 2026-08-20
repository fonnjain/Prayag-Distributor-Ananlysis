import { describe, expect, it } from "vitest";
import {
  resolveCatalogueAuthority,
  UNMAPPED_TAXONOMY,
} from "./catalogueAuthority.js";
import { rankCode } from "./skuPushList.js";

describe("current catalogue authority contract", () => {
  it.each([
    [{ authorityPresent: true, localPresent: false }, "authority_only", true, "authority"],
    [{ authorityPresent: false, localPresent: true }, "local_only", false, "unavailable"],
    [{ authorityPresent: true, localPresent: true }, "both", true, "authority"],
    [{ authorityPresent: false, localPresent: false }, "neither", false, "unavailable"],
  ] as const)(
    "resolves %o as %s",
    (presence, display, currentProductExists, currentMrpSource) => {
      expect(resolveCatalogueAuthority(presence)).toMatchObject({
        display,
        currentProductExists,
        currentMrpSource,
      });
    },
  );
});

describe("push-list optional local taxonomy", () => {
  it("keeps an unmapped code out of synthetic Range classification", () => {
    expect(
      rankCode(
        UNMAPPED_TAXONOMY,
        "PTMT / Faucets",
        "AUTH-ONLY-1",
        new Set([UNMAPPED_TAXONOMY]),
        new Set(),
        new Set(["PTMT / Faucets"]),
      ),
    ).toEqual({ tier: 3, tierLabel: "Active" });
  });
});