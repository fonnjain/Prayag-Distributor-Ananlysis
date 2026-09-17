import { afterEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { connect } }));

import { commitJulyRetrospectiveProvenance } from "./jul26RetrospectiveProvenance.js";

describe("July retrospective provenance transaction", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("writes one provenance row and never mutates July SKU or mirror rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T13:00:00.123Z"));

    let committedProvenance = 0;
    let pendingProvenance = 0;
    const query = vi.fn(async (statement: string, params?: unknown[]) => {
      const sql = String(statement).replace(/\s+/g, " ").trim();
      if (sql === "BEGIN") {
        pendingProvenance = 0;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        committedProvenance += pendingProvenance;
        pendingProvenance = 0;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        pendingProvenance = 0;
        return { rows: [] };
      }
      if (
        sql.includes("pg_advisory_xact_lock") ||
        sql.startsWith("LOCK TABLE")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM secondary_sku_load_provenance") &&
        sql.includes("COUNT(*)")
      ) {
        return { rows: [{ rows: committedProvenance + pendingProvenance }] };
      }
      if (
        sql.includes("FROM secondary_sku_line") &&
        sql.includes("COUNT(*)")
      ) {
        return { rows: [{ rows: 34_147, net: "223436806" }] };
      }
      if (
        sql.includes("FROM secondary_register_line") &&
        sql.includes("COUNT(*)")
      ) {
        expect(params?.[2]).toBe("pscode3_brand_rollup");
        return { rows: [{ rows: 34_147, net: "223436806" }] };
      }
      if (sql.startsWith("INSERT INTO secondary_sku_load_provenance")) {
        pendingProvenance += 1;
        expect(params?.[4]).toBe("2026-08-24T12:10:23.752064Z");
        expect(params?.[6]).toBe(34_147);
        expect(params?.[7]).toBe(223_436_806);
        expect(params?.[8]).toBe("pscode3_xlsx");
        expect(JSON.parse(String(params?.[9]))).toMatchObject({
          retrospective: true,
          metadataOnly: true,
          dataTablesWritten: [],
          originalTimestampEvidence: {
            earliest: "2026-08-24T12:10:23.752064Z",
            latest: "2026-08-24T12:10:23.752064Z",
          },
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
    const release = vi.fn();
    connect.mockResolvedValue({ query, release });

    const input = {
      originalLoadedAt: "2026-08-24T12:10:23.752064Z",
      recordedBy: "reviewer",
      sourceNote: "Production ledger evidence independently verified.",
    };
    const result = await commitJulyRetrospectiveProvenance(input);

    expect(result.before).toEqual({
      sku: { rows: 34_147, net: 223_436_806 },
      mirror: { rows: 34_147, net: 223_436_806 },
    });
    expect(result.after).toEqual(result.before);
    expect(result.originalLoadedAt).toBe(input.originalLoadedAt);
    expect(committedProvenance).toBe(1);

    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(
      sqls.filter((sql) =>
        sql.includes("INSERT INTO secondary_sku_load_provenance"),
      ),
    ).toHaveLength(1);
    expect(
      sqls.some((sql) =>
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+secondary_(?:sku|register)_line\b/i.test(
          sql,
        ),
      ),
    ).toBe(false);
    expect(sqls).toContain("LOCK TABLE secondary_sku_line IN SHARE MODE");
    expect(sqls).toContain(
      "LOCK TABLE secondary_register_line IN SHARE MODE",
    );
    expect(release).toHaveBeenCalledOnce();

    await expect(
      commitJulyRetrospectiveProvenance(input),
    ).rejects.toThrow("a provenance record already exists");
    expect(committedProvenance).toBe(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});