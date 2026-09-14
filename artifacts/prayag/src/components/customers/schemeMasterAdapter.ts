export type SchemeMasterView = {
  schemes: Array<{
    id: string;
    name: string;
    basis: string;
    slabs: Array<{
      threshold: number;
      rate: number | null;
      reward?: string | null;
      rewardType: "pct" | "trip" | "pct_or_trip";
    }>;
    stateRestriction?: string[];
  }>;
};

type UnknownRow = Record<string, unknown>;

function asRow(value: unknown): UnknownRow {
  return value != null && typeof value === "object" ? value as UnknownRow : {};
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Adapts both the current DB-backed response (flat scheme/slab rows) and the
 * retired nested JSON response into the shape rendered by Scheme Master.
 */
export function normalizeSchemeMaster(payload: unknown): SchemeMasterView {
  const body = asRow(payload);
  if (!Array.isArray(body.schemes)) {
    throw new Error("Scheme master response is missing its schemes list.");
  }

  const flatSlabs = Array.isArray(body.slabs) ? body.slabs.map(asRow) : [];
  const slabsByScheme = new Map<string, UnknownRow[]>();
  for (const slab of flatSlabs) {
    const schemeId = String(slab.scheme_id ?? slab.schemeId ?? "");
    if (!schemeId) continue;
    const rows = slabsByScheme.get(schemeId) ?? [];
    rows.push(slab);
    slabsByScheme.set(schemeId, rows);
  }

  const schemes = body.schemes.map((value) => {
    const row = asRow(value);
    const id = String(row.scheme_id ?? row.id ?? "");
    const name = String(row.name ?? "");
    const basis = String(row.qualification_basis ?? row.basis ?? "");
    if (!id || !name || !basis) {
      throw new Error("Scheme master contains an incomplete scheme row.");
    }

    const sourceSlabs = Array.isArray(row.slabs)
      ? row.slabs.map(asRow)
      : (slabsByScheme.get(id) ?? []).sort(
          (a, b) => Number(a.slab_order ?? 0) - Number(b.slab_order ?? 0),
        );

    const slabs = sourceSlabs.map((slab) => {
      const threshold = nullableNumber(slab.threshold_from ?? slab.threshold);
      if (threshold == null) {
        throw new Error(`Scheme ${id} contains a slab without a numeric threshold.`);
      }
      const rate = nullableNumber(slab.rate);
      const rewardValue = slab.alt_reward ?? slab.free_goods ?? slab.reward ?? null;
      const reward = rewardValue == null ? null : String(rewardValue);
      return {
        threshold,
        rate,
        reward,
        rewardType: reward
          ? rate == null ? "trip" as const : "pct_or_trip" as const
          : "pct" as const,
      };
    });

    const restriction = row.territory_group ?? row.stateRestriction;
    const stateRestriction = Array.isArray(restriction)
      ? restriction.map(String)
      : restriction ? [String(restriction)] : undefined;

    return { id, name, basis, slabs, stateRestriction };
  });

  return { schemes };
}