// Cascading entity filters for the Company Reports page.
// State Head → States (of the selected heads) → Distributors (of the selected
// heads + states). Options come from /api/company-reports/filters and are the
// exact sale_line values the backend filter matches against.
//
// Empty selection = All (no filter applied). Each dropdown has Select all /
// Clear all. Selections are pruned automatically when a parent filter narrows.
import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import StateFilter from "../ui/StateFilter";

export type EntityFilterValue = {
  heads: string[];
  states: string[];
  customers: string[];
};

export const EMPTY_ENTITY_FILTER: EntityFilterValue = { heads: [], states: [], customers: [] };

export function hasEntityFilter(v: EntityFilterValue): boolean {
  return v.heads.length > 0 || v.states.length > 0 || v.customers.length > 0;
}

/** Query-string fragment (leading "&" included when non-empty). */
export function entityFilterQuery(v: EntityFilterValue): string {
  const parts: string[] = [];
  if (v.heads.length > 0) parts.push(`heads=${encodeURIComponent(JSON.stringify(v.heads))}`);
  if (v.states.length > 0) parts.push(`states=${encodeURIComponent(JSON.stringify(v.states))}`);
  if (v.customers.length > 0) parts.push(`customers=${encodeURIComponent(JSON.stringify(v.customers))}`);
  return parts.length > 0 ? `&${parts.join("&")}` : "";
}

type FilterTree = {
  fy: string;
  heads: Array<{ head: string; states: Array<{ state: string; customers: string[] }> }>;
};

// ── Multi-select dropdown ─────────────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const shown = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const selSet = useMemo(() => new Set(selected), [selected]);
  const summary = selected.length === 0
    ? "All"
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  const toggle = (opt: string) => {
    onChange(selSet.has(opt) ? selected.filter((s) => s !== opt) : [...selected, opt]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs bg-background hover:bg-muted/40",
          selected.length > 0 ? "border-primary/50 text-foreground" : "border-border text-muted-foreground",
        )}
        data-testid={`filter-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="font-medium">{label}:</span>
        <span className="max-w-[140px] truncate">{summary}</span>
        {selected.length > 0 && (
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

      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-2 py-1.5 text-[11px]">
            <button className="text-primary hover:underline" onClick={() => onChange([...options])}>
              Select all{query ? "" : ` (${options.length})`}
            </button>
            <button className="text-muted-foreground hover:underline" onClick={() => onChange([])}>
              Clear all
            </button>
          </div>
          {searchable && (
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
              <Search className="h-3 w-3 text-muted-foreground" />
              <input
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className="max-h-64 overflow-auto py-1">
            {shown.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>
            )}
            {shown.map((opt) => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={selSet.has(opt)}
                  onChange={() => toggle(opt)}
                />
                <span className="truncate">{opt}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

export function CompanyReportFilterBar({
  fy,
  value,
  onChange,
  showCustomers = true,
  showHeads = true,
}: {
  fy: string;
  value: EntityFilterValue;
  onChange: (next: EntityFilterValue) => void;
  /** Hide the Distributor level for pages whose data has no distributor dimension. */
  showCustomers?: boolean;
  /** Hide the State Head level for pages that already have a dedicated head scope control. */
  showHeads?: boolean;
}) {
  const [tree, setTree] = useState<FilterTree | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(false);
    fetch(`/api/company-reports/filters?fy=${encodeURIComponent(fy)}`)
      .then((r) => (r.ok ? (r.json() as Promise<FilterTree>) : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (!cancelled) setTree(t); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [fy]);

  // Cascade: options for each level respect the selections above it.
  const headOptions = useMemo(() => (tree ? tree.heads.map((h) => h.head) : []), [tree]);

  const activeHeads = useMemo(() => {
    if (!tree) return [];
    return value.heads.length > 0 ? tree.heads.filter((h) => value.heads.includes(h.head)) : tree.heads;
  }, [tree, value.heads]);

  const stateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const h of activeHeads) for (const st of h.states) s.add(st.state);
    return [...s].sort();
  }, [activeHeads]);

  const customerOptions = useMemo(() => {
    const c = new Set<string>();
    for (const h of activeHeads) {
      for (const st of h.states) {
        if (value.states.length > 0 && !value.states.includes(st.state)) continue;
        for (const cust of st.customers) c.add(cust);
      }
    }
    return [...c].sort();
  }, [activeHeads, value.states]);

  // Prune selections a parent change (or FY switch → new tree) made
  // unavailable — including heads, so a stale head from the previous FY never
  // silently scopes the report to nothing.
  useEffect(() => {
    if (!tree) return;
    const headSet = new Set(headOptions);
    const stateSet = new Set(stateOptions);
    const custSet = new Set(customerOptions);
    const heads = value.heads.filter((h) => headSet.has(h));
    const states = value.states.filter((s) => stateSet.has(s));
    const customers = value.customers.filter((c) => custSet.has(c));
    if (heads.length !== value.heads.length || states.length !== value.states.length || customers.length !== value.customers.length) {
      onChange({ heads, states, customers });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, headOptions, stateOptions, customerOptions]);

  if (error) {
    return <p className="text-[11px] text-muted-foreground">Filters unavailable — showing all data.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showHeads && (
        <MultiSelect
          label="State Head"
          options={headOptions}
          selected={value.heads}
          onChange={(heads) => onChange({ ...value, heads })}
        />
      )}
      <StateFilter
        selected={value.states}
        onChange={(states) => onChange({ ...value, states })}
        available={stateOptions.length > 0 ? new Set(stateOptions) : undefined}
        label="State"
      />
      {showCustomers && (
        <MultiSelect
          label="Distributor"
          options={customerOptions}
          selected={value.customers}
          onChange={(customers) => onChange({ ...value, customers })}
          searchable
        />
      )}
      {hasEntityFilter(value) && (
        <button
          className="text-[11px] text-muted-foreground underline hover:text-foreground"
          onClick={() => onChange(EMPTY_ENTITY_FILTER)}
        >
          Reset filters
        </button>
      )}
      {!tree && !error && <span className="text-[11px] text-muted-foreground">Loading filter options…</span>}
    </div>
  );
}
