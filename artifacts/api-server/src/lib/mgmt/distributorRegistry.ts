// Distributor identity registry — one identity per distributor so
// concentration figures can't be quietly wrong.
//
// Extends the member IdentityRegistry model to distributors:
//   • DIST# is the ONLY merge key. Two rows with different DIST# are
//     different distributors, ALWAYS, even with identical names. One DIST#
//     with several name spellings is ONE distributor.
//   • Where no DIST# exists, identity is name AND state AND district.
//   • An ambiguous name lookup returns EVERY candidate with its
//     distinguishing fields — never a silent first match.
//   • NOTHING is ever auto-merged on similarity. Candidate pairs are
//     reported (with ID, state, district, value) for a human to decide;
//     pairs that both transact in the same period are automatically marked
//     RESOLVED-DIFFERENT (separate rows in the same period disprove a merge).
//
// Persistence: the "Retailer-Distributor Data" workbook Distributor tab
// (DIST#, name, Billing State, Billing District) is synced into the
// distributor_identity table so DIST# is no longer memory-only.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger.js";
import { readAllTabRows } from "../registers/sheetsApi.js";
import { normDistKey, jaccardTrigram } from "./distributorDeepDive.js";
import { stripLocationSuffix } from "./distributorTabs.js";
import { normaliseStateCanon } from "../stateCanon.js";

/** Canonical-state agreement (both sides normalised through stateCanon). */
function statesAgree(a: string, b: string): boolean {
  const ca = normaliseStateCanon(a.toUpperCase()) ?? a.toUpperCase();
  const cb = normaliseStateCanon(b.toUpperCase()) ?? b.toUpperCase();
  return ca === cb;
}

// Same workbook the dashboard reads (see lib/dashboard/sync.ts).
const RETAILER_DISTRIBUTOR_ROSTER = "1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc";
const DISTRIBUTOR_TAB = "Distributor";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DistributorRecord = {
  /** "DIST#12345" or null when the distributor has no stable ID. */
  distId: string | null;
  /** Name exactly as the source spells it — display only. */
  name: string;
  /** normDistKey(name) — grouping key, never a merge key on its own. */
  normKey: string;
  state: string | null;
  district: string | null;
  source: string;
};

export type DistResolveResult =
  | { kind: "found"; record: DistributorRecord }
  | {
      kind: "ambiguous";
      candidates: DistributorRecord[];
      message: string;
    }
  | { kind: "not_found" };

export type DistributorAlias = {
  distId: string;
  /** Spelling exactly as the source uses it. */
  alias: string;
  /** normDistKey(alias). */
  normKey: string;
  source: string;
};

export class DistributorRegistry {
  private readonly byId = new Map<string, DistributorRecord>();
  private readonly byNormKey = new Map<string, DistributorRecord[]>();
  readonly records: DistributorRecord[];
  readonly aliases: DistributorAlias[];
  readonly loadedAt: number;

  constructor(records: DistributorRecord[], aliases: DistributorAlias[] = []) {
    this.records = records;
    this.aliases = aliases;
    this.loadedAt = Date.now();
    for (const r of records) {
      if (r.distId) this.byId.set(r.distId.toUpperCase(), r);
      const list = this.byNormKey.get(r.normKey) ?? [];
      list.push(r);
      this.byNormKey.set(r.normKey, list);
    }
    // Aliases: other sources' spellings resolve to the SAME identity record.
    // The alias only ever points at a DIST# — never at another name.
    for (const a of aliases) {
      const rec = this.byId.get(a.distId.toUpperCase());
      if (!rec) continue;
      const list = this.byNormKey.get(a.normKey) ?? [];
      if (!list.includes(rec)) list.push(rec);
      this.byNormKey.set(a.normKey, list);
    }
  }

  /** All records sharing a normKey (empty array when none). */
  candidatesFor(normKey: string): DistributorRecord[] {
    return this.byNormKey.get(normKey) ?? [];
  }

