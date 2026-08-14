// Unit tests: wipe guard abort surfacing in the secondary SKU backfill route.
//
// WHAT THIS TESTS:
//   When loadSecSkuFromSheets throws WipeGuardAbortError (Rule 3 — a member's
//   PSCode2 tab is absent from the workbook), the route must:
//     1. Classify it as a guard abort rather than a generic transient failure.
//     2. Build a structured body with { code, fy, month, rule, head, existing, incoming }.
//     3. Surface it on the GET status endpoint as a 409 response.
//
//   These are pure unit tests — no DB, no Express server, no Sheets calls.
//   The classifyBackfillError helper is imported and exercised directly.

import { describe, it, expect } from "vitest";
import { WipeGuardAbortError } from "../lib/sku/skuWipeGuard.js";
import { classifyBackfillError } from "./sku.js";

describe("classifyBackfillError — WipeGuardAbortError (Rule 3: member tab absent)", () => {
  it("returns kind=guard_abort with all structured fields when Rule 3 fires", () => {
    const err = new WipeGuardAbortError(
      "2024-25",   // fy
      "Apr-24",    // month
      "member",    // rule
      45,          // existing rows for this (month, head) pair
      0,           // incoming rows — member tab absent
      0,           // ratio
      10,          // threshold (GUARD_HEAD_MIN_ROWS)
      "anant singh kumar", // head
    );

    const result = classifyBackfillError(err);

    expect(result.kind).toBe("guard_abort");
    if (result.kind !== "guard_abort") return; // narrow for TS

    expect(result.body.code).toBe("WIPE_GUARD_ABORT");
    expect(result.body.fy).toBe("2024-25");
    expect(result.body.month).toBe("Apr-24");
    expect(result.body.rule).toBe("member");
    expect(result.body.head).toBe("anant singh kumar");
    expect(result.body.existing).toBe(45);
    expect(result.body.incoming).toBe(0);
  });

  it("returns kind=guard_abort for Rule 1 (row-ratio violation) with head=null", () => {
    const err = new WipeGuardAbortError(
      "2025-26",
      "Jul-25",
      "rows",
      12_000,
      4_000,
      4_000 / 12_000,
      0.60,
      // no head arg — Rule 1 is company-wide, not per-member
    );

    const result = classifyBackfillError(err);

    expect(result.kind).toBe("guard_abort");
    if (result.kind !== "guard_abort") return;

    expect(result.body.code).toBe("WIPE_GUARD_ABORT");
    expect(result.body.fy).toBe("2025-26");
    expect(result.body.month).toBe("Jul-25");
    expect(result.body.rule).toBe("rows");
    expect(result.body.head).toBeNull();
    expect(result.body.existing).toBe(12_000);
    expect(result.body.incoming).toBe(4_000);
  });

  it("returns kind=guard_abort for Rule 2 (distributor-ratio violation)", () => {
    const err = new WipeGuardAbortError(
      "2023-24",
      "Jun-23",
      "distributors",
      50,   // existing distinct distributors
      30,   // incoming distinct distributors
      30 / 50,
      0.70,
    );

    const result = classifyBackfillError(err);

    expect(result.kind).toBe("guard_abort");
    if (result.kind !== "guard_abort") return;

    expect(result.body.rule).toBe("distributors");
    expect(result.body.head).toBeNull();
  });

  it("returns kind=other for a generic Error (e.g. Sheets quota exhaustion)", () => {
    const err = new Error("Google Sheets API quota exceeded — retry after 60s");
    const result = classifyBackfillError(err);
    expect(result.kind).toBe("other");
    if (result.kind !== "other") return;
    expect(result.message).toContain("quota exceeded");
  });

  it("returns kind=other for a plain string thrown from the loader", () => {
    const result = classifyBackfillError("unexpected string rejection");
    expect(result.kind).toBe("other");
  });

  it("returns kind=other for null/undefined", () => {
    expect(classifyBackfillError(null).kind).toBe("other");
    expect(classifyBackfillError(undefined).kind).toBe("other");
  });
});

describe("GuardAbortBody shape — 409 response contract", () => {
  it("guard_abort body has exactly the fields the GET endpoint returns in the 409", () => {
    // This test doubles as a contract check: if GuardAbortBody fields change,
    // the test breaks and forces a deliberate update to the API contract too.
    const err = new WipeGuardAbortError(
      "2024-25", "May-24", "member", 20, 0, 0, 10, "priya singh",
    );
    const result = classifyBackfillError(err);
    if (result.kind !== "guard_abort") throw new Error("expected guard_abort");

    const body = result.body;
    // Enumerate every field explicitly — additions require a deliberate update here.
    expect(Object.keys(body).sort()).toEqual(
      ["code", "existing", "fy", "head", "incoming", "month", "rule"].sort(),
    );
    expect(body.code).toBe("WIPE_GUARD_ABORT");
    expect(typeof body.fy).toBe("string");
    expect(typeof body.month).toBe("string");
    expect(["rows", "distributors", "member"]).toContain(body.rule);
    expect(body.head === null || typeof body.head === "string").toBe(true);
    expect(typeof body.existing).toBe("number");
    expect(typeof body.incoming).toBe("number");
  });
});
