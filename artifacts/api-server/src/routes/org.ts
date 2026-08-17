// Organisation — DS1: State Heads model.
//
// Rules enforced here:
// - No hard deletes where transactional data exists. "Remove" marks LEFT.
// - Alias check prevents duplicate creation (Sandeep Ji → Sandeep Dadheech).
// - Seed is idempotent — safe to call twice.
// - Google Drive is NEVER written.
import { Router } from "express";
import { db } from "@workspace/db";
import {
  orgStateHeads,
  orgHeadAliases,
  orgHeadAudit,
  orgHeadFlags,
  type OrgStateHead,
  type OrgHeadAlias,
  type OrgHeadFlag,
} from "@workspace/db";
import { eq, ilike, or, desc, isNull } from "drizzle-orm";
import { SEED_HEADS, SEED_FLAGS } from "../lib/org/seedData.js";
import { loadRoster, loadRosterHealth } from "../lib/mgmt/roster.js";
import {
  seedPersonRegistry,
  getRegistryRows,
  patchRegistryRow,
  previewAliasImpact,
  loadPersonRegistry,
} from "../lib/personRegistry.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function appendAudit(
  headId: string,
  action: string,
  detail: Record<string, unknown>,
  changedBy?: string,
) {
  await db.insert(orgHeadAudit).values({ headId, action, detail, changedBy: changedBy ?? null });
}

// Build the enriched response for a head (DB row + live member count + aliases + flags).
type HeadRow = OrgStateHead & {
  aliases: OrgHeadAlias[];
  flags: OrgHeadFlag[];
  memberCount: number;
};

// ── GET /api/org/state-heads ──────────────────────────────────────────────────
// Returns all state heads enriched with live member counts (from roster).

