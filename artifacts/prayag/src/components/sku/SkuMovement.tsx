import { trunc2 } from "@/lib/trunc";
// SKU Deep Dive — Movement section (K4).
//
// Three sub-views (internal tabs), all fy-driven:
//   Breadth trend — GET /api/sku/breadth-trend?fy   (largest narrowers by value)
//   First orders  — GET /api/sku/first-orders?fy     (first-ever codes per customer)
//   Lost codes    — GET /api/sku/lost-codes?fy       (bought prior FY, gone this FY)
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// ── Types (mirror backend) ──────────────────────────────────────────────────────

export type BreadthTrendPerFy = { fy: string; codes: number; segments: number; net: number };

export type Narrower = {
  customer: string;
  perFy: BreadthTrendPerFy[];
  droppedValue: number;
  droppedCodes: number;
  latestFy: string;
  priorFy: string;
};

export type ProjectExclusionMeta = {
  basis: string;
  bridgedCustomers: number;
  note: string;
};

export type BreadthTrendResult = {
  compared: { latestFy: string; priorFy: string };
  narrowers: Narrower[];
  projectExclusion: ProjectExclusionMeta;
};

export type FirstOrderCode = { code: string; segment: string; firstMonth: string; net: number };

export type FirstOrderCustomer = {
  customer: string;
  codes: FirstOrderCode[];
  totalNet: number;
};

export type FirstOrdersResult = {
  fy: string;
  customers: FirstOrderCustomer[];
};

export type LostCode = {
  customer: string;
  code: string;
  segment: string;
  priorNet: number;
  priorQty: number;
};

export type LostCodesResult = {
  fy: string;
  priorFy: string;
  lost: LostCode[];
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  const cr = n / 1e7;
  if (cr >= 1) return `₹${trunc2(cr)} Cr`;
  const l = n / 1e5;
  if (l >= 1) return `₹${trunc2(l)} L`;
  return `₹${Math.round(n / 1000)}k`;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  fy: string;
  /** Fiscal month range (1–12); passed to every sub-view so the global
      period filter applies (like-months on both compared FYs). */
  monthFrom: number;
  monthTo: number;
  periodLabel: string;
}

/** Query params shared by all Movement endpoints. */
function movementParams(fy: string, monthFrom: number, monthTo: number): URLSearchParams {
  const params = new URLSearchParams({ fy });
  if (monthFrom !== 1 || monthTo !== 12) {
    params.set("monthFrom", String(monthFrom));
    params.set("monthTo", String(monthTo));
  }
  return params;
}

interface ViewProps {
  fy: string;
  monthFrom: number;
  monthTo: number;
}

type SubView = "breadth" | "first" | "lost";

// ── Component ──────────────────────────────────────────────────────────────────

export default function SkuMovement({ fy, monthFrom, monthTo, periodLabel }: Props) {
  const [view, setView] = useState<SubView>("breadth");

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1">
        {([
          ["breadth", "Breadth trend"],
          ["first", "First orders"],
          ["lost", "Lost codes"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
              view === id
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground hidden lg:block">{periodLabel}</span>
      </div>

      {view === "breadth" && <BreadthTrendView fy={fy} monthFrom={monthFrom} monthTo={monthTo} />}
      {view === "first" && <FirstOrdersView fy={fy} monthFrom={monthFrom} monthTo={monthTo} />}
      {view === "lost" && <LostCodesView fy={fy} monthFrom={monthFrom} monthTo={monthTo} />}
    </div>
  );
}

// ── Shared fetch states ──────────────────────────────────────────────────────────

function Loading() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg border bg-muted animate-pulse" />
      ))}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      Failed to load: {msg}
    </div>
  );
}

// ── Breadth trend ────────────────────────────────────────────────────────────────

