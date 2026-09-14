import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { connect } }));

import resolutionItemsRouter from "./resolutionItems.js";

function closedRow() {
  return {
    id: 9,
    code: "P9",
    type: "PENDING",
    title: "Variance accepted",
    category: "data quality",
    fiscal_year: "2024-25",
    month: null,
    scope_product: null,
    scope_measure: null,
    reason: "Recorded for completeness.",
    evidence: "[Source: Prompt 88 extended] 4 rows missing.",
    value_at_stake: "5595",
    raised_on: "2026-09-14",
    raised_by: "Prompt 88 extended",
    owner: "Prayag",
    status: "answered",
    resolved_on: "2026-09-14",
    resolved_by: "Prompt 88 extended",
    resolution_note: "Answered: variance accepted and recorded for completeness.",
    blocks_api: false,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUser = {
    id: 1,
    email: "admin@example.com",
    displayName: "Administrator",
    role: "admin",
    isActive: true,
    mustChangePassword: false,
  };
  next();
});
app.use(resolutionItemsRouter);

describe("resolution item PATCH immutability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks then rejects a closed row without UPDATE or audit", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [closedRow()] }) // SELECT ... FOR UPDATE
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    connect.mockResolvedValue(client);

    const response = await request(app)
      .patch("/resolution-items/9")
      .send({ title: "Attempted rewrite" });

    expect(response.status).toBe(409);
    expect(response.body.item.resolutionNote).toContain("variance accepted");
    const sqls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls[1]).toContain("SELECT * FROM resolution_item WHERE id = $1 FOR UPDATE");
    expect(sqls.some((sql) => sql.includes("UPDATE resolution_item"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("INSERT INTO auth_audit"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});