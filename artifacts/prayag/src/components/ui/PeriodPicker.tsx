// PeriodPicker — shared period-selection control for sales/customer views.
//
// Modes:
//   preset  — Full year / Q1–Q4 / H1–H2 (existing behaviour)
//   monthly — single month chosen from a dropdown of available months
//   custom  — from-month to to-month, both constrained to available months
//
// The component is purely controlled: it calls `onChange` with the resolved
// month list whenever the selection changes.  The parent owns the state.
import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

const MONTH_ORDER = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"] as const;

type Mode = "preset" | "monthly" | "custom";
export type PeriodPreset = "full" | "Q1" | "Q2" | "Q3" | "Q4" | "H1" | "H2";

export interface PeriodValue {
  mode: Mode;
  preset: PeriodPreset;
  singleMonth: string;   // used in monthly mode
  fromMonth: string;     // used in custom mode
  toMonth: string;       // used in custom mode
}

interface Props {
  /** All months that exist in the DB for the selected FY, e.g. ["Apr-26","May-26"] */
  availableMonths: string[];
  /** Subset of availableMonths that are complete (no in-progress months). */
  completeMonths: string[];
  /** Currently selected FY, e.g. "2026-27" */
  fy: string;
  value: PeriodValue;
  onChange: (next: PeriodValue) => void;
}

// Build all 12 canonical month labels for a given FY.
function allFyMonths(fy: string): string[] {
  const year = parseInt(fy.split("-")[0], 10);
  const yy = String(year).slice(-2);
  const nyy = String(year + 1).slice(-2);
  return MONTH_ORDER.map((m) =>
    ["Jan","Feb","Mar"].includes(m) ? `${m}-${nyy}` : `${m}-${yy}`,
  );
}

function presetMonths(fy: string, preset: PeriodPreset, complete: string[]): string[] {
  if (preset === "full") return complete;
  const all = allFyMonths(fy);
  const slices: Record<PeriodPreset, number[]> = {
    full: [],
    Q1: [0, 3], Q2: [3, 6], Q3: [6, 9], Q4: [9, 12],
    H1: [0, 6], H2: [6, 12],
  };
  const [s, e] = slices[preset];
  return all.slice(s, e).filter((m) => complete.includes(m));
}

// Months from fromMonth to toMonth inclusive (respects fiscal ordering).
function rangeMonths(all: string[], from: string, to: string): string[] {
  const fi = all.indexOf(from);
  const ti = all.indexOf(to);
  if (fi === -1 || ti === -1 || fi > ti) return [];
  return all.slice(fi, ti + 1);
}

function resolve(value: PeriodValue, fy: string, complete: string[], available: string[]): string[] {
  if (value.mode === "preset") return presetMonths(fy, value.preset, complete);
  if (value.mode === "monthly") return value.singleMonth ? [value.singleMonth] : [];
  // custom — use available (include in-progress for custom ranges, user chose explicitly)
  return rangeMonths(available, value.fromMonth, value.toMonth);
}

// Default initial value — Q1 preset.
export function defaultPeriodValue(): PeriodValue {
  return { mode: "preset", preset: "Q1", singleMonth: "", fromMonth: "", toMonth: "" };
}

const PRESET_LABELS: { value: PeriodPreset; label: string }[] = [
  { value: "full", label: "Full year" },
  { value: "Q1",   label: "Q1 (Apr-Jun)" },
  { value: "Q2",   label: "Q2 (Jul-Sep)" },
  { value: "Q3",   label: "Q3 (Oct-Dec)" },
  { value: "Q4",   label: "Q4 (Jan-Mar)" },
  { value: "H1",   label: "H1 (Apr-Sep)" },
  { value: "H2",   label: "H2 (Oct-Mar)" },
];

