// Customer At-Risk & New — two-panel view.
//
// At-risk: customers whose days since last order exceed their own historical
// median inter-order gap by 1.2× or more. Seasonal buyers whose normal gap is
// longer than the current period are not flagged — no customer is labelled
// "churned" mid-year.
//
// New: appeared in CY period but had no orders in the corresponding LY period.
import { useState, useEffect } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtVal } from "./formatters";

type AtRiskRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  medianGap: number;
  daysSinceLast: number;
  lastOrderDate: string | null;
  gapRatio: number;
  riskLevel: "high" | "mild";
};

type NewRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  lastOrderDate: string | null;
  qtyLy: number;
  valLy: number;
  monthsOrdered: number;
};

const ENTITY_LABELS: Record<string, string> = {
  distributor: "Distributor",
  direct_dealer: "Dealer",
  retailer: "Retailer",
  unknown: "—",
};

function AtRiskTable({ rows }: { rows: AtRiskRow[] }) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No at-risk customers found for this filter.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Risk</TableHead>
            <TableHead className="text-right">Normal gap</TableHead>
            <TableHead className="text-right">Days silent</TableHead>
            <TableHead className="text-right">Gap ratio</TableHead>
            <TableHead className="text-right">Last order</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.customer}>
              <TableCell className="font-medium max-w-[220px] truncate">
                {row.customer}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs font-normal">
                  {ENTITY_LABELS[row.entityType] ?? row.entityType}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Badge
                  className={
                    row.riskLevel === "high"
                      ? "bg-red-100 text-red-700 border border-red-300 dark:bg-red-950 dark:text-red-300 text-xs font-normal"
                      : "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 text-xs font-normal"
                  }
                >
                  {row.riskLevel === "high" ? "High" : "Mild"}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">
                {row.medianGap}d
              </TableCell>
              <TableCell
                className={`text-right font-mono text-sm font-semibold ${
                  row.riskLevel === "high"
                    ? "text-red-600 dark:text-red-400"
                    : "text-amber-700 dark:text-amber-400"
                }`}
              >
                {row.daysSinceLast}d
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">
                {row.gapRatio.toFixed(1)}×
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {row.lastOrderDate ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function NewTable({ rows, fyCy }: { rows: NewRow[]; fyCy: string }) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        None found for this period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Last order</TableHead>
            <TableHead className="text-right">Value {fyCy}</TableHead>
            <TableHead className="text-right">Months active</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.customer}>
              <TableCell className="font-medium max-w-[220px] truncate">
                {row.customer}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs font-normal">
                  {ENTITY_LABELS[row.entityType] ?? row.entityType}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {row.lastOrderDate ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {fmtVal(row.valLy)}
              </TableCell>
              <TableCell className="text-right text-sm">
                {row.monthsOrdered}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CustomerAtRisk({
  fyCy,
  fyLy,
  monthsCy,
  monthsLy,
  entityType,
}: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType: string;
}) {
  const [atRisk, setAtRisk] = useState<AtRiskRow[]>([]);
  const [newCust, setNewCust] = useState<NewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"atRisk" | "new">("atRisk");

  const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

  useEffect(() => {
    if (!monthsCy.length) return;
    setLoading(true);
    const params = new URLSearchParams({
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      entityType,
    });
    fetch(`${BASE}/api/customers/churn?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setAtRisk(d.atRisk ?? []);
        setNewCust(d.newCustomers ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), entityType]);

  const highCount = atRisk.filter((r) => r.riskLevel === "high").length;
  const mildCount = atRisk.filter((r) => r.riskLevel === "mild").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 flex-wrap">
        <Button
          variant={tab === "atRisk" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("atRisk")}
        >
          At Risk ({atRisk.length})
        </Button>
        <Button
          variant={tab === "new" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("new")}
        >
          New ({newCust.length})
        </Button>
      </div>

      {tab === "atRisk" ? (
        <>
          {atRisk.length > 0 && (
            <div className="flex gap-3 text-xs text-muted-foreground">
              {highCount > 0 && (
                <span className="text-red-600 dark:text-red-400 font-medium">
                  {highCount} high risk (&gt;2× gap)
                </span>
              )}
              {mildCount > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {mildCount} mild risk (1.2–2× gap)
                </span>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Customers scored against their own historical median inter-order gap.
            Seasonal buyers and new customers are excluded automatically —
            only those silent beyond their own normal cycle appear here.
            Gap ratio = days silent / normal gap; high risk means &gt;2×.
          </p>
          {loading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : (
            <AtRiskTable rows={atRisk} />
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Customers who ordered in {fyCy} but had no orders in the
            corresponding {fyLy} period. Comparing{" "}
            {monthsCy.length > 0
              ? `${monthsCy[0]}–${monthsCy[monthsCy.length - 1]}`
              : "selected period"}{" "}
            vs same months in {fyLy}.
          </p>
          {loading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : (
            <NewTable rows={newCust} fyCy={fyCy} />
          )}
        </>
      )}
    </div>
  );
}
