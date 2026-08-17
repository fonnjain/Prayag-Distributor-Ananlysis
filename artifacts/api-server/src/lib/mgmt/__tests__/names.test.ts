// Vitest tests for the headNormKey normalisation family in names.ts.
//
// headNormKey invariant: normHead(v) === v (lowercase alphanumerics, no
// spaces, no punctuation, parentheticals stripped, trailing ji/sir removed).
//
// These tests import the production functions and HEAD_ALIASES directly so
// that any change to names.ts is automatically reflected here — no manually
// maintained copy can drift out of sync.

import { describe, it, expect } from "vitest";
import { normHead, resolveHeadKey, HEAD_ALIASES } from "../names.js";

describe("headNormKey family — normHead", () => {
  it("is idempotent on its own output (normHead(normHead(v)) === normHead(v))", () => {
    const samples = [
      "anantsingh",
      "sandeepdadheech",
      "syedaqilrizvi",
      "bijuco",
      "sulinderpal",
      "pawansharma",
      "lalankumar",
      "nasirhussainkhan",
      "ravishankar",
    ];
    for (const s of samples) {
      expect(normHead(normHead(s))).toBe(normHead(s));
    }
  });

  it("strips trailing ji honorific", () => {
    expect(normHead("ANANT SINGH JI")).toBe("anantsingh");
    expect(normHead("RIZVI JI")).toBe("rizvi");
    expect(normHead("SANDEEP JI")).toBe("sandeep");
  });

  it("strips trailing sir honorific", () => {
    expect(normHead("Ravi Sir")).toBe("ravi");
  });

  it("lowercases and removes punctuation and spaces", () => {
    expect(normHead("Biju C.O")).toBe("bijuco");
    expect(normHead("Syed Aqil Rizvi")).toBe("syedaqilrizvi");
    expect(normHead("Pawan Kumar Sharma")).toBe("pawankumarsharma");
  });

  it("strips parenthetical content (differs from normSecKey)", () => {
    // normSecKey("Ravi (Faridabad)") = "ravifaridabad"
    // normHead("Ravi (Faridabad)")   = "ravi"
    // The parenthetical is replaced by a space before stripping — so it is
    // NOT included in the key.  This is the critical family boundary.
    expect(normHead("Ravi (Faridabad)")).toBe("ravi");
    expect(normHead("Ashutosh Kumar (Off Roll)")).toBe("ashutoshkumar");
  });
});

describe("headNormKey family — HEAD_ALIASES integrity", () => {
  it("all alias keys are normHead-idempotent", () => {
    for (const [key] of Object.entries(HEAD_ALIASES)) {
      expect(normHead(key)).toBe(key);
    }
  });

  it("all alias values are normHead-idempotent (no silent ji/sir strip)", () => {
    // This is the critical guard: a value ending in "ji" or "sir" would be
    // stripped by a subsequent normHead() call and silently miss every join.
    for (const [key, value] of Object.entries(HEAD_ALIASES)) {
      expect(normHead(value)).toBe(value);
    }
  });

  it("alias keys and values are non-empty strings", () => {
    for (const [key, value] of Object.entries(HEAD_ALIASES)) {
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("headNormKey family — resolveHeadKey", () => {
  it("is idempotent on canonical alias target values", () => {
    const canonicalValues = [
      ...new Set([
        ...Object.values(HEAD_ALIASES),
        "anantsingh",
        "ravishankar",
        "bijuco",
        "sandeepdadheech",
      ]),
    ];
    for (const v of canonicalValues) {
      expect(resolveHeadKey(v)).toBe(v);
    }
  });

  it("resolves known raw spellings to expected canonical keys", () => {
    const fixtures: Array<[unknown, string]> = [
      // Honorific stripping + passthrough
      ["ANANT SINGH JI",              "anantsingh"],
      ["Anant Singh",                 "anantsingh"],
      // Alias: RIZVI → syedaqilrizvi
      ["RIZVI JI",                    "syedaqilrizvi"],
      ["Syed Aqil Rizvi",             "syedaqilrizvi"],
      ["Aqil Rizvi",                  "syedaqilrizvi"],
      // Alias: SANDEEP / SNADEEP → sandeepdadheech
      ["SANDEEP JI",                  "sandeepdadheech"],
      ["Sandeep Dadheech",            "sandeepdadheech"],
      ["SNADEEP",                     "sandeepdadheech"],
      // Alias: BIJJU / BIJU → bijuco
      ["BIJJU",                       "bijuco"],
      ["Biju C.O",                    "bijuco"],
      ["BIJU",                        "bijuco"],
      // Alias: sulindarpal → sulinderpal
      ["Sulindar Pal",                "sulinderpal"],
      ["Sulinder Pal",                "sulinderpal"],
      // Alias: pawankumar / pawankumarsharma → pawansharma
      ["Pawan Kumar",                 "pawansharma"],
      ["Pawan Kumar Sharma",          "pawansharma"],
      ["Pawan Sharma",                "pawansharma"],
      // Alias: lalan → lalankumar
      ["LALAN",                       "lalankumar"],
      ["Lalan Kumar",                 "lalankumar"],
      // Alias: nasirhusain / nasirhussain → nasirhussainkhan
      ["NASIR HUSAIN",                "nasirhussainkhan"],
      ["NASIR HUSSAIN",               "nasirhussainkhan"],
      ["Nasir Hussain Khan",          "nasirhussainkhan"],
      // Parenthetical: headNormKey strips contents, normSecKey keeps them.
      ["Ravi (Faridabad)",            "ravi"],
    ];

    for (const [raw, expected] of fixtures) {
      expect(resolveHeadKey(raw), `resolveHeadKey(${JSON.stringify(raw)})`).toBe(expected);
    }
  });
});