export default function PeriodPicker({ availableMonths, completeMonths, fy, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Seed singleMonth / fromMonth / toMonth from available months when first opened.
  function ensureDefaults(next: PeriodValue): PeriodValue {
    const first = availableMonths[0] ?? "";
    const last  = availableMonths[availableMonths.length - 1] ?? "";
    return {
      ...next,
      singleMonth: next.singleMonth || first,
      fromMonth:   next.fromMonth   || first,
      toMonth:     next.toMonth     || last,
    };
  }

  function emit(next: PeriodValue) {
    onChange(next);
  }

  function setMode(mode: Mode) {
    const next = ensureDefaults({ ...value, mode });
    emit(next);
  }

  function setPreset(preset: PeriodPreset) {
    const next: PeriodValue = { ...value, mode: "preset", preset };
    emit(next);
    setOpen(false);
  }

  function setSingle(month: string) {
    const next: PeriodValue = { ...value, mode: "monthly", singleMonth: month };
    emit(next);
  }

  function setFrom(month: string) {
    // Ensure toMonth >= fromMonth in fiscal order.
    const all = availableMonths;
    let to = value.toMonth;
    if (all.indexOf(to) < all.indexOf(month)) to = month;
    const next: PeriodValue = { ...value, mode: "custom", fromMonth: month, toMonth: to };
    emit(next);
  }

  function setTo(month: string) {
    const all = availableMonths;
    let from = value.fromMonth;
    if (all.indexOf(from) > all.indexOf(month)) from = month;
    const next: PeriodValue = { ...value, mode: "custom", fromMonth: from, toMonth: month };
    emit(next);
  }

  // Label shown on the pill.
  const resolved = resolve(value, fy, completeMonths, availableMonths);
  let label = "Select period";
  if (value.mode === "preset") {
    label = PRESET_LABELS.find((p) => p.value === value.preset)?.label ?? "Full year";
  } else if (value.mode === "monthly") {
    label = value.singleMonth || "Pick month";
  } else {
    label = value.fromMonth && value.toMonth
      ? value.fromMonth === value.toMonth
        ? value.fromMonth
        : `${value.fromMonth} – ${value.toMonth}`
      : "Custom range";
  }
  if (resolved.length === 0 && value.mode !== "preset") label += " (no data)";

  return (
    <div className="relative" ref={ref}>
      {/* Trigger pill */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted transition-colors"
      >
        {label}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border bg-popover shadow-lg">
          {/* Mode tabs */}
          <div className="flex border-b">
            {(["preset", "monthly", "custom"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 py-1.5 text-[11px] font-medium capitalize transition-colors ${
                  value.mode === m
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "preset" ? "Preset" : m === "monthly" ? "Monthly" : "Custom"}
              </button>
            ))}
          </div>

          <div className="p-2">
            {/* Preset mode */}
            {value.mode === "preset" && (
              <div className="grid grid-cols-2 gap-1">
                {PRESET_LABELS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPreset(p.value)}
                    className={`rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      value.preset === p.value
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {/* Monthly mode */}
            {value.mode === "monthly" && (
              <div>
                <p className="mb-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                  Pick a month
                </p>
                <select
                  value={value.singleMonth || availableMonths[0] || ""}
                  onChange={(e) => setSingle(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-xs"
                  size={Math.min(availableMonths.length, 8)}
                >
                  {availableMonths.map((m) => (
                    <option key={m} value={m}>
                      {m}{!completeMonths.includes(m) ? " (in progress)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Custom range mode */}
            {value.mode === "custom" && (
              <div className="space-y-2">
                <div>
                  <label className="block text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
                    From
                  </label>
                  <select
                    value={value.fromMonth || availableMonths[0] || ""}
                    onChange={(e) => setFrom(e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-xs"
                  >
                    {availableMonths.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
                    To
                  </label>
                  <select
                    value={value.toMonth || availableMonths[availableMonths.length - 1] || ""}
                    onChange={(e) => setTo(e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-xs"
                  >
                    {availableMonths.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                {resolved.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {resolved.length} month{resolved.length !== 1 ? "s" : ""} selected
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="w-full rounded bg-primary px-2 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
