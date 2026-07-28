// Identity registry — stable IDs and collision detection for all 183+ team members.
//
// Problem solved: any code path can ask "which person is named X?" and get
// either a definitive Found answer or an explicit Ambiguous error — never a
// silent first-match guess that returns the wrong person's figures.
//
// Stable ID = normSecKey(displayName) + ":" + normSecKey(stateHead)
// Collision  = two or more people share the same normName (parenthetical-stripped)
//
// Usage:
//   const reg = getRegistry(fy);   // from deepDiveData.ts
//   const r   = reg.resolve("Ashutosh Kumar", { stateHead: "Anant Singh" });
//   if (r.kind === "ambiguous") return res.status(400).json({ error: r.message });
//   if (r.kind === "not_found") return res.status(404).json({ error: "..." });
//   const memberKey = r.person.nsk;   // pass to loadDeepDiveData

import { logger } from "../logger.js";
import { normName, normSecKey } from "./names.js";

// Re-export so callers that already import from here keep working.
export { normSecKey };

// ── Types ─────────────────────────────────────────────────────────────────────

/** One known person in the registry. */
export type Person = {
  /** Stable opaque ID: normSecKey(displayName):normSecKey(stateHead). */
  id: string;
  /** Name exactly as the sheet spells it. */
  displayName: string;
  /** normSecKey(displayName) — preserves parentheticals. Used as memberKey in deepDiveData. */
  nsk: string;
  /** normName(displayName) — strips parentheticals. Used for collision grouping. */
  normNameKey: string;
  stateHead: string;
  state: string | null;
  hq: string | null;
  isLeft: boolean;
  fy: string;
};

export type ResolveResult =
  | { kind: "found"; person: Person }
  | { kind: "ambiguous"; candidates: Person[]; discriminator: string; message: string }
  | { kind: "not_found" };

export type CollisionRecord = {
  normNameKey: string;
  candidates: Person[];
  discriminator: "stateHead" | "hq" | "other";
};

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Built once per FY when the Data tab is first loaded.
 * All member lookups go through this instead of calling normSecKey directly.
 */
export class IdentityRegistry {
  private readonly _byId: Map<string, Person>;
  private readonly _byNsk: Map<string, Person[]>;      // normSecKey(name) → persons
  private readonly _byNormName: Map<string, Person[]>; // normName(name)   → persons (collision groups)

  readonly collisions: ReadonlyArray<CollisionRecord>;
  readonly fy: string;

  /**
   * @param members Raw member data from the Data tab (MemberKpis shape: only
   *   the fields we need are required here so the registry has no import cycle
   *   with deepDiveData.ts).
   */
  constructor(
    members: Array<{
      name: string;
      stateHead: string;
      hq: string | null;
      isLeft: boolean;
      extra?: Record<string, string | number | null>;
    }>,
    fy: string,
  ) {
    this.fy = fy;
    this._byId = new Map();
    this._byNsk = new Map();
    this._byNormName = new Map();

    for (const m of members) {
      const nsk = normSecKey(m.name);
      const nn  = normName(m.name);
      const id  = `${nsk}:${normSecKey(m.stateHead)}`;

      const state: string | null =
        typeof m.extra?.["STATE"] === "string" ? m.extra["STATE"] : null;

      const person: Person = {
        id,
        displayName: m.name,
        nsk,
        normNameKey: nn,
        stateHead: m.stateHead,
        state,
        hq: m.hq,
        isLeft: m.isLeft,
        fy,
      };

      // Overwrite on duplicate stable ID — later row wins (last assignment wins
      // in the sheet); the collision detection below is on normName, not ID.
      this._byId.set(id, person);

      const nskList = this._byNsk.get(nsk) ?? [];
      if (!nskList.find((p) => p.id === id)) nskList.push(person);
      this._byNsk.set(nsk, nskList);

      const nnList = this._byNormName.get(nn) ?? [];
      if (!nnList.find((p) => p.id === id)) nnList.push(person);
      this._byNormName.set(nn, nnList);
    }

    // Detect collisions: normName groups where more than one stable ID exists.
    const collisions: CollisionRecord[] = [];
    for (const [nn, persons] of this._byNormName) {
      const distinctIds = new Set(persons.map((p) => p.id));
      if (distinctIds.size < 2) continue;

      const distinctHeads = new Set(persons.map((p) => normSecKey(p.stateHead)));
      const distinctHqs   = new Set(persons.map((p) => normSecKey(p.hq ?? "")));
      const discriminator: CollisionRecord["discriminator"] =
        distinctHeads.size > 1 ? "stateHead" :
        distinctHqs.size   > 1 ? "hq"        : "other";

      collisions.push({ normNameKey: nn, candidates: persons, discriminator });

      // Log every collision at load time so any new one appears in the log
      // the moment data is loaded — not discovered later via a wrong figure.
      logger.info(
        {
          fy,
          normNameKey: nn,
          discriminator,
          candidates: persons.map((p) => ({
            displayName: p.displayName,
            stateHead: p.stateHead,
            hq: p.hq ?? null,
            isLeft: p.isLeft,
          })),
        },
        "identityRegistry: name collision detected",
      );
    }

    if (collisions.length > 0) {
      logger.info(
        { fy, count: collisions.length },
        "identityRegistry: startup collision summary",
      );
    } else {
      logger.info({ fy }, "identityRegistry: no name collisions detected");
    }

    this.collisions = collisions;
  }

