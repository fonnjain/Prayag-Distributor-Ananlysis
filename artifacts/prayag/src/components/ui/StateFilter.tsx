// StateFilter — two-level hierarchical multi-select for Indian states.
//
// The hierarchy is fetched from /api/state-hierarchy and held in a module-level
// singleton so every mounted instance shares the same data.
//
// Picker behaviour:
//   • Clicking a parent with splits → toggles ALL its children in/out.
//   • Clicking a split child       → toggles only that split.
//   • Clicking a non-split parent  → toggles that single state_canon value.
//   • Multi-select works across levels.
//   • picker_visible=false entries (GEM, JJM, Non-territory, HITESH) are
//     fetched for arithmetic completeness but never shown.
//
// Props:
//   selected   — currently selected state_canon leaf values ([] = All / no filter)
//   onChange   — called with the new leaf-value array
//   available  — optional Set<string> that restricts which state_canon values appear
//                (used by CompanyReportFilters to honour the head-scoped tree)
//   fy         — FY for count display (default "2026-27")
//   label      — trigger-button label prefix (default "State")
//
// Exports:
//   default         StateFilter component
//   REGION_GROUPS   kept for DistributorDeepDive "region" mode (uses raw state_canon leaves)
//   ALL_STATES      flat list of all picker-visible state_canon values

import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export type HierarchyRow = {
  state_canon: string;
  state_parent: string;
  is_split: boolean;
  picker_visible: boolean;
  display_order: number;
  row_count: number;
  net_cr: number;
};

type ParentGroup = {
  parent: string;
  /** All picker-visible children in display order. */
  children: HierarchyRow[];
  /**
   * true when there is exactly one child whose state_canon equals state_parent
   * (i.e. not a genuine split — just a single self-mapping entry).
   */
  isSingleSelf: boolean;
};

// ── Singleton hierarchy cache ──────────────────────────────────────────────────

let _cacheAll: HierarchyRow[] | null = null;    // all rows (including non-visible)
let _cacheVisible: HierarchyRow[] | null = null; // picker_visible only
let _fetchPromise: Promise<HierarchyRow[]> | null = null;

