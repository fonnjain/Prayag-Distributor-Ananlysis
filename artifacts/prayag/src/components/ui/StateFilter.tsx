// StateFilter — region-grouped multi-select for Indian states.
//
// Regions and their canonical state names (matching state_canon in sale_line):
//   North — UP, Haryana, Punjab, Rajasthan, HP, Uttarakhand, Delhi, J&K
//   East  — West Bengal, Bihar, Jharkhand, Odisha, Assam
//   South — Kerala, Tamil Nadu, AP, Telangana, Karnataka, Goa
//   West  — Maharashtra, Gujarat, MP, Chhattisgarh
//
// Props:
//   selected  — currently selected state_canon strings ([] = no filter = all states)
//   onChange  — called with new selection whenever it changes
import { useState, useRef, useEffect } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Maps ERP split-territory names → canonical geographic state shown in the UI.
// Keep in sync with STATE_CANON_NORMALISE in artifacts/api-server/src/lib/stateCanon.ts.
// The server expands canonical selections back to all DB variants before querying.
const STATE_CANON_NORMALISE: Record<string, string> = {
  "DELHI A":       "DELHI",
  "DELHI NCR":     "DELHI",
  "UP ( A )":      "UTTAR PRADESH",
  "UP (AS)":       "UTTAR PRADESH",
  "UP (S)":        "UTTAR PRADESH",
  "HP":            "HIMACHAL PRADESH",
  "KARNATAKA (B)": "KARNATAKA",
};

/** Normalise a raw state_canon value to the canonical name shown in the UI. */
function toCanonical(s: string) { return STATE_CANON_NORMALISE[s] ?? s; }

export const REGION_GROUPS: { region: string; states: string[] }[] = [
  {
    region: "North",
    // Canonical geographic states only — no split-territory duplicates.
    states: ["UTTAR PRADESH", "HARYANA", "PUNJAB", "RAJASTHAN", "HIMACHAL PRADESH", "UTTARAKHAND", "DELHI", "CHANDIGARH", "KASHMIR", "JAMMU"],
  },
  {
    region: "East",
    states: ["WEST BENGAL", "BIHAR", "JHARKHAND", "ODISHA", "ASSAM"],
  },
  {
    region: "South",
    states: ["KERALA", "TAMIL NADU", "AP", "TELANGANA", "KARNATAKA", "GOA"],
  },
  {
    region: "West",
    states: ["MAHARASHTRA", "GUJARAT", "MADHYA PRADESH", "CHHATTISGARH"],
  },
];

export const ALL_STATES = REGION_GROUPS.flatMap((g) => g.states);

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

export default function StateFilter({ selected, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Normalise any legacy raw split-variant values to canonical names.
  // This is a safety net for URL state that predates the canonical-names convention.
  const normSelected = selected.length === 0
    ? []
    : [...new Set(selected.map(toCanonical))];

  const isAll = normSelected.length === 0;

  function toggle(state: string) {
    if (normSelected.includes(state)) {
      onChange(normSelected.filter((s) => s !== state));
    } else {
      onChange([...normSelected, state]);
    }
  }

  function toggleRegion(regionStates: string[]) {
    const allIn = regionStates.every((s) => normSelected.includes(s));
    if (allIn) {
      onChange(normSelected.filter((s) => !regionStates.includes(s)));
    } else {
      const next = [...normSelected];
      for (const s of regionStates) {
        if (!next.includes(s)) next.push(s);
      }
      onChange(next);
    }
  }

  function clearAll() {
    onChange([]);
  }

  // Label for the trigger button
  let label = "All States";
  if (!isAll) {
    const matchingRegion = REGION_GROUPS.find(
      (g) => g.states.every((s) => normSelected.includes(s)) && g.states.length === normSelected.length,
    );
    if (matchingRegion) {
      label = matchingRegion.region;
    } else if (normSelected.length === 1) {
      label = normSelected[0];
    } else {
      label = `${normSelected.length} states`;
    }
  }

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted transition-colors whitespace-nowrap"
      >
        <span className={isAll ? "text-muted-foreground" : ""}>{label}</span>
        {!isAll && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); clearAll(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); clearAll(); } }}
            className="ml-0.5 rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </span>
        )}
        <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover shadow-lg">
          {/* All states option */}
          <div className="border-b p-2">
            <button
              type="button"
              onClick={clearAll}
              className={cn(
                "w-full rounded px-2 py-1 text-left text-xs transition-colors",
                isAll ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              All States (no filter)
            </button>
          </div>

          {/* Region groups */}
          <div className="max-h-72 overflow-y-auto p-1.5 space-y-2">
            {REGION_GROUPS.map(({ region, states }) => {
              const allSelected = states.every((s) => selected.includes(s));
              const someSelected = states.some((s) => selected.includes(s));
              return (
                <div key={region}>
                  {/* Region header */}
                  <button
                    type="button"
                    onClick={() => toggleRegion(states)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted"
                  >
                    <span
                      className={cn(
                        "h-3 w-3 flex-shrink-0 rounded border text-[9px] flex items-center justify-center",
                        allSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : someSelected
                          ? "border-primary bg-primary/30"
                          : "border-border",
                      )}
                    >
                      {allSelected ? "✓" : someSelected ? "–" : ""}
                    </span>
                    <span className="text-xs font-semibold">{region}</span>
                  </button>

                  {/* Individual states */}
                  <div className="ml-4 mt-0.5 space-y-0.5">
                    {states.map((state) => {
                      const checked = normSelected.includes(state);
                      return (
                        <button
                          key={state}
                          type="button"
                          onClick={() => toggle(state)}
                          className="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left transition-colors hover:bg-muted"
                        >
                          <span
                            className={cn(
                              "h-3 w-3 flex-shrink-0 rounded border text-[9px] flex items-center justify-center",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {checked ? "✓" : ""}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">{state}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          {!isAll && (
            <div className="border-t px-3 py-1.5 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">{normSelected.length} selected</span>
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] text-primary hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
