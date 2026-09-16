import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import apiKeysRouter from "./apiKeys.js";

describe("API-key router scoping", () => {
  it("does not intercept an unrelated protected route", async () => {
    const app = express();
    app.use(apiKeysRouter);
    app.post("/ai/full-report/growth", (_req, res) => res.status(204).end());

    const response = await request(app).post("/ai/full-report/growth");

    expect(response.status).toBe(204);
  });

  it("keeps API-key administration behind the admin gate", async () => {
    const app = express();
    app.use(apiKeysRouter);

    const response = await request(app).get("/keys");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Administrator access required" });
  });
});