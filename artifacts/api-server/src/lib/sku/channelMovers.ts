/**
 * Channel-mover grouping — pure logic, no DB.
 *
 * A customer whose head_canon classification moves between territory
 * (NULL / any non-project head) and the project head across two FYs shifts
 * their whole book across the territory-vs-project comparison boundary.
 * Cross-FY mix comparisons built on a level filter are then partly
 * attribution, not trade — this module quantifies that per adjacent FY pair.
 *
 * Population rules (aligned with the SKU Trends query the disclosure sits
 * under):
 *   - Candidates for an FY pair are customers with a non-zero IN-LEVEL net
 *     (same level + scope predicates as the displayed trend) in at least one
 *     of the two FYs. Customers never visible in the comparison are ignored.
 *   - Classification (territory vs project) uses the customer's whole book
 *     for the FY: any project-head row ⇒ project; head_canon IS NULL is
 *     explicitly territory (COALESCE(bool_or(...), false) upstream).
 *   - Mover amounts are the customer's net on the side of the boundary they
 *     sat that FY (netFrom = fromFy classified-side net, netTo = toFy
 *     classified-side net), so a leaver's netTo shows what now books outside
 *     the displayed channel.
 *   - scope='head': the in-level predicate carries the head restriction, so a
 *     customer who leaves the selected head for the project channel is still
 *     disclosed (their departure changes the head's comparison basis). A
 *     customer who merely moves between two territory heads is NOT a channel
 *     mover — that is a head reassignment, not a channel change.
 */

export type MoverCustRow = {
  fy: string;
  customer: string;
  /** Whole-book classification for the FY (any project-head row). */
  isProject: boolean;
  /** Net of rows classified territory (head_canon NULL or non-project). */
  netTerritory: number;
  /** Net of rows classified project. */
  netProject: number;
  /** Net under the displayed trend's level + scope predicates. */
  netInLevel: number;
};

export type SkuChannelMover = {
  customer: string;
  direction: "territory_to_project" | "project_to_territory";
  /** Net in the earlier FY on the side the customer was then classified. */
  netFrom: number;
  /** Net in the later FY on the side the customer is now classified. */
  netTo: number;
};

export type SkuChannelMoverPair = {
  fromFy: string;
  toFy: string;
  /** Candidates present both FYs with unchanged channel classification. */
  sameChannel: number;
  /** Candidates present both FYs whose channel classification changed. */
  channelChanged: number;
  /** Candidates in-level in toFy with no rows at all in fromFy. */
  newCustomers: number;
  /** Movers above the materiality floor, largest first (capped). */
  movers: SkuChannelMover[];
  /** Total later-FY classified-side net of ALL changed customers. */
  netChangedTo: number;
  /** Total earlier-FY classified-side net of ALL changed customers. */
  netChangedFrom: number;
};

/** ₹1 lakh materiality floor for the listed movers (totals include all). */
export const MOVER_FLOOR = 1e5;
export const MOVER_CAP = 10;

function sideNet(r: MoverCustRow): number {
  return r.isProject ? r.netProject : r.netTerritory;
}

export function buildChannelMoverPairs(
  rows: MoverCustRow[],
  fys: string[],
): SkuChannelMoverPair[] {
  const byFy = new Map<string, Map<string, MoverCustRow>>();
  for (const r of rows) {
    let m = byFy.get(r.fy);
    if (!m) { m = new Map(); byFy.set(r.fy, m); }
    m.set(r.customer, r);
  }

  const pairs: SkuChannelMoverPair[] = [];
  for (let i = 1; i < fys.length; i++) {
    const fromFy = fys[i - 1];
    const toFy = fys[i];
    const prev = byFy.get(fromFy) ?? new Map<string, MoverCustRow>();
    const curr = byFy.get(toFy) ?? new Map<string, MoverCustRow>();

    let sameChannel = 0;
    let channelChanged = 0;
    let newCustomers = 0;
    let netChangedTo = 0;
    let netChangedFrom = 0;
    const movers: SkuChannelMover[] = [];

    const candidates = new Set<string>();
    for (const [c, r] of prev) if (r.netInLevel !== 0) candidates.add(c);
    for (const [c, r] of curr) if (r.netInLevel !== 0) candidates.add(c);

    for (const customer of candidates) {
      const before = prev.get(customer);
      const after = curr.get(customer);
      if (!after) continue; // left entirely; not a channel move we can classify
      if (!before) {
        if (after.netInLevel !== 0) newCustomers++;
        continue;
      }
      if (before.isProject === after.isProject) { sameChannel++; continue; }
      channelChanged++;
      const netFrom = sideNet(before);
      const netTo = sideNet(after);
      netChangedFrom += netFrom;
      netChangedTo += netTo;
      if (Math.max(Math.abs(netFrom), Math.abs(netTo)) >= MOVER_FLOOR) {
        movers.push({
          customer,
          direction: after.isProject ? "territory_to_project" : "project_to_territory",
          netFrom,
          netTo,
        });
      }
    }

    movers.sort(
      (a, b) =>
        Math.max(Math.abs(b.netFrom), Math.abs(b.netTo)) -
        Math.max(Math.abs(a.netFrom), Math.abs(a.netTo)),
    );

    pairs.push({
      fromFy,
      toFy,
      sameChannel,
      channelChanged,
      newCustomers,
      movers: movers.slice(0, MOVER_CAP),
      netChangedTo,
      netChangedFrom,
    });
  }
  return pairs;
}
