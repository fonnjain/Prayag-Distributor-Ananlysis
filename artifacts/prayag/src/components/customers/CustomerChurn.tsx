// Customer Churn & New — two-panel view.
// Churned: ordered last period but not this period.
// New: appear this period but had no orders in the corresponding LY period.
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
import { fmtQty, fmtVal } from "./formatters";

type ChurnRow = {
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

function ChurnTable({ rows, valueLabel }: { rows: ChurnRow[]; valueLabel: string }) {
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
            <TableHead className="text-right">Last Order</TableHead>
            <TableHead className="text-right">Qty (pcs)</TableHead>
            <TableHead className="text-right">{valueLabel}</TableHead>
            <TableHead className="text-right">Months active</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.customer}>
              <TableCell className="font-medium">{row.customer}</TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs font-normal">
                  {ENTITY_LABELS[row.entityType] ?? row.entityType}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">
                {row.lastOrderDate ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {fmtQty(row.qtyLy)}
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

export default function CustomerChurn({
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
  const [churned, setChurned] = useState<ChurnRow[]>([]);
  const [newCust, setNewCust] = useState<ChurnRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"churned" | "new">("churned");

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

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
        setChurned(d.churned ?? []);
        setNewCust(d.newCustomers ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fyCy, fyLy, monthsCy.join(","), monthsLy.join(","), entityType]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Button
          variant={tab === "churned" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("churned")}
        >
          Churned ({churned.length})
        </Button>
        <Button
          variant={tab === "new" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("new")}
        >
          New ({newCust.length})
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {tab === "churned"
          ? `Customers who ordered in the same period of ${fyLy} but have no orders yet in ${fyCy}.`
          : `Customers who ordered in ${fyCy} but had no orders in the corresponding ${fyLy} period.`}
      </p>
      {loading ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          Loading...
        </div>
      ) : tab === "churned" ? (
        <ChurnTable rows={churned} valueLabel={`Value ${fyLy}`} />
      ) : (
        <ChurnTable rows={newCust} valueLabel={`Value ${fyCy}`} />
      )}
    </div>
  );
}