async function fetchHierarchy(fy: string): Promise<HierarchyRow[]> {
  // Cache is keyed to the first FY requested. Counts are informational; the
  // structure (state_canon, state_parent, is_split) is FY-independent.
  if (_cacheVisible) return _cacheVisible;
  if (!_fetchPromise) {
    _fetchPromise = fetch(`/api/state-hierarchy?fy=${encodeURIComponent(fy)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ rows: HierarchyRow[] }>) : Promise.reject(r.status)))
      .then((data) => {
        // PostgreSQL numeric aggregates arrive over JSON as strings. The picker
        // displays them with Number#toFixed, so normalise at the API boundary
        // rather than trusting the TypeScript-only HierarchyRow declaration.
        const normalized = data.rows.map((row) => ({
          ...row,
          row_count: Number(row.row_count) || 0,
          net_cr: Number(row.net_cr) || 0,
        }));
        _cacheAll     = normalized;
        _cacheVisible = normalized.filter((r) => r.picker_visible);
        return _cacheVisible;
      })
      .catch(() => {
        _fetchPromise = null; // allow retry on next mount
        return [];
      });
  }
  return _fetchPromise;
}

// ── Region groups (raw state_canon leaves) — kept for DistributorDeepDive ─────
// Using actual DB leaf values so the region → geoStates set matches h.states.

export const REGION_GROUPS: { region: string; states: string[] }[] = [
  {
    region: "North",
    states: [
      "DELHI A", "DELHI NCR",
      "HIMACHAL PRADESH", "CHANDIGARH",
      "JAMMU", "KASHMIR",
      "UTTAR PRADESH", "UP ( A )", "UP (AS)",
      "UTTARAKHAND",
      "HARYANA",
      "RAJASTHAN", "RAJASTHAN (N)",
      "PUNJAB",
    ],
  },
  {
    region: "East",
    states: ["WEST BENGAL", "ASSAM", "BIHAR", "JHARKHAND", "ODISHA"],
  },
  {
    region: "South",
    states: [
      "AP", "TELANGANA", "KERALA", "GOA",
      "KARNATAKA", "KARNATAKA (B)",
      "TAMIL NADU", "TAMILNADU (S)",
    ],
  },
  {
    region: "West",
    states: ["MAHARASHTRA", "GUJARAT", "MADHYA PRADESH", "CHHATTISGARH"],
  },
];

export const ALL_STATES = REGION_GROUPS.flatMap((g) => g.states);

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
  /** Restrict to these state_canon values (e.g. from a head-scoped filter tree). */
  available?: Set<string>;
  /** FY for row-count display. Default "2026-27". */
  fy?: string;
  className?: string;
  /** Label prefix on the trigger button. Default "State". */
  label?: string;
}

export default function StateFilter({
  selected,
  onChange,
  available,
  fy = "2026-27",
  className,
  label = "State",
}: Props) {
  const [open, setOpen]         = useState(false);
  const [rows, setRows]         = useState<HierarchyRow[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  // Fetch hierarchy on first mount.
  useEffect(() => {
    fetchHierarchy(fy).then(setRows).catch(() => {});
  }, [fy]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Build parent groups, respecting the `available` allowlist.
  const groups = useMemo((): ParentGroup[] => {
    if (!rows) return [];
    const visible = available
      ? rows.filter((r) => available.has(r.state_canon))
      : rows;
    const map = new Map<string, HierarchyRow[]>();
    for (const row of visible) {
      if (!map.has(row.state_parent)) map.set(row.state_parent, []);
      map.get(row.state_parent)!.push(row);
    }
    return [...map.entries()].map(([parent, children]) => ({
      parent,
      children,
      isSingleSelf: children.length === 1 && children[0].state_canon === parent,
    }));
  }, [rows, available]);

  const selSet = useMemo(() => new Set(selected), [selected]);

  function parentState(group: ParentGroup): "all" | "some" | "none" {
    const inSel = group.children.filter((c) => selSet.has(c.state_canon)).length;
    if (inSel === 0) return "none";
    if (inSel === group.children.length) return "all";
    return "some";
  }

  function toggleParent(group: ParentGroup) {
    const state = parentState(group);
    const canons = group.children.map((c) => c.state_canon);
    if (state === "all") {
      onChange(selected.filter((s) => !canons.includes(s)));
    } else {
      const next = [...selected];
      for (const c of canons) if (!selSet.has(c)) next.push(c);
      onChange(next);
    }
  }

  function toggleChild(canon: string) {
    onChange(selSet.has(canon) ? selected.filter((s) => s !== canon) : [...selected, canon]);
  }

  function toggleExpanded(parent: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent);
      else next.add(parent);
      return next;
    });
  }

  // Auto-expand groups with selected children when opening.
  useEffect(() => {
    if (!open || selected.length === 0) return;
    const toExpand = new Set<string>();
    for (const g of groups) {
      if (!g.isSingleSelf && g.children.some((c) => selSet.has(c.state_canon))) {
        toExpand.add(g.parent);
      }
    }
    if (toExpand.size) setExpanded((prev) => new Set([...prev, ...toExpand]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isAll = selected.length === 0;
  const summary = isAll
    ? "All"
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  return (
    <div className={cn("relative", className)} ref={ref}>
      {/* ── Trigger ──────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs bg-background hover:bg-muted/40 transition-colors",
          !isAll
            ? "border-primary/50 text-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        <span className="font-medium">{label}:</span>
        <span className="max-w-[150px] truncate">{summary}</span>
        {!isAll && (
          <span
            role="button"
            tabIndex={0}
            className="ml-0.5 rounded hover:bg-muted p-0.5"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            title="Clear"
          >
            <X className="h-3 w-3" />
          </span>
        )}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {/* ── Dropdown ─────────────────────────────────────────────────── */}
      {open && (
        <div className="absolute z-30 mt-1 min-w-[230px] max-w-[290px] rounded-md border border-border bg-popover shadow-lg">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px]">
            <span className="text-muted-foreground font-medium">{label}</span>
            {!isAll && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => onChange([])}
              >
                Clear all
              </button>
            )}
          </div>

          {/* List */}
          {!rows ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No states available.</p>
          ) : (
            <div className="max-h-80 overflow-auto py-1">
              {groups.map((group) => {
                const pState    = parentState(group);
                const isExpanded = expanded.has(group.parent);
                const hasChildren = !group.isSingleSelf;
                const totalNet  = group.children.reduce((s, c) => s + (c.net_cr || 0), 0);

                return (
                  <div key={group.parent}>
                    {/* ── Parent row ─────────────────────────────────── */}
                    <div className="flex items-center gap-0.5 px-1 py-0.5 mx-1 rounded hover:bg-muted/40">
                      {/* Expand chevron (split groups only) */}
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(group.parent)}
                          className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                        >
                          <ChevronRight
                            className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")}
                          />
                        </button>
                      ) : (
                        <span className="w-4 flex-shrink-0" />
                      )}

                      {/* Checkbox + label */}
                      <button
                        type="button"
                        onClick={() =>
                          hasChildren
                            ? toggleParent(group)
                            : toggleChild(group.children[0].state_canon)
                        }
                        className="flex flex-1 items-center gap-2 text-left min-w-0"
                      >
                        <span
                          className={cn(
                            "h-3.5 w-3.5 flex-shrink-0 rounded border flex items-center justify-center text-[8px] transition-colors",
                            pState === "all"
                              ? "border-primary bg-primary text-primary-foreground"
                              : pState === "some"
                                ? "border-primary/60 bg-primary/20"
                                : "border-border",
                          )}
                        >
                          {pState === "all" ? "✓" : pState === "some" ? "−" : ""}
                        </span>
                        <span className="text-xs font-medium flex-1 truncate">
                          {group.parent}
                        </span>
                        {totalNet > 0 && (
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap pl-1">
                            ₹{totalNet.toFixed(1)}Cr
                          </span>
                        )}
                      </button>
                    </div>

                    {/* ── Split children ──────────────────────────────── */}
                    {hasChildren && isExpanded && (
                      <div className="ml-7 mb-0.5">
                        {group.children.map((child) => {
                          const checked = selSet.has(child.state_canon);
                          return (
                            <button
                              key={child.state_canon}
                              type="button"
                              onClick={() => toggleChild(child.state_canon)}
                              className="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-muted/40 mx-1"
                            >
                              <span
                                className={cn(
                                  "h-3 w-3 flex-shrink-0 rounded border flex items-center justify-center text-[8px]",
                                  checked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border",
                                )}
                              >
                                {checked ? "✓" : ""}
                              </span>
                              <span className="text-xs text-muted-foreground flex-1 truncate">
                                {child.state_canon}
                              </span>
                              {child.net_cr > 0 && (
                                <span className="text-[10px] text-muted-foreground whitespace-nowrap pl-1">
                                  ₹{child.net_cr.toFixed(1)}Cr
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer */}
          {!isAll && (
            <div className="border-t px-3 py-1.5">
              <span className="text-[10px] text-muted-foreground">
                {selected.length} value{selected.length !== 1 ? "s" : ""} selected
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
