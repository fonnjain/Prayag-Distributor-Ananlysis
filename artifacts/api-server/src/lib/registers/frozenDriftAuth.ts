import type { Request, Response } from "express";
import { isAdminToken } from "../adminAuth.js";

/**
 * Frozen drift exposes invoice-level evidence and an exceptional frozen-month
 * mutation path. It therefore requires an administrator session or the
 * dedicated operator secret; API keys and ordinary sessions are insufficient.
 */
export function requireFrozenDriftAdmin(req: Request, res: Response): boolean {
  if (req.authUser?.role === "admin") return true;
  if (isAdminToken(req.get("X-Admin-Secret") ?? "")) return true;
  if (!req.authUser && !req.apiKey) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  res.status(403).json({ error: "Administrator access required" });
  return false;
}