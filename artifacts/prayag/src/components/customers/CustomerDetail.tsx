// Customer Detail — category and product drill-down for a selected customer.
// Same units-first rule applies throughout.
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmtQty, fmtVal, fmtPct, fmtPrice, fmtPp, pctColor } from "./formatters";

type CategoryRow = {
  category: string;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  priceCy: number | null;
  priceLy: number | null;
  qtyGrowthPct: number | null;
  valGrowthPct: number | null;
  priceChangePct: number | null;
  priceEffectPp: number | null;
  revenueUpVolumeDown: boolean;
};

type ProductRow = CategoryRow & {
  code: string;
  itemName: string | null;
};

function DrillTable<T extends { revenueUpVolumeDown: boolean }>({
  rows,
  columns,
  fyCy,
  fyLy,
  onRowClick,
}: {
  rows: T[];
  columns: Array<{ key: keyof T; label: string }>;
  fyCy: string;
  fyLy: string;
  onRowClick?: (row: T) => void;
}) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        No data.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={String(c.key)}
                className="whitespace-nowrap text-right first:text-left"
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow
              key={i}
              className={[
                onRowClick ? "cursor-pointer hover:bg-muted/50" : "",
                row.revenueUpVolumeDown ? "bg-red-50/60 dark:bg-red-950/20" : "",
              ].join(" ")}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((c, ci) => {
                const val = row[c.key];
                if (ci === 0) {
                  return (
                    <TableCell key={String(c.key)} className="font-medium">
                      {String(val ?? "—")}
                      {onRowClick && (
                        <ChevronRight className="inline ml-1 h-3 w-3 text-muted-foreground" />
                      )}
                    </TableCell>
                  );
                }
                if (c.key === "revenueUpVolumeDown") return null;
                return (
                  <TableCell key={String(c.key)} className="text-right font-mono text-sm">
                    {String(val ?? "—")}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CustomerDetail({
  customer,
  fyCy,
  fyLy,
  monthsCy,
  monthsLy,
  onClose,
}: {
  customer: string;
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  onClose: () => void;
}) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [catData, setCatData] = useState<CategoryRow[]>([]);
  const [prodData, setProdData] = useState<ProductRow[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [prodLoading, setProdLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  // Fetch categories on first render
  if (!fetched) {
    setFetched(true);
    setCatLoading(true);
    const params = new URLSearchParams({
      customer,
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
    });
    fetch(`${BASE}/api/customers/detail?${params}`)
      .then((r) => r.json())
      .then((d) => setCatData(d.data ?? []))
      .catch(() => {})
      .finally(() => setCatLoading(false));
  }

  function fetchProducts(category: string) {
    setProdLoading(true);
    setSelectedCategory(category);
    const params = new URLSearchParams({
      customer,
      fyCy,
      fyLy,
      monthsCy: monthsCy.join(","),
      monthsLy: monthsLy.join(","),
      category,
    });
    fetch(`${BASE}/api/customers/detail?${params}`)
      .then((r) => r.json())
      .then((d) => setProdData(d.data ?? []))
      .catch(() => {})
      .finally(() => setProdLoading(false));
  }

  const catColumns: Array<{ key: keyof CategoryRow; label: string }> = [
    { key: "category", label: "Category" },
    { key: "qtyCy", label: `Qty ${fyCy}` },
    { key: "qtyLy", label: `Qty ${fyLy}` },
    { key: "qtyGrowthPct", label: "Qty %" },
    { key: "valCy", label: `Value ${fyCy}` },
    { key: "valGrowthPct", label: "Value %" },
    { key: "priceChangePct", label: "Price %" },
    { key: "priceEffectPp", label: "Price effect" },
  ];

  const formattedCat: (CategoryRow & { [k: string]: unknown })[] = catData.map((r) => ({
    ...r,
    qtyCy: fmtQty(r.qtyCy) as unknown as number,
    qtyLy: fmtQty(r.qtyLy) as unknown as number,
    qtyGrowthPct: fmtPct(r.qtyGrowthPct) as unknown as number,
    valCy: fmtVal(r.valCy) as unknown as number,
    valGrowthPct: fmtPct(r.valGrowthPct) as unknown as number,
    priceChangePct: fmtPct(r.priceChangePct) as unknown as number,
    priceEffectPp: fmtPp(r.priceEffectPp) as unknown as number,
  }));

  const prodColumns: Array<{ key: keyof ProductRow; label: string }> = [
    { key: "code", label: "Code" },
    { key: "itemName", label: "Product" },
    { key: "qtyCy", label: `Qty ${fyCy}` },
    { key: "qtyLy", label: `Qty ${fyLy}` },
    { key: "qtyGrowthPct", label: "Qty %" },
    { key: "valCy", label: `Value ${fyCy}` },
    { key: "valGrowthPct", label: "Value %" },
    { key: "priceCy", label: `Price ${fyCy}` },
    { key: "priceLy", label: `Price ${fyLy}` },
    { key: "priceChangePct", label: "Price %" },
    { key: "priceEffectPp", label: "Price effect" },
  ];

  const formattedProd: (ProductRow & { [k: string]: unknown })[] = prodData.map((r) => ({
    ...r,
    qtyCy: fmtQty(r.qtyCy) as unknown as number,
    qtyLy: fmtQty(r.qtyLy) as unknown as number,
    qtyGrowthPct: fmtPct(r.qtyGrowthPct) as unknown as number,
    valCy: fmtVal(r.valCy) as unknown as number,
    valGrowthPct: fmtPct(r.valGrowthPct) as unknown as number,
    priceCy: fmtPrice(r.priceCy) as unknown as number,
    priceLy: fmtPrice(r.priceLy) as unknown as number,
    priceChangePct: fmtPct(r.priceChangePct) as unknown as number,
    priceEffectPp: fmtPp(r.priceEffectPp) as unknown as number,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {selectedCategory && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCategory(null)}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Categories
            </Button>
          )}
          <h3 className="font-semibold text-sm">
            {customer}
            {selectedCategory && (
              <span className="text-muted-foreground font-normal"> / {selectedCategory}</span>
            )}
          </h3>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {!selectedCategory && (
        <>
          {catLoading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading categories...
            </div>
          ) : (
            <DrillTable
              rows={formattedCat}
              columns={catColumns}
              fyCy={fyCy}
              fyLy={fyLy}
              onRowClick={(r) => fetchProducts(r.category)}
            />
          )}
        </>
      )}

      {selectedCategory && (
        <>
          {prodLoading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading products...
            </div>
          ) : (
            <DrillTable
              rows={formattedProd}
              columns={prodColumns}
              fyCy={fyCy}
              fyLy={fyLy}
            />
          )}
        </>
      )}
    </div>
  );
}