function BreadthTrendView({ fy, monthFrom, monthTo }: ViewProps) {
  const [data, setData] = useState<BreadthTrendResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = movementParams(fy, monthFrom, monthTo);
    fetch(`${BASE}/api/sku/breadth-trend?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BreadthTrendResult>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [fy, monthFrom, monthTo]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (!data || !Array.isArray(data.narrowers) || data.narrowers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No narrowing customers found for FY {fy} vs prior.
      </p>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 pt-3 pb-2 border-b">
        <h3 className="text-sm font-semibold">Largest narrowers by value</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          prior-FY value of codes no longer bought — a leading indicator annual totals will not show
          for months
        </p>
        <p className="text-xs text-muted-foreground/80 mt-0.5">
          {data.compared.priorFy} → {data.compared.latestFy}
        </p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead className="py-1.5 pl-4">Customer</TableHead>
              <TableHead className="py-1.5">Codes per FY</TableHead>
              <TableHead className="py-1.5 text-right">Dropped codes</TableHead>
              <TableHead className="py-1.5 text-right pr-4">Dropped value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.narrowers.map((n) => (
              <TableRow key={n.customer}>
                <TableCell className="py-1.5 pl-4 text-xs max-w-[220px] truncate">
                  {n.customer}
                </TableCell>
                <TableCell className="py-1.5 text-xs tabular-nums whitespace-nowrap text-muted-foreground">
                  {n.perFy.map((p, i) => (
                    <span key={p.fy}>
                      {i > 0 && <span className="mx-1 text-muted-foreground/50">→</span>}
                      <span title={`FY ${p.fy}`} className="text-foreground">
                        {p.codes.toLocaleString()}
                      </span>
                    </span>
                  ))}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs tabular-nums">
                  {n.droppedCodes.toLocaleString()}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs tabular-nums whitespace-nowrap pr-4 font-medium text-red-600 dark:text-red-400">
                  {fmtCr(n.droppedValue)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data.projectExclusion?.note && (
        <p className="px-4 py-2 text-xs text-muted-foreground border-t">{data.projectExclusion.note}</p>
      )}
    </div>
  );
}

// ── First orders ─────────────────────────────────────────────────────────────────

function FirstOrdersView({ fy, monthFrom, monthTo }: ViewProps) {
  const [data, setData] = useState<FirstOrdersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = movementParams(fy, monthFrom, monthTo);
    fetch(`${BASE}/api/sku/first-orders?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FirstOrdersResult>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [fy, monthFrom, monthTo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function toggle(customer: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(customer)) next.delete(customer);
      else next.add(customer);
      return next;
    });
  }

  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (!data || !Array.isArray(data.customers) || data.customers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No first-ever codes recorded for FY {fy}.
      </p>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 pt-3 pb-2 border-b">
        <h3 className="text-sm font-semibold">First orders</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          customers who bought a code for the first time ever in FY {data.fy}
        </p>
      </div>
      <div className="divide-y">
        {data.customers.map((c) => {
          const open = expanded.has(c.customer);
          return (
            <div key={c.customer}>
              <button
                type="button"
                onClick={() => toggle(c.customer)}
                className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/30 transition-colors"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground flex-shrink-0 transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="text-xs font-medium min-w-0 truncate flex-1">{c.customer}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {c.codes.length} first-ever code{c.codes.length === 1 ? "" : "s"}
                </span>
                <span className="text-xs tabular-nums font-medium whitespace-nowrap ml-2 w-24 text-right">
                  {fmtCr(c.totalNet)}
                </span>
              </button>
              {open && (
                <div className="overflow-x-auto border-t bg-muted/10">
                  <Table>
                    <TableHeader>
                      <TableRow className="text-xs">
                        <TableHead className="py-1.5 pl-10">Code</TableHead>
                        <TableHead className="py-1.5 hidden sm:table-cell">Segment</TableHead>
                        <TableHead className="py-1.5 text-right">First month</TableHead>
                        <TableHead className="py-1.5 text-right pr-4">Net</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.codes.map((code) => (
                        <TableRow key={code.code}>
                          <TableCell className="py-1.5 pl-10 font-mono text-xs whitespace-nowrap">
                            {code.code}
                          </TableCell>
                          <TableCell className="py-1.5 text-xs text-muted-foreground hidden sm:table-cell max-w-[180px] truncate">
                            {code.segment}
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs text-muted-foreground whitespace-nowrap">
                            {code.firstMonth}
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs tabular-nums whitespace-nowrap pr-4">
                            {fmtCr(code.net)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Lost codes ───────────────────────────────────────────────────────────────────

function LostCodesView({ fy, monthFrom, monthTo }: ViewProps) {
  const [data, setData] = useState<LostCodesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = movementParams(fy, monthFrom, monthTo);
    fetch(`${BASE}/api/sku/lost-codes?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LostCodesResult>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [fy, monthFrom, monthTo]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (!data || !Array.isArray(data.lost) || data.lost.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No lost codes found for FY {fy}.
      </p>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 pt-3 pb-2 border-b">
        <h3 className="text-sm font-semibold">
          Lost codes — bought in {data.priorFy}, absent in {data.fy}, ranked by prior-year value
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          the warmest list available: proven demand, known customer
        </p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead className="py-1.5 pl-4">Customer</TableHead>
              <TableHead className="py-1.5">Code</TableHead>
              <TableHead className="py-1.5 hidden sm:table-cell">Segment</TableHead>
              <TableHead className="py-1.5 text-right hidden md:table-cell">Prior qty</TableHead>
              <TableHead className="py-1.5 text-right pr-4">Prior net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.lost.map((l, i) => (
              <TableRow key={`${l.customer}|${l.code}|${i}`}>
                <TableCell className="py-1.5 pl-4 text-xs max-w-[220px] truncate">
                  {l.customer}
                </TableCell>
                <TableCell className="py-1.5 font-mono text-xs whitespace-nowrap">
                  {l.code}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-muted-foreground hidden sm:table-cell max-w-[160px] truncate">
                  {l.segment}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground hidden md:table-cell whitespace-nowrap">
                  {l.priorQty.toLocaleString()}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs tabular-nums whitespace-nowrap pr-4 font-medium">
                  {fmtCr(l.priorNet)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
