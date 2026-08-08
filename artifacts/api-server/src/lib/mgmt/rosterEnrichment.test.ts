import { describe, it, expect } from "vitest";
import { resolveMemberEnrichment } from "./roster.js";
import { normSecKey } from "./names.js";

// Minimal CsvHrEnrichment factory — only the fields the resolver returns matter.
function enr(empCode: string, designation: string) {
  return {
    empCode,
    designation,
    monthlyCtc: null,
    dojSerial: null,
    leftDateSerial: null,
    activeLeft: "Active",
  };
}

// Build the three maps the way loadCsvHrEnrichment does, for a file containing:
//   - "Ashutosh Kumar (Rudrapur)" under Anant Singh      (emp 5289696934)
//   - "Ashutosh Kumar"            under Sandeep Dadheech  (emp 639)
//   - "Ranjeet Kumar"             under Anant Singh       (emp 1001)  ← duplicate name
//   - "Ranjeet Kumar"             under Nasir Hussain Khan(emp 2002)  ← duplicate name
//   - "Solo Person"               under Some Manager      (emp 42)    ← unambiguous
function buildMaps() {
  const rows = [
    { name: "Ashutosh Kumar (Rudrapur)", mgr: "Anant Singh", e: enr("5289696934", "Executive Sales") },
    { name: "Ashutosh Kumar", mgr: "Sandeep Dadheech", e: enr("639", "Area Sales Manager") },
    { name: "Ranjeet Kumar", mgr: "Anant Singh", e: enr("1001", "Executive Sales") },
    { name: "Ranjeet Kumar", mgr: "Nasir Hussain Khan", e: enr("2002", "Regional Sales Manager") },
    { name: "Solo Person", mgr: "Some Manager", e: enr("42", "Executive Sales") },
  ];

  const enrichment = new Map<string, ReturnType<typeof enr>>();
  const byIdentity = new Map<string, ReturnType<typeof enr>>();
  const nameCount = new Map<string, number>();
  for (const r of rows) {
    const nsk = normSecKey(r.name);
    const key = nsk + ":" + normSecKey(r.mgr);
    if (!enrichment.has(nsk)) enrichment.set(nsk, r.e);
    if (!byIdentity.has(key)) byIdentity.set(key, r.e);
    nameCount.set(nsk, (nameCount.get(nsk) ?? 0) + 1);
  }
  const ambiguousNameKeys = new Set<string>();
  for (const [k, c] of nameCount) if (c > 1) ambiguousNameKeys.add(k);
  return { enrichment, byIdentity, ambiguousNameKeys };
}

const CSV = buildMaps();

describe("resolveMemberEnrichment — compound name+manager key", () => {
  it("resolves both Ashutosh rows distinctly via the compound key", () => {
    const rudra = resolveMemberEnrichment(
      normSecKey("Ashutosh Kumar (Rudrapur)"),
      "Anant Singh",
      CSV,
    );
    expect(rudra.via).toBe("compound");
    expect(rudra.enrichment?.empCode).toBe("5289696934");

    const plain = resolveMemberEnrichment(
      normSecKey("Ashutosh Kumar"),
      "Sandeep Dadheech",
      CSV,
    );
    expect(plain.via).toBe("compound");
    expect(plain.enrichment?.empCode).toBe("639");

    // The two must NOT collide onto the same code.
    expect(rudra.enrichment?.empCode).not.toBe(plain.enrichment?.empCode);
  });

  it("resolves an ambiguous duplicate name via the correct manager", () => {
    const a = resolveMemberEnrichment(normSecKey("Ranjeet Kumar"), "Anant Singh", CSV);
    expect(a.via).toBe("compound");
    expect(a.enrichment?.empCode).toBe("1001");

    const b = resolveMemberEnrichment(normSecKey("Ranjeet Kumar"), "Nasir Hussain Khan", CSV);
    expect(b.via).toBe("compound");
    expect(b.enrichment?.empCode).toBe("2002");
  });

  it("attaches NOTHING when an ambiguous name has no matching manager", () => {
    const r = resolveMemberEnrichment(
      normSecKey("Ranjeet Kumar"),
      "Totally Different Manager",
      CSV,
    );
    expect(r.via).toBe("ambiguous-blocked");
    expect(r.enrichment).toBeNull();
  });

  it("falls back to name-only for an unambiguous name even if the manager differs", () => {
    const r = resolveMemberEnrichment(normSecKey("Solo Person"), "Any Manager At All", CSV);
    expect(r.via).toBe("name");
    expect(r.enrichment?.empCode).toBe("42");
  });

  it("returns 'none' for a name absent from the CSV", () => {
    const r = resolveMemberEnrichment(normSecKey("Nobody Here"), "Nobody", CSV);
    expect(r.via).toBe("none");
    expect(r.enrichment).toBeNull();
  });
});
