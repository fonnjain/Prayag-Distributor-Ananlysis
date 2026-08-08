/**
 * Distributor directory — the cross-head index that powers the Distributor
 * Deep Dive filter chain (Geography → Distributor → State Head).
 *
 * Merges every state head's distributor deep-dive payload (snapshot-backed via
 * the resilient loader, so a cold Sheets pass never blanks the directory) into
 * one list: each distributor appears ONCE, with every state it operates in and
 * every head whose team serves it.
 *
 * GEOGRAPHY BASIS: a distributor's state(s) = the assigned state(s) of the
 * roster members whose retailer rows name it — i.e. the distributor's own
 * serving territory, NOT the retailer's state. (A Delhi distributor serving
 * Haryana retailers lists under Delhi.) The header on the page must say this.
 *
 * State names are canonicalised through the shared stateCanon module so
 * territory splits (DELHI A / DELHI NCR, UP ( A ) / UP (AS), KARNATAKA (B))
 * collapse to one geographic state each.
 */

import {
  loadDistributorDeepDiveResilient,
  loadDistDdSnapshotOnly,
} from "./distributorDeepDive.js";
import { loadRoster } from "./roster.js";
import { normMemberKey } from "./memberResolver.js";
import { normaliseStateCanon } from "../stateCanon.js";
import { logger } from "../logger.js";

export type DirectoryDistributor = {
  name: string;
  normKey: string;
  /** Canonical geographic states (serving members' states, normalised). */
  states: string[];
  /** State heads whose teams serve this distributor. */
  heads: string[];
  /** Team members (display names) whose retailer rows name this distributor. */
  members: string[];
  retailerCount: number;
  activeCount: number;
  /** Party order booking (net) for the FY — the ordering measure. */
  orderBooking: number;
  sale: number;
};

export type DirectoryHead = {
  name: string;
  /** Canonical states this head's team covers (from the roster). */
  states: string[];
  distributorCount: number;
  orderBooking: number;
  /** True when this head's figures came from a stale snapshot. */
  stale: boolean;
  /** True when this head's payload could not be loaded at all. */
  failed: boolean;
};

export type DistributorDirectory = {
  fy: string;
  basis: "distributor-own-state";
  basisLabel: string;
  states: string[]; // canonical, sorted
  heads: DirectoryHead[];
  distributors: DirectoryDistributor[]; // sorted by orderBooking desc
  builtAt: number;
};

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { dir: DistributorDirectory; until: number }>();
const inFlight = new Map<string, Promise<DistributorDirectory>>();

export async function loadDistributorDirectory(fy: string): Promise<DistributorDirectory> {
  const hit = cache.get(fy);
  if (hit && Date.now() < hit.until) return hit.dir;
  const pending = inFlight.get(fy);
  if (pending) return pending;
  const p = buildDirectory(fy)
    .then((dir) => {
      cache.set(fy, { dir, until: Date.now() + CACHE_TTL_MS });
      return dir;
    })
    .finally(() => inFlight.delete(fy));
  inFlight.set(fy, p);
  return p;
}

async function buildDirectory(fy: string): Promise<DistributorDirectory> {
  const roster = await loadRoster();
  const headNames = [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))];

  // member normKey → canonical state; head → canonical state set (active members).
  const memberState = new Map<string, string>();
  const headStates = new Map<string, Set<string>>();
  for (const m of roster.members) {
    const canon = normaliseStateCanon((m.state ?? "").trim().toUpperCase() || null);
    if (!canon) continue;
    memberState.set(m.normKey || normMemberKey(m.name), canon);
    if (m.stateHead) {
      if (!(m.activeLeft ?? "").toUpperCase().includes("LEFT")) {
        let s = headStates.get(m.stateHead);
        if (!s) headStates.set(m.stateHead, (s = new Set()));
        s.add(canon);
      }
    }
  }

  type Acc = DirectoryDistributor & { _states: Set<string>; _heads: Set<string>; _members: Set<string> };
  const dists = new Map<string, Acc>();
  const heads: DirectoryHead[] = [];

  // Sequential per head — every payload is snapshot-backed via the resilient
  // loader, so this is DB-speed once the warmer has run; sequencing avoids a
  // Sheets read burst on a genuinely cold server.
  for (const head of headNames) {
    let stale = false;
    let failed = false;
    let distributorCount = 0;
    let ob = 0;
    try {
      // Snapshot-first: the warmer keeps per-head snapshots fresh, so the
      // directory never triggers a 12-head live Sheets cascade. Only a head
      // with no snapshot at all falls back to a live (resilient) build.
      let r = await loadDistDdSnapshotOnly(fy, head);
      if (r) {
        stale = true; // snapshot age unknown — mark conservatively
      } else {
        r = await loadDistributorDeepDiveResilient(fy, head);
        stale = r.stale === true;
      }
      distributorCount = r.distributors.length;
      for (const d of r.distributors) {
        ob += d.orderBooking;
        let acc = dists.get(d.normKey);
        if (!acc) {
          acc = {
            name: d.name, normKey: d.normKey, states: [], heads: [], members: [],
            retailerCount: 0, activeCount: 0, orderBooking: 0, sale: 0,
            _states: new Set(), _heads: new Set(), _members: new Set(),
          };
          dists.set(d.normKey, acc);
        }
        acc.retailerCount += d.retailerCount;
        acc.activeCount += d.activeCount;
        acc.orderBooking += d.orderBooking;
        acc.sale += d.sale;
        acc._heads.add(head);
        for (const row of d.retailers) {
          if (row.memberName) acc._members.add(row.memberName.trim());
          const st = memberState.get(normMemberKey(row.memberName));
          if (st) acc._states.add(st);
        }
      }
    } catch (err) {
      failed = true;
      logger.warn({ err, head, fy }, "distributorDirectory: head payload failed");
    }
    heads.push({
      name: head,
      states: [...(headStates.get(head) ?? [])].sort(),
      distributorCount,
      orderBooking: ob,
      stale,
      failed,
    });
  }

  const distributors = [...dists.values()]
    .map((a) => ({
      name: a.name, normKey: a.normKey,
      states: [...a._states].sort(),
      heads: [...a._heads].sort(),
      members: [...a._members].sort(),
      retailerCount: a.retailerCount, activeCount: a.activeCount,
      orderBooking: a.orderBooking, sale: a.sale,
    }))
    .sort((x, y) => y.orderBooking - x.orderBooking);

  const states = [...new Set(distributors.flatMap((d) => d.states))].sort();

  return {
    fy,
    basis: "distributor-own-state",
    basisLabel:
      "Geography is the distributor's own serving territory (the assigned state of the team members who serve it), not the retailer's state.",
    states,
    heads: heads.sort((a, b) => a.name.localeCompare(b.name)),
    distributors,
    builtAt: Date.now(),
  };
}
