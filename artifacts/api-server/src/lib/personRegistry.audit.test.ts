import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { connect: mocks.connect, query: mocks.query },
}));

import {
  patchRegistryRow,
  previewAliasImpact,
  RegistryImpactChangedError,
  RegistryImpactRequiredError,
} from "./personRegistry.js";

const current = {
  id: 10,
  employee_code: "210",
  code_plausible: true,
  norm_key: "210",
  canonical_name: "Example Person",
  alias_primary: ["EXAMPLE"],
  alias_secondary: "Example Person",
  alias_sheet: null,
  reporting_manager: null,
  state_head: "Example Head",
  is_state_head: false,
  is_person: true,
  hr_status: "Active",
  flag_notes: null,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-08-21T00:00:00.000Z"),
};

describe("patchRegistryRow audit trail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM person_registry")) return { rows: [current] };
      if (sql.includes("FROM sale_line_current")) return { rows: [] };
      if (sql.includes("UPDATE person_registry")) {
        return { rows: [{ ...current, alias_primary: ["EXAMPLE", "EXAMPLE JI"], alias_secondary: "Example Person Ji" }] };
      }
      return { rows: [] };
    });
  });

  it("locks the row, rechecks impact, and records one change_log row for each changed field", async () => {
    const acknowledgement = await previewAliasImpact(10, {
      aliasPrimary: ["EXAMPLE", "EXAMPLE JI"],
      aliasSecondary: "Example Person Ji",
    });
    await patchRegistryRow(
      10,
      { aliasPrimary: ["EXAMPLE", "EXAMPLE JI"], aliasSecondary: "Example Person Ji" },
      {
        changedBy: "Nishant",
        reason: "Add verified register spelling",
        acknowledgedImpact: acknowledgement!,
      },
    );

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM person_registry WHERE id = $1 FOR UPDATE"),
      [10],
    );
    const auditCalls = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO change_log"));
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls.map(([, params]) => params)).toEqual([
      ["10", "alias_primary", "[\"EXAMPLE\"]", "[\"EXAMPLE\",\"EXAMPLE JI\"]", "Nishant", "Add verified register spelling"],
      ["10", "alias_secondary", "Example Person", "Example Person Ji", "Nishant", "Add verified register spelling"],
    ]);
    expect(mocks.query).toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects an acknowledgement replayed against different aliases even when the impact totals are unchanged", async () => {
    const acknowledgement = await previewAliasImpact(10, {
      aliasPrimary: ["EXAMPLE", "EXAMPLE JI"],
    });

    await expect(patchRegistryRow(
      10,
      { aliasPrimary: ["EXAMPLE", "EXAMPLE SIR"] },
      {
        changedBy: "Nishant",
        reason: "Add verified register spelling",
        acknowledgedImpact: acknowledgement!,
      },
    )).rejects.toBeInstanceOf(RegistryImpactChangedError);
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE person_registry"), expect.anything());
  });

  it("rejects an alias save with no impact acknowledgement", async () => {
    await expect(patchRegistryRow(
      10,
      { aliasPrimary: ["EXAMPLE", "EXAMPLE JI"] },
      { changedBy: "Nishant", reason: "Add verified register spelling" },
    )).rejects.toBeInstanceOf(RegistryImpactRequiredError);
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE person_registry"), expect.anything());
  });
});