import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLegacyNumericSourceKey,
  resolveEmployeeCode,
  resolveUniquePersonIdentityKey,
} from "./employeeCodeIdentity.js";
import { makePersonRegistryIdentityKey } from "./personRegistry.js";

const sharedCode = "5900000000000";
const people = [
  { personId: 97, name: "Basit Ahmad Pala", employeeCode: sharedCode },
  { personId: 127, name: "Jijo", employeeCode: sharedCode },
];

function migrationSource(): string {
  const candidates = [
    resolve(process.cwd(), "lib/db/src/runMigrations.ts"),
    resolve(process.cwd(), "../../lib/db/src/runMigrations.ts"),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error("Cannot locate runMigrations.ts for migration guard test");
  return readFileSync(file, "utf8");
}

describe("employee-code identity guard", () => {
  it("keeps Basit and Jijo as separate candidates for their shared code", () => {
    const resolution = resolveEmployeeCode(
      sharedCode,
      people,
      (person) => person.employeeCode,
    );

    expect(resolution.status).toBe("ambiguous");
    if (resolution.status === "ambiguous") {
      expect(resolution.candidates).toEqual(people);
      expect(resolution.candidates.map((person) => person.personId)).toEqual([97, 127]);
    }
  });

  it("never derives a registry identity key from an employee code", () => {
    const basitKey = makePersonRegistryIdentityKey("Basit Ahmad Pala", "Nasir Hussain Khan");
    const jijoKey = makePersonRegistryIdentityKey("Jijo", "SANOJ M.");

    expect(basitKey).not.toContain(sharedCode);
    expect(jijoKey).not.toContain(sharedCode);
    expect(basitKey).not.toBe(jijoKey);
  });

  it("recognises numeric keys as source aliases, not identities", () => {
    expect(isLegacyNumericSourceKey(sharedCode)).toBe(true);
    expect(isLegacyNumericSourceKey("basitahmadpala:nasirhussainkhan")).toBe(false);
  });

  it("never resolves a numeric source alias or duplicate identity key to one person", () => {
    const candidates = [
      { key: sharedCode, name: "First" },
      { key: sharedCode, name: "Second" },
      { key: "unique:manager", name: "Unique" },
      { key: "duplicate:manager", name: "Duplicate one" },
      { key: "duplicate:manager", name: "Duplicate two" },
    ];

    expect(resolveUniquePersonIdentityKey(
      sharedCode, candidates, (candidate) => candidate.key,
    )).toBeNull();
    expect(resolveUniquePersonIdentityKey(
      "duplicate:manager", candidates, (candidate) => candidate.key,
    )).toBeNull();
    expect(resolveUniquePersonIdentityKey(
      "unique:manager", candidates, (candidate) => candidate.key,
    )).toEqual({ key: "unique:manager", name: "Unique" });
  });

  it("keeps migration and secondary query code ambiguity-safe", () => {
    const source = migrationSource();
    const migrationStart = source.indexOf('id: "069_employee_code_identity_guards"');
    const migrationEnd = source.indexOf("\n  },", migrationStart);
    const migration = source.slice(migrationStart, migrationEnd);

    expect(source).toContain('id: "069_employee_code_identity_guards"');
    expect(source).toContain("person_registry_source_alias");
    expect(source).toContain("HAVING COUNT(*) = 1");
    expect(migration).not.toContain("sale_line");
    expect(migration).not.toContain("secondary_sku_line");
    expect(migration).not.toContain("margin_fact");
  });
});