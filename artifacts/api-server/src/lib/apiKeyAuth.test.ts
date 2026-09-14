import { describe, expect, it, vi } from "vitest";
import {
  isVerificationEndpoint,
  isExternalReadEndpoint,
  isExternalReadPath,
  requireExternalReadEndpointAccess,
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

describe("external read API-key authorization", () => {
  it.each([
    ["GET", "/external/sales-by-item"],
    ["GET", "/external/margin-by-item"],
    ["GET", "/api/external/sales-by-item"],
    ["GET", "/sales-by-item"],
    ["GET", "/margin-by-item"],
    ["GET", "/remounted/elsewhere/sales-by-item"],
  ])("recognizes only the approved %s %s endpoint", (method, path) => {
    expect(isExternalReadEndpoint({ method, path } as any)).toBe(true);
  });

  it.each([
    ["POST", "/external/sales-by-item"],
    ["GET", "/external/sales-by-item/"],
    ["GET", "/external/other"],
    ["DELETE", "/external/margin-by-item"],
  ])("rejects %s %s", (method, path) => {
    expect(isExternalReadEndpoint({ method, path } as any)).toBe(false);
  });

  it("recognizes the path independently of method so POST cannot widen access", () => {
    expect(isExternalReadPath({ path: "/external/sales-by-item" } as any)).toBe(true);
    expect(isExternalReadPath({ path: "/external/sales-by-item/" } as any)).toBe(false);
  });

  it("accepts only an external_read key, never a verification/full key or secret", () => {
    const next = vi.fn();
    const allowedResponse = response();
    requireExternalReadEndpointAccess(
      { method: "GET", path: "/sales-by-item", apiKey: { id: 1, name: "reader", scope: "external_read" } } as any,
      allowedResponse as any,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);

    for (const req of [
      { method: "GET", path: "/external/sales-by-item", apiKey: { id: 2, name: "full", scope: "full_api" } },
      { method: "GET", path: "/external/sales-by-item", apiKey: { id: 3, name: "verification", scope: "verification" } },
      { method: "GET", path: "/external/sales-by-item", headers: { "x-admin-secret": "operator-secret" } },
      { method: "POST", path: "/external/sales-by-item", apiKey: { id: 1, name: "reader", scope: "external_read" } },
    ]) {
      const deniedResponse = response();
      requireExternalReadEndpointAccess(req as any, deniedResponse as any, next);
      expect(deniedResponse.status).toHaveBeenCalledWith(req.apiKey ? 403 : 401);
    }
    expect(next).toHaveBeenCalledTimes(1);
  });
});