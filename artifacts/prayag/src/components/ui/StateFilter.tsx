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

export const REGION_GROUPS: { region: string; states: string[] }[] = [
  {
    region: "North",
    states: [
      "UTTAR PRADESH",
      "UP ( A )",
      "UP (AS)",
      "HARYANA",
      "PUNJAB",
      "RAJASTHAN",
      "HIMACHAL PRADESH",
      "UTTARAKHAND",
      "DELHI A",
      "DELHI NCR",
      "CHANDIGARH",
      "KASHMIR",
      "JAMMU",
    ],
  },
  {
    region: "East",
    states: [
      "WEST BENGAL",
      "BIHAR",
      "JHARKHAND",
      "ODISHA",
      "ASSAM",
    ],
  },
  {
    region: "South",
    states: [
      "KERALA",
      "TAMIL NADU",
      "AP",
      "TELANGANA",
      "KARNATAKA",
      "KARNATAKA (B)",
      "GOA",
    ],
  },
  {
    region: "West",
    states: [
      "MAHARASHTRA",
      "GUJARAT",
      "MADHYA PRADESH",
      "CHHATTISGARH",
    ],
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

  const isAll = selected.length === 0;

  function toggle(state: string) {
    if (selected.includes(state)) {
      onChange(selected.filter((s) => s !== state));
    } else {
      onChange([...selected, state]);
    }
  }

  function toggleRegion(states: string[]) {
    const allIn = states.every((s) => selected.includes(s));
    if (allIn) {
      // Deselect all in region
      onChange(selected.filter((s) => !states.includes(s)));
    } else {
      // Select all in region (add missing)
      const next = [...selected];
      for (const s of states) {
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
    // Check if an entire region is selected
    const matchingRegion = REGION_GROUPS.find(
      (g) => g.states.every((s) => selected.includes(s)) && g.states.length === selected.length,
    );
    if (matchingRegion) {
      label = matchingRegion.region;
    } else if (selected.length === 1) {
      label = selected[0];
    } else {
      label = `${selected.length} states`;
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
                      const checked = selected.includes(state);
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
              <span className="text-[10px] text-muted-foreground">{selected.length} selected</span>
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
