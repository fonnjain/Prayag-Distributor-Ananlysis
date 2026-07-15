import { Router } from "express";
import { db } from "@workspace/db";
import { apiKeys } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { generateRawKey, hashKey, keyPrefix } from "../lib/apiKeyAuth";

const router = Router();

// List all keys (hashes never returned)
router.get("/keys", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        description: apiKeys.description,
        prefix: apiKeys.prefix,
        isRevoked: apiKeys.isRevoked,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .orderBy(apiKeys.createdAt);

    res.json({ keys: rows });
  } catch (err) {
    req.log.error({ err }, "GET /keys failed");
    res.status(500).json({ error: "Could not load API keys" });
  }
});

// Create a new key — raw key returned exactly once
router.post("/keys", async (req, res) => {
  const name: unknown = req.body?.name;
  const description: unknown = req.body?.description;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (name.trim().length > 120) {
    res.status(400).json({ error: "name must be 120 characters or fewer" });
    return;
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    res.status(400).json({ error: "description must be a string of 500 characters or fewer" });
    return;
  }

  try {
    const raw = generateRawKey();
    const hash = hashKey(raw);
    const prefix = keyPrefix(raw);

    const [row] = await db
      .insert(apiKeys)
      .values({ name, description, keyHash: hash, prefix })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        description: apiKeys.description,
        prefix: apiKeys.prefix,
        isRevoked: apiKeys.isRevoked,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      });

    // Raw key only appears here — never stored, never returned again
    res.json({ key: row, rawKey: raw });
  } catch (err) {
    req.log.error({ err }, "POST /keys failed");
    res.status(500).json({ error: "Could not create API key" });
  }
});

// Revoke a key
router.delete("/keys/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid key id" });
    return;
  }

  try {
    const [row] = await db
      .update(apiKeys)
      .set({ isRevoked: true, revokedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id });

    if (!row) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    res.json({ ok: true, id: row.id });
  } catch (err) {
    req.log.error({ err }, "DELETE /keys/:id failed");
    res.status(500).json({ error: "Could not revoke API key" });
  }
});

export default router;
