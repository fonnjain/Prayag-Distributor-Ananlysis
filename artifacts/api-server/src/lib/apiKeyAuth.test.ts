import { describe, expect, it, vi } from "vitest";
import {
  isVerificationEndpoint,
  requireVerificationEndpointAccess,
  verificationKeyFingerprint,
} from "./apiKeyAuth.js";

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

describe("verification service identity authorization", () => {
  it("uses a hash-derived fingerprint instead of exposing raw credential characters", () => {
    expect(verificationKeyFingerprint("abcdef0123456789")).toBe("vrf_abcdef012345");
  });

  it.each([
    ["GET", "/verify"],
    ["GET", "/mgmt/verify"],
    ["GET", "/audit"],
    ["GET", "/audit/download"],
  ])("allows the approved %s %s endpoint", (method, path) => {
    expect(isVerificationEndpoint({ method, path } as any)).toBe(true);
  });

  it.each([
    ["POST", "/verify"],
    ["GET", "/verify/backfill"],
    ["GET", "/healthz"],
    ["GET", "/customers"],
    ["DELETE", "/audit"],
  ])("does not authorize %s %s", (method, path) => {
    expect(isVerificationEndpoint({ method, path } as any)).toBe(false);
  });

  it("accepts browser sessions and the verification identity only", () => {
    const next = vi.fn();
    const sessionRes = response();
    requireVerificationEndpointAccess({ authUser: { id: 1 } } as any, sessionRes as any, next);
    expect(next).toHaveBeenCalledTimes(1);

    const verificationRes = response();
    requireVerificationEndpointAccess(
      { apiKey: { id: 2, name: "verification", scope: "verification" } } as any,
      verificationRes as any,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);

    for (const req of [
      { apiKey: { id: 3, name: "ordinary", scope: "full_api" } },
      { headers: { "x-admin-secret": "operator-secret" } },
      {},
    ]) {
      const res = response();
      requireVerificationEndpointAccess(req as any, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
    }
    expect(next).toHaveBeenCalledTimes(2);
  });
});