  /**
   * Resolve a raw distributor name (or DIST# string) to one record.
   *  1. Explicit "DIST#…" in the input → definitive ID lookup.
   *  2. normDistKey(name) → candidates.
   *  3. Disambiguate by context.state, then context.district.
   *  4. Still >1 distinct identity → Ambiguous, naming every candidate.
   * Two candidates are DISTINCT identities when their DIST# differ, or when
   * (lacking an ID) their state or district differ. Same-identity duplicates
   * (spelling variants under one DIST#) resolve silently.
   */
  resolve(
    input: string,
    context?: { state?: string | null; district?: string | null },
  ): DistResolveResult {
    const raw = input.trim();
    if (!raw) return { kind: "not_found" };
    const idMatch = raw.match(/\b(DIST#\d+)\b/i);
    if (idMatch) {
      const hit = this.byId.get(idMatch[1].toUpperCase());
      return hit ? { kind: "found", record: hit } : { kind: "not_found" };
    }
    let candidates = dedupeIdentities(this.byNormKey.get(normDistKey(raw)) ?? []);
    if (candidates.length === 0) return { kind: "not_found" };
    if (candidates.length === 1) return { kind: "found", record: candidates[0] };

    if (context?.state) {
      const cs = normaliseStateCanon(String(context.state).toUpperCase()) ?? String(context.state).toUpperCase();
      const m = candidates.filter(
        (c) => c.state && (normaliseStateCanon(c.state.toUpperCase()) ?? c.state.toUpperCase()) === cs,
      );
      if (m.length === 1) return { kind: "found", record: m[0] };
      if (m.length > 1) candidates = m;
    }
    if (context?.district) {
      const cd = String(context.district).trim().toUpperCase();
      const m = candidates.filter((c) => (c.district ?? "").trim().toUpperCase() === cd);
      if (m.length === 1) return { kind: "found", record: m[0] };
    }

    const list = candidates
      .map((c) => `"${c.name}" (${c.distId ?? "no DIST#"}${c.state ? `, ${c.state}` : ""}${c.district ? `, ${c.district}` : ""})`)
      .join("; ");
    return {
      kind: "ambiguous",
      candidates,
      message: `"${input}" matches ${candidates.length} distributor identities: ${list}. Provide state/district or a DIST# to disambiguate — never merged automatically.`,
    };
  }
}

/** Collapse spelling-variant rows of the SAME identity (same DIST#, or same
 *  name+state+district when neither has an ID). Different DIST# never merge. */
function dedupeIdentities(rows: DistributorRecord[]): DistributorRecord[] {
  const seen = new Map<string, DistributorRecord>();
  for (const r of rows) {
    const key = r.distId
      ? `id:${r.distId.toUpperCase()}`
      : `nk:${r.normKey}|${(r.state ?? "").toUpperCase()}|${(r.district ?? "").toUpperCase()}`;
    // Prefer a row that carries an ID/geography over a sparser duplicate.
    const prev = seen.get(key);
    if (!prev || (!prev.state && r.state)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ── Sync: workbook → distributor_identity table ───────────────────────────────

function cell(v: unknown): string {
  return String(v ?? "").trim();
}

/** Read the Retailer-Distributor Data workbook Distributor tab and upsert
 *  every DIST# row into distributor_identity. Returns rows written. */
export async function syncDistributorIdentity(): Promise<number> {
  const rows = await readAllTabRows(RETAILER_DISTRIBUTOR_ROSTER, DISTRIBUTOR_TAB);
  // Columns (header row 1): 0=ID, 1=Counter Name, 7=Billing State, 8=Billing District.
  let written = 0;
  for (const r of rows.slice(1)) {
    if (!r) continue;
    const distId = cell(r[0]).toUpperCase();
    const name = cell(r[1]);
    if (!distId.startsWith("DIST#") || !name) continue;
    const state = cell(r[7]) || null;
    const district = cell(r[8]) || null;
    await db.execute(sql`
      INSERT INTO distributor_identity (dist_id, name, norm_key, state, district, source, updated_at)
      VALUES (${distId}, ${name}, ${normDistKey(name)}, ${state}, ${district}, 'roster-workbook', now())
      ON CONFLICT (dist_id) DO UPDATE SET
        name = EXCLUDED.name, norm_key = EXCLUDED.norm_key,
        state = EXCLUDED.state, district = EXCLUDED.district,
        source = EXCLUDED.source, updated_at = now()
    `);
    written++;
  }
  logger.info({ written }, "distributorRegistry: workbook sync complete");
  return written;
}

/** Persist alternate spellings from the Party TM Map bridge as aliases mapped
 *  to their DIST#. Only rows that carry an explicit party ID qualify — the
 *  alias mapping itself is ID-anchored, never name-inferred. Non-fatal. */
export async function syncDistributorAliases(): Promise<number> {
  const { loadPartyBridge } = await import("./bridge.js");
  const bridge = await loadPartyBridge();
  if (bridge.status !== "ok") return 0;
  let written = 0;
  for (const row of bridge.rows) {
    const distId = String(row.partyId ?? "").toUpperCase();
    const alias = String(row.partyName ?? "").trim();
    if (!/^DIST#\d+$/.test(distId) || !alias) continue;
    await db.execute(sql`
      INSERT INTO distributor_identity_alias (dist_id, alias, norm_key, source, updated_at)
      VALUES (${distId}, ${alias}, ${normDistKey(alias)}, 'party-tm-bridge', now())
      ON CONFLICT (dist_id, norm_key) DO UPDATE SET
        alias = EXCLUDED.alias, source = EXCLUDED.source, updated_at = now()
    `);
    written++;
  }
  logger.info({ written }, "distributorRegistry: alias sync complete");
  return written;
}

// ── Loader (DB-backed, TTL-cached) ────────────────────────────────────────────

const TTL_MS = 15 * 60_000;
const SYNC_STALE_MS = 24 * 60 * 60_000;
let cached: DistributorRegistry | null = null;
let cachedUntil = 0;
let inFlight: Promise<DistributorRegistry> | null = null;

export async function loadDistributorRegistry(): Promise<DistributorRegistry> {
  if (cached && Date.now() < cachedUntil) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let rows = await readRows();
    const newest = rows.reduce((a, r) => Math.max(a, r.updatedAtMs), 0);
    if (rows.length === 0 || Date.now() - newest > SYNC_STALE_MS) {
      try {
        await syncDistributorIdentity();
        rows = await readRows();
      } catch (err) {
        // Sheets down: serve whatever the DB has (possibly empty) rather than fail.
        logger.warn({ err }, "distributorRegistry: sync failed, serving persisted rows");
      }
    }
    let aliases = await readAliases();
    if (aliases.length === 0 || Date.now() - newest > SYNC_STALE_MS) {
      try {
        await syncDistributorAliases();
        aliases = await readAliases();
      } catch (err) {
        logger.warn({ err }, "distributorRegistry: alias sync failed, serving persisted aliases");
      }
    }
    const reg = new DistributorRegistry(
      rows.map(({ updatedAtMs: _u, ...r }) => r),
      aliases,
    );
    cached = reg;
    // An empty registry or empty alias set means a sync failed (e.g. Sheets
    // quota) — retry soon instead of pinning the gap for the full TTL.
    cachedUntil =
      Date.now() + (rows.length > 0 && aliases.length > 0 ? TTL_MS : 60_000);
    return reg;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function readAliases(): Promise<DistributorAlias[]> {
  const res = await db.execute<{
    dist_id: string;
    alias: string;
    norm_key: string;
    source: string;
  }>(sql`SELECT dist_id, alias, norm_key, source FROM distributor_identity_alias`);
  return res.rows.map((r) => ({
    distId: r.dist_id,
    alias: r.alias,
    normKey: r.norm_key,
    source: r.source,
  }));
}

async function readRows(): Promise<Array<DistributorRecord & { updatedAtMs: number }>> {
  const res = await db.execute<{
    dist_id: string | null;
    name: string;
    norm_key: string;
    state: string | null;
    district: string | null;
    source: string;
    updated_at: string | Date;
  }>(sql`SELECT dist_id, name, norm_key, state, district, source, updated_at FROM distributor_identity`);
  return res.rows.map((r) => ({
    distId: r.dist_id,
    name: r.name,
    normKey: r.norm_key,
    state: r.state,
    district: r.district,
    source: r.source,
    updatedAtMs: new Date(r.updated_at as string).getTime() || 0,
  }));
}

// ── Identity report ───────────────────────────────────────────────────────────

export type TransactingDistributor = {
  name: string;
  normKey: string;
  distId: string | null;
  state: string | null;
  registryState: string | null;
  registryDistrict: string | null;
  value: number;
  months: string[];
};

export type CandidatePair = {
  a: { name: string; distId: string | null; state: string | null; district: string | null; value: number };
  b: { name: string; distId: string | null; state: string | null; district: string | null; value: number };
  similarity: number;
  /** RESOLVED-SAME-ID when both sides carry the same DIST# (the ID resolves
   *  the spelling variants outright); RESOLVED-DIFFERENT when a disproof test
   *  fires; CANDIDATE otherwise (human decision, never auto-merged). */
  status: "CANDIDATE" | "RESOLVED-DIFFERENT" | "RESOLVED-SAME-ID";
  reason: string;
};

export type DistributorIdentityReport = {
  fy: string;
  registry: { persisted: number; withDistId: number; ambiguousNames: number };
  /** Distinct transacting customer identities in sale_line for the FY. */
  transacting: number;
  /** Transacting distributors with no DIST# anywhere — need name+state+district identity. */
  noDistId: TransactingDistributor[];
  /** Similar-name pairs. NEVER merged — reported for a human decision. */
  candidatePairs: CandidatePair[];
  /** Total pairs found before the list cap, by status. */
  pairTotals: Record<string, number>;
  basisNote: string;
  builtAt: number;
};

/** Build the human-decision report: no-DIST# transacting distributors and
 *  candidate same-entity pairs with every disproof field. Nothing merges. */
export async function buildDistributorIdentityReport(fy: string): Promise<DistributorIdentityReport> {
  const reg = await loadDistributorRegistry();

  const tx = await db.execute<{
    customer: string;
    state: string | null;
    value: string | number;
    months: string[];
  }>(sql`
    SELECT customer,
           MAX(NULLIF(BTRIM(COALESCE(state_canon, '')), '')) AS state,
           SUM(amount)                                       AS value,
           ARRAY_AGG(DISTINCT month_label)                   AS months
    FROM sale_line_current
    WHERE fy = ${fy} AND customer IS NOT NULL AND BTRIM(customer) <> ''
    GROUP BY customer
  `);

  const transacting: TransactingDistributor[] = tx.rows.map((r) => {
    let res = reg.resolve(r.customer, { state: r.state });
    if (res.kind === "not_found") {
      // City-suffix fallback: "PROGRESSIVE MARKETING (Bhopal)" → base name,
      // but only accept when the states agree (geography can DISPROVE).
      const base = stripLocationSuffix(r.customer);
      if (base !== r.customer.trim()) {
        const baseRes = reg.resolve(base, { state: r.state });
        if (
          baseRes.kind === "found" &&
          r.state &&
          baseRes.record.state &&
          statesAgree(r.state, baseRes.record.state)
        ) {
          res = baseRes;
        }
      }
    }
    const rec =
      res.kind === "found"
        ? res.record
        : null; // ambiguous → cannot attach a DIST# without a human decision
    return {
      name: r.customer,
      normKey: normDistKey(r.customer),
      distId: rec?.distId ?? null,
      state: r.state,
      registryState: rec?.state ?? null,
      registryDistrict: rec?.district ?? null,
      value: Number(r.value) || 0,
      months: r.months ?? [],
    };
  });

  const noDistId = transacting
    .filter((t) => t.distId === null)
    .sort((a, b) => b.value - a.value);

  // Candidate pairs over RAW transacting names — same-normKey spellings are
  // NOT pre-aggregated away: two raw names sharing a normKey are exactly the
  // collisions downstream name-key joins would silently blend, so they must
  // surface here (similarity 1) with their IDs/geography, not disappear.
  const groups = transacting;
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const sameKey = a.normKey === b.normKey;
      // Includes sim === 1: different normKeys that clean to identical
      // trigram strings ("R R TRADE" vs "RRTRADE") are the STRONGEST
      // candidates, not duplicates — the keys differ, so nothing merged them.
      const simRaw = sameKey ? 1 : jaccardTrigram(a.normKey, b.normKey);
      if (simRaw <= 0.6) continue;
      const sim = +simRaw.toFixed(3);
      const side = (t: TransactingDistributor) => ({
        name: t.name,
        distId: t.distId,
        state: t.state ?? t.registryState,
        district: t.registryDistrict,
        value: Math.round(t.value),
      });
      // Disproof tests, in order — any ONE proves the two are DIFFERENT.
      let status: CandidatePair["status"] = "CANDIDATE";
      let reason = sameKey
        ? "identical normalised key — name-key joins currently blend these spellings; needs an ID or geography verdict"
        : "similar names — human decision required, never auto-merged";
      const sameMonths = a.months.filter((m) => b.months.includes(m));
      if (a.distId && b.distId && a.distId === b.distId) {
        status = "RESOLVED-SAME-ID";
        reason = `both carry ${a.distId} — one distributor, spelling variants (ID resolves outright)`;
      } else if (a.distId && b.distId && a.distId !== b.distId) {
        status = "RESOLVED-DIFFERENT";
        reason = `different stable IDs (${a.distId} vs ${b.distId})`;
      } else if (sameMonths.length > 0) {
        status = "RESOLVED-DIFFERENT";
        reason = `both transact in the same period (${sameMonths.slice(0, 3).join(", ")}${sameMonths.length > 3 ? "…" : ""})`;
      } else {
        const sa = side(a).state;
        const sb = side(b).state;
        if (sa && sb && sa !== sb) {
          status = "RESOLVED-DIFFERENT";
          reason = `different states in the same FY (${sa} vs ${sb})`;
        }
      }
      pairs.push({ a: side(a), b: side(b), similarity: sim, status, reason });
    }
  }
  pairs.sort((x, y) => {
    if (x.status !== y.status) return x.status === "CANDIDATE" ? -1 : 1;
    return y.similarity - x.similarity;
  });

  const ambiguousNames = reg.records.reduce((n, r) => {
    const c = dedupeCount(reg.candidatesFor(r.normKey));
    return c > 1 ? n + 1 : n;
  }, 0);

  return {
    fy,
    registry: {
      persisted: reg.records.length,
      withDistId: reg.records.filter((r) => r.distId).length,
      ambiguousNames,
    },
    transacting: transacting.length,
    noDistId,
    pairTotals: pairs.reduce<Record<string, number>>((m, p) => {
      m[p.status] = (m[p.status] ?? 0) + 1;
      return m;
    }, {}),
    candidatePairs: pairs.slice(0, 500),
    basisNote:
      "DIST# is the only merge key. No-DIST# distributors are identified by name + state + district. " +
      "Candidate pairs are NEVER merged automatically; pairs transacting in the same period are marked RESOLVED-DIFFERENT.",
    builtAt: Date.now(),
  };
}

function dedupeCount(rows: DistributorRecord[]): number {
  return dedupeIdentities(rows).length;
}