router.get("/org/state-heads", async (req, res) => {
  try {
    const [heads, aliases, flags, roster] = await Promise.all([
      db.select().from(orgStateHeads).orderBy(orgStateHeads.displayName),
      db.select().from(orgHeadAliases),
      db.select().from(orgHeadFlags).orderBy(desc(orgHeadFlags.createdAt)),
      loadRoster().catch(() => null),
    ]);

    // Build member counts from the live roster.
    const memberCounts = new Map<string, number>();
    if (roster) {
      for (const m of roster.members) {
        const head = m.stateHead.trim();
        if (!head) continue;
        memberCounts.set(head.toLowerCase(), (memberCounts.get(head.toLowerCase()) ?? 0) + 1);
      }
    }

    // Match roster counts to DB heads by normalised display name or aliases.
    const aliasesByHead = new Map<string, OrgHeadAlias[]>();
    for (const a of aliases) {
      const list = aliasesByHead.get(a.headId) ?? [];
      list.push(a);
      aliasesByHead.set(a.headId, list);
    }
    const flagsByHead = new Map<string | null, OrgHeadFlag[]>();
    const globalFlags: OrgHeadFlag[] = [];
    for (const f of flags) {
      if (f.headId === null) { globalFlags.push(f); continue; }
      const list = flagsByHead.get(f.headId) ?? [];
      list.push(f);
      flagsByHead.set(f.headId, list);
    }

    const enriched: HeadRow[] = heads.map((h) => {
      const headAliases = aliasesByHead.get(h.id) ?? [];
      // Try to match by display name first, then aliases.
      const nameLower = h.displayName.toLowerCase();
      let count = memberCounts.get(nameLower) ?? 0;
      if (!count) {
        for (const a of headAliases) {
          count = memberCounts.get(a.alias.toLowerCase()) ?? 0;
          if (count) break;
        }
      }
      return {
        ...h,
        aliases: headAliases,
        flags: flagsByHead.get(h.id) ?? [],
        memberCount: count,
      };
    });

    const seeded = heads.length > 0;
    const totalMembers = enriched.reduce((s, h) => s + h.memberCount, 0);

    res.json({ heads: enriched, globalFlags, seeded, totalMembers });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/org/roster-health ───────────────────────────────────────────────
// Read-only roster-health panel computed from hr_roster.csv (Sales_User_List):
// Active/Deactive counts, coverage %, Order Type breakdown, bad-employee-code
// names, the shared-placeholder-code pair, the name-reversed possible duplicate
// flagged for review, and Reporting Managers that resolve to no row. Advisory
// only — nothing here auto-fixes or merges.

router.get("/org/roster-health", async (_req, res) => {
  try {
    const health = loadRosterHealth();
    if (!health) {
      return res.status(503).json({ error: "roster CSV unavailable" });
    }
    return res.json(health);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/org/state-heads/alias-check ─────────────────────────────────────
// Checks whether a name already exists as a head display name or an alias.
// Used by the "Add" form to prevent duplicate creation.
//
// Returns:
//   { matches: [{ id, displayName, matchType: "name" | "alias", alias? }] }

router.get("/org/state-heads/alias-check", async (req, res) => {
  const raw = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (raw.length < 2) return res.json({ matches: [] });

  const norm = normalise(raw);
  try {
    const [nameMatches, aliasMatches] = await Promise.all([
      db
        .select()
        .from(orgStateHeads)
        .where(ilike(orgStateHeads.displayName, `%${norm}%`))
        .limit(5),
      db
        .select({ alias: orgHeadAliases, head: orgStateHeads })
        .from(orgHeadAliases)
        .innerJoin(orgStateHeads, eq(orgHeadAliases.headId, orgStateHeads.id))
        .where(ilike(orgHeadAliases.alias, `%${norm}%`))
        .limit(5),
    ]);

    const seen = new Set<string>();
    const matches: Array<{
      id: string;
      displayName: string;
      matchType: "name" | "alias";
      alias?: string;
    }> = [];

    for (const h of nameMatches) {
      if (!seen.has(h.id)) {
        seen.add(h.id);
        matches.push({ id: h.id, displayName: h.displayName, matchType: "name" });
      }
    }
    for (const row of aliasMatches) {
      if (!seen.has(row.head.id)) {
        seen.add(row.head.id);
        matches.push({
          id: row.head.id,
          displayName: row.head.displayName,
          matchType: "alias",
          alias: row.alias.alias,
        });
      }
    }

    return res.json({ matches });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/org/state-heads/audit ───────────────────────────────────────────
// Returns the 50 most recent audit entries.

router.get("/org/state-heads/audit", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(orgHeadAudit)
      .orderBy(desc(orgHeadAudit.changedAt))
      .limit(50);
    res.json({ entries: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/org/state-heads ─────────────────────────────────────────────────
// Creates a new state head. Caller should first run alias-check; this route
// trusts the caller made an informed decision to create rather than link.

router.post("/org/state-heads", async (req, res) => {
  const { displayName, status, effectiveFrom, hq, notes, changedBy } = req.body as {
    displayName?: string;
    status?: string;
    effectiveFrom?: string;
    hq?: string;
    notes?: string;
    changedBy?: string;
  };

  if (!displayName?.trim()) {
    return res.status(400).json({ error: "displayName is required" });
  }
  if (status && !["active", "left", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be active | left | inactive" });
  }

  const id = toSlug(displayName.trim());

  // Collision guard.
  const existing = await db
    .select({ id: orgStateHeads.id })
    .from(orgStateHeads)
    .where(eq(orgStateHeads.id, id))
    .limit(1);
  if (existing.length) {
    return res.status(409).json({ error: `A state head with slug '${id}' already exists.` });
  }

  try {
    const [head] = await db
      .insert(orgStateHeads)
      .values({
        id,
        displayName: displayName.trim(),
        status: (status as "active" | "left" | "inactive") ?? "active",
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
        hq: hq ?? null,
        notes: notes ?? null,
      })
      .returning();

    await appendAudit(id, "created", { displayName: displayName.trim(), status }, changedBy);

    return res.status(201).json({ head });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── PATCH /api/org/state-heads/:id ───────────────────────────────────────────
// Update status, notes, hq, effectiveTo, or add an alias.
// Marking status="left" auto-sets effectiveTo if not supplied.

router.patch("/org/state-heads/:id", async (req, res) => {
  const { id } = req.params;
  const { status, effectiveTo, hq, notes, addAlias, aliasedFySeen, acknowledgeFlag, resolveFlag, changedBy } = req.body as {
    status?: string;
    effectiveTo?: string;
    hq?: string;
    notes?: string;
    addAlias?: string;
    aliasedFySeen?: string;
    acknowledgeFlag?: number;
    resolveFlag?: number;
    changedBy?: string;
  };

  const [existing] = await db
    .select()
    .from(orgStateHeads)
    .where(eq(orgStateHeads.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ error: `State head '${id}' not found` });
  }

  try {
    const updates: Partial<OrgStateHead> = { updatedAt: new Date() };

    if (status && status !== existing.status) {
      if (!["active", "left", "inactive"].includes(status)) {
        return res.status(400).json({ error: "status must be active | left | inactive" });
      }
      updates.status = status as "active" | "left" | "inactive";
      if (status === "left" && !effectiveTo) {
        updates.effectiveTo = new Date();
      }
      await appendAudit(id, "status_changed", { from: existing.status, to: status }, changedBy);
    }

    if (effectiveTo !== undefined) {
      updates.effectiveTo = effectiveTo ? new Date(effectiveTo) : null;
    }
    if (hq !== undefined) updates.hq = hq;
    if (notes !== undefined) {
      updates.notes = notes;
      await appendAudit(id, "notes_updated", { notes }, changedBy);
    }

    const [head] = await db
      .update(orgStateHeads)
      .set(updates)
      .where(eq(orgStateHeads.id, id))
      .returning();

    // Add alias if requested.
    let newAlias: OrgHeadAlias | null = null;
    if (addAlias?.trim()) {
      const [a] = await db
        .insert(orgHeadAliases)
        .values({ headId: id, alias: addAlias.trim(), fySeen: aliasedFySeen ?? null })
        .returning();
      newAlias = a;
      await appendAudit(id, "alias_added", { alias: addAlias.trim(), fySeen: aliasedFySeen ?? null }, changedBy);
    }

    // Acknowledge or resolve a flag.
    if (acknowledgeFlag) {
      await db
        .update(orgHeadFlags)
        .set({ status: "acknowledged" })
        .where(eq(orgHeadFlags.id, acknowledgeFlag));
    }
    if (resolveFlag) {
      await db
        .update(orgHeadFlags)
        .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: changedBy ?? null })
        .where(eq(orgHeadFlags.id, resolveFlag));
    }

    return res.json({ head, newAlias });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/org/seed ────────────────────────────────────────────────────────
// Idempotent seed from the confirmed business data.
// Skips heads that already exist; skips flags that already exist for that head+type.
// NEVER writes to Google Drive.

router.post("/org/seed", async (req, res) => {
  try {
    const existing = await db.select({ id: orgStateHeads.id }).from(orgStateHeads);
    const existingIds = new Set(existing.map((r) => r.id));

    const created: string[] = [];
    const skipped: string[] = [];

    // Load existing aliases once so we can do an idempotent alias upsert for
    // both new and already-existing heads.
    const existingAliasRows = await db
      .select({ headId: orgHeadAliases.headId, alias: orgHeadAliases.alias })
      .from(orgHeadAliases);
    const existingAliasKeys = new Set(
      existingAliasRows.map((r) => `${r.headId}|${r.alias.toLowerCase()}`),
    );

    let aliasesAdded = 0;

    for (const s of SEED_HEADS) {
      if (existingIds.has(s.id)) {
        skipped.push(s.displayName);
        // Still check for missing aliases on existing heads.
        for (const a of s.aliases ?? []) {
          const key = `${s.id}|${a.alias.toLowerCase()}`;
          if (!existingAliasKeys.has(key)) {
            await db.insert(orgHeadAliases).values({
              headId: s.id,
              alias: a.alias,
              fySeen: a.fySeen,
            });
            await appendAudit(s.id, "alias_added", {
              alias: a.alias,
              fySeen: a.fySeen,
              source: "seed-backfill",
            });
            existingAliasKeys.add(key);
            aliasesAdded++;
          }
        }
        continue;
      }

      await db.insert(orgStateHeads).values({
        id: s.id,
        displayName: s.displayName,
        status: s.status,
        hq: s.hq ?? null,
        isDualRole: s.isDualRole ?? false,
        dualRoleDetail: s.dualRoleDetail ?? null,
        sheetRowRef: s.sheetRowRef ?? null,
        seededAt: new Date(),
      });

      if (s.aliases?.length) {
        await db.insert(orgHeadAliases).values(
          s.aliases.map((a) => ({ headId: s.id, alias: a.alias, fySeen: a.fySeen })),
        );
        aliasesAdded += s.aliases.length;
      }

      await appendAudit(s.id, "seeded", {
        displayName: s.displayName,
        status: s.status,
        memberCount: s.memberCount,
        source: "STATE HEAD DASHBOARD 2026-27, tab Data, header row 3",
      });

      created.push(s.displayName);
    }

    // Seed flags (idempotent by headId + flagType).
    const existingFlags = await db
      .select({ headId: orgHeadFlags.headId, flagType: orgHeadFlags.flagType })
      .from(orgHeadFlags);
    const flagKey = (f: { headId: string | null; flagType: string }) =>
      `${f.headId ?? "__global__"}|${f.flagType}`;
    const existingFlagKeys = new Set(existingFlags.map(flagKey));

    let flagsCreated = 0;
    for (const f of SEED_FLAGS) {
      const key = flagKey(f);
      if (existingFlagKeys.has(key)) continue;
      await db.insert(orgHeadFlags).values({
        headId: f.headId,
        flagType: f.flagType,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
      });
      flagsCreated++;
    }

    res.json({ created, skipped, flagsCreated, aliasesAdded });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Person Registry routes ────────────────────────────────────────────────────

// GET /api/person-registry — list all rows, ordered by state head first then name.
// Returns { rows, unseeded } — unseeded:true when the table has never been seeded.
router.get("/person-registry", async (_req, res) => {
  try {
    const rows = await getRegistryRows();
    res.json({ rows, unseeded: rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/person-registry/:id — update aliases on a registry row.
// Body: { aliasPrimary?, aliasSecondary?, aliasSheet?, stateHead?, flagNotes? }
router.patch("/person-registry/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const patch = req.body as {
      aliasPrimary?: string[];
      aliasSecondary?: string | null;
      aliasSheet?: string | null;
      stateHead?: string | null;
      flagNotes?: string | null;
    };
    const updated = await patchRegistryRow(id, patch);
    if (!updated) {
      res.status(404).json({ error: "Row not found or no fields to update" });
      return;
    }
    // Reload the in-memory maps so the change takes effect immediately.
    await loadPersonRegistry();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/person-registry/preview-impact — dry-run alias change.
// Body: { id: number, newAliases: string[] }
router.post("/person-registry/preview-impact", async (req, res) => {
  try {
    const { id, newAliases } = req.body as {
      id: number;
      newAliases: string[];
    };
    if (!id || !Array.isArray(newAliases)) {
      res.status(400).json({ error: "id and newAliases are required" });
      return;
    }
    const impact = await previewAliasImpact(id, newAliases);
    res.json(impact);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/person-registry/seed — one-time seed from JSON config + HR CSV.
// Idempotent: safe to call twice (ON CONFLICT DO NOTHING).
// After seeding, propagates state_head from the Phase 1 person table and
// triggers a full secondary_sku_line.state_canon backfill so both operations
// are covered in the natural fresh-deploy sequence:
//   masterSeedImport (person table) → this endpoint (registry + reconciliation + SKU backfill)
router.post("/person-registry/seed", async (_req, res) => {
  try {
    const report = await seedPersonRegistry();
    // Reload maps after seeding.
    await loadPersonRegistry();

    // Propagate state_head from the Phase 1 person table into person_registry.
    // This is the authoritative reconciliation path on fresh deployments where
    // migration 034 fires before the person table is populated.
    const { reconcilePersonRegistryStateHeads } = await import(
      "../lib/personRegistry.js"
    );
    const reconcileResult = await reconcilePersonRegistryStateHeads();

    // Backfill secondary_sku_line.state_canon now that registy state heads exist.
    const { backfillSkuStateCanon } = await import(
      "../lib/secondary/skuLoader.js"
    );
    const skuBackfillUpdated = await backfillSkuStateCanon();

    res.json({ ok: true, ...report, reconcileResult, skuBackfillUpdated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
