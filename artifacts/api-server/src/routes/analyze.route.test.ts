import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: { messages: { create } } }));
vi.mock("../lib/fyAnchors.js", () => ({ currentOpenFy: () => "2026-27" }));
vi.mock("../lib/mgmt/graph/graphIndex.js", () => ({
  buildGraphIndex: vi.fn(async () => ({ fy: "2026-27", generatedAt: "now", levels: [], fys: [], gapNodes: [], crossFyKeySplits: [], companyResiduals: [], notes: [] })),
  graphIndexToPromptText: vi.fn(() => "bounded"),
}));
vi.mock("../lib/mgmt/graph/resolvers.js", () => ({
  normalizeGraphNode: (node: unknown) => node,
  resolvePath: vi.fn(async () => ({
    error: null,
    node: {
      path: "company/2026-27", level: "company", fy: "2026-27", name: "x",
      measures: [{ measure: "primary_sale", label: "Primary Dispatch", value: 10_000_000, unit: "INR", availability: "measured" }],
      detail: { nested: { measure: "primary_sale", label: "Nested dispatch", value: 1_000_000, unit: "INR", availability: "measured" } },
      population: "test", source: "test", cutoff: "test", readTime: "now",
      flags: [], parent: null, children: [], childrenSumToParent: null, isGap: false,
    },
  })),
  resolveWildcard: vi.fn(async () => ({ nodes: [], errors: [] })),
}));

import analyzeRouter from "./analyze.js";

const app = express();
app.use(express.json());
app.use(analyzeRouter);

describe("Prompt 115 numeric guard HTTP enforcement", () => {
  it("rejects fabricated INR output rather than returning a warning", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "resolve_nodes", input: { paths: ["company/2026-27"] } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "The figure is Rs 1 Cr, 1%, and 999 customers." }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Still fabricated: Rs 2 Cr." }] });
    const response = await request(app).post("/analyze").send({ question: "What is sales?" });
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("Numeric guard rejected");
  });

  it("rewrites one unsupported numeric draft into a safe bounded answer", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "retry1", name: "resolve_nodes", input: { paths: ["company/2026-27"] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I calculated an unsupported 11% difference." }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "That difference is unavailable as a typed measure.\\n\\n## Traversal\\n- `company/2026-27`" }],
      });
    const response = await request(app).post("/analyze").send({ question: "Calculate a difference." });
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("difference is unavailable");
  });

  it("accepts cited paths and valid top-level/nested abbreviated INR displays", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "resolve_nodes", input: { paths: ["company/2026-27"] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "company/2026-27 reports Rs 1.00 Cr and ₹10 Lakh." }],
      });
    const response = await request(app).post("/analyze").send({ question: "Give the cited sales." });
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("company/2026-27");
  });

  it("accepts calendar years alongside graph path citations", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t3", name: "resolve_nodes", input: { paths: ["company/2026-27"] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "April 2026: company/2026-27 PTMT margin is held pending resolution." }],
      });
    const response = await request(app).post("/analyze").send({ question: "What is PTMT margin for April 2026?" });
    expect(response.status).toBe(200);
  });

  it("accepts spaced and Unicode-dash fiscal years as temporal metadata", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t4", name: "resolve_nodes", input: { paths: ["company/2026-27"] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "For FY 2026–27, company/2026-27 PTMT margin is held pending resolution." }],
      });
    const response = await request(app).post("/analyze").send({ question: "What is held?" });
    expect(response.status).toBe(200);
  });
});