  /**
   * Resolve a raw name (or stable ID) to a Person.
   *
   * Resolution order:
   *  1. Exact stable-ID hit when context.stateHead is supplied.
   *  2. All persons whose normSecKey OR normName matches the input.
   *  3. Disambiguate by context.stateHead, then context.hq.
   *  4. If still >1 candidate: Ambiguous (never silently first-match).
   *
   * Always pass stateHead in context if known — it resolves all current
   * collisions. Without it, any ambiguous input returns Ambiguous.
   */
  resolve(
    input: string,
    context?: { stateHead?: string; hq?: string },
  ): ResolveResult {
    if (!input.trim()) return { kind: "not_found" };

    const inputNsk = normSecKey(input);
    const inputNn  = normName(input);

    // ── Resolution strategy ─────────────────────────────────────────────────
    //
    // Two different input forms require different handling:
    //
    //  A. BARE name (no parenthetical): "Ashutosh Kumar"
    //     inputNsk === inputNn because normSecKey and normName both strip
    //     the same non-alphanumeric chars. For bare names, we must check
    //     the normName collision group FIRST — even if one exact normSecKey
    //     match exists, the intent is ambiguous when multiple people share
    //     the normName. ("Ashutosh Kumar" could be Sandeep's or Anant's.)
    //
    //  B. SPECIFIC name (has parenthetical): "Ashutosh Kumar (Rudrapur)"
    //     inputNsk !== inputNn because normSecKey preserves the parenthetical.
    //     Use the normSecKey for an exact lookup → always unique if the
    //     disambiguator is correct. Do NOT union with normName — that would
    //     drag in the other Ashutosh Kumar and make the specific input ambiguous.

    const hasParenthetical = inputNsk !== inputNn;

    if (context?.stateHead) {
      const id    = `${inputNsk}:${normSecKey(context.stateHead)}`;
      const exact = this._byId.get(id);
      if (exact) return { kind: "found", person: exact };
    }

    const byNsk     = this._byNsk.get(inputNsk)     ?? [];
    const byNormName = this._byNormName.get(inputNn) ?? [];

    if (hasParenthetical) {
      // ── B: Specific name — normSecKey is the authority ──────────────────
      if (byNsk.length === 1) return { kind: "found", person: byNsk[0] };
      if (byNsk.length === 0) {
        // No nsk hit — fall to normName as last resort
        if (byNormName.length === 1) return { kind: "found", person: byNormName[0] };
        if (byNormName.length === 0) return { kind: "not_found" };
        // Multiple normName hits without nsk match — disambiguate by context
      }
      // Multiple nsk hits OR multiple normName hits: try context then fall through
      const candidates = byNsk.length > 0 ? byNsk : byNormName;
      if (context?.stateHead) {
        const headNsk = normSecKey(context.stateHead);
        const matched = candidates.filter((p) => normSecKey(p.stateHead) === headNsk);
        if (matched.length === 1) return { kind: "found", person: matched[0] };
      }
      const discriminator =
        new Set(candidates.map((p) => normSecKey(p.stateHead))).size > 1 ? "stateHead" : "hq";
      const candidateList = candidates.map((p) =>
        `"${p.displayName}" (${p.stateHead}${p.hq ? `, ${p.hq}` : ""})`
      ).join("; ");
      return {
        kind: "ambiguous", candidates, discriminator,
        message: `"${input}" matches ${candidates.length} people: ${candidateList}. Provide stateHead to disambiguate.`,
      };
    }

    // ── A: Bare name — normName collision check is primary ──────────────────
    // If the normName group has >1 person the input is inherently ambiguous,
    // even if one of them happens to have an exact normSecKey match.
    const seen       = new Set<string>();
    const candidates: Person[] = [];
    for (const p of byNormName) {
      if (!seen.has(p.id)) { seen.add(p.id); candidates.push(p); }
    }

    if (candidates.length === 0) return { kind: "not_found" };
    if (candidates.length === 1) return { kind: "found", person: candidates[0] };

    // ── 3. Disambiguate with context ────────────────────────────────────────
    if (context?.stateHead) {
      const headNsk = normSecKey(context.stateHead);
      const matched = candidates.filter((p) => normSecKey(p.stateHead) === headNsk);
      if (matched.length === 1) return { kind: "found", person: matched[0] };
    }
    if (context?.hq) {
      const hqNsk   = normSecKey(context.hq);
      const matched = candidates.filter((p) => normSecKey(p.hq ?? "") === hqNsk);
      if (matched.length === 1) return { kind: "found", person: matched[0] };
    }

    // ── 4. Still ambiguous — fail loudly, never guess ───────────────────────
    const discriminator =
      new Set(candidates.map((p) => normSecKey(p.stateHead))).size > 1
        ? "stateHead"
        : "hq";

    const candidateList = candidates
      .map((p) =>
        `"${p.displayName}" (${p.stateHead}${p.hq ? `, ${p.hq}` : ""})`
      )
      .join("; ");

    const message =
      `"${input}" matches ${candidates.length} people: ${candidateList}. ` +
      `Provide stateHead to disambiguate.`;

    return { kind: "ambiguous", candidates, discriminator, message };
  }

  /** All persons in this registry (all FY members). */
  get people(): Person[] {
    return [...this._byId.values()];
  }
}
