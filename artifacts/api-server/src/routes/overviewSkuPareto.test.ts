import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { GetOverviewSkuParetoQueryParams } from "@workspace/api-zod";
import { currentOpenFy } from "../lib/fyAnchors.js";
import router, { validateSkuParetoRangeParams } from "./overviewSkuPareto.js";

describe("overview SKU Pareto query contract", () => {
  it("accepts integer month bounds and rejects fractional values", () => {
    expect(GetOverviewSkuParetoQueryParams.safeParse({ monthFrom: "1.5", monthTo: "6" }).success).toBe(false);
    expect(GetOverviewSkuParetoQueryParams.safeParse({ monthFrom: "1", monthTo: "6" }).success).toBe(true);
    expect(validateSkuParetoRangeParams(1, 6)).toBeNull();
    expect(validateSkuParetoRangeParams(1.5, 6)).toContain("integer");
    expect(validateSkuParetoRangeParams(1, 6.25)).toContain("integer");
  });

  it("rejects reversed ranges instead of clamping them", () => {
    expect(validateSkuParetoRangeParams(8, 3)).toContain("less than or equal");
  });

  it("accepts omitted bounds for dynamic open/closed FY defaults", () => {
    expect(validateSkuParetoRangeParams(undefined, undefined)).toBeNull();
  });

  it("returns structured 400 when an omitted open-FY end is before explicit monthFrom", async () => {
    const app = express();
    app.use(router);
    const response = await request(app)
      .get("/overview/sku-pareto")
      .query({ fy: currentOpenFy(), monthFrom: "12" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "monthFrom and monthTo must be integers from 1 to 12 with monthFrom <= monthTo",
    });
  });
});