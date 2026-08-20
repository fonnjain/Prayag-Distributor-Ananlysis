import { describe, expect, it } from "vitest";
import { fetchCoverageDrift } from "../coverageDriftApi";

describe("fetchCoverageDrift", () => {
  it("accepts the complete history payload returned with drift status 409", async () => {
    const payload = {
      passed: false,
      events: [{
        event_id: "42",
        detail: {
          issues: [{
            kind: "evidence-mismatch",
            fiscalYear: "2025-26",
            detail: { review: { difference: { netAmount: 38810 } } },
          }],
        },
      }],
    };
    const request: typeof fetch = async () => new Response(JSON.stringify(payload), {
      status: 409,
      headers: { "content-type": "application/json" },
    });

    await expect(fetchCoverageDrift<typeof payload>("/api/master/coverage-drift", request))
      .resolves.toEqual(payload);
  });

  it("still rejects ordinary transport failures", async () => {
    const request: typeof fetch = async () => new Response("unauthorized", { status: 401 });

    await expect(fetchCoverageDrift("/api/master/coverage-drift", request))
      .rejects.toThrow("401");
  });
});