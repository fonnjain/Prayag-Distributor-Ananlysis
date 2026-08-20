import frozenRegisters from "../../../config/frozen_registers.json";

export type FrozenEntry = { rows: number; amountRupees: number };

const frozenMap: Map<string, FrozenEntry> = new Map(
  Object.entries(frozenRegisters.frozen as Record<string, FrozenEntry>),
);

export function isFrozen(fy: string): boolean {
  return frozenMap.has(fy);
}

export function getFrozenAnchor(fy: string): FrozenEntry | undefined {
  return frozenMap.get(fy);
}

export function getFrozenAnchors(): ReadonlyMap<string, FrozenEntry> {
  return frozenMap;
}