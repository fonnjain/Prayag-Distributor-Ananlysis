// Scheme Dashboard — configurable scheme engine.
// Shows per-entity tracking, push list (the prioritized call list), and scheme admin.
// No schemes are hardcoded — the client supplies them via the admin form.
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtVal, fmtQty } from "./formatters";

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

type Slab = {
  id?: number;
  slabOrder: number;
  threshold: string;
  benefitType: "pct" | "flat";
  benefitValue: string;
};

type Scheme = {
  id: number;
  name: string;
  description?: string;
  appliesTo: string[];
  periodType: string;
  fy?: string;
  periodStart?: string;
  periodEnd?: string;
  basis: "value" | "qty";
  scopeType: string;
  usePriceMultiplier: boolean;
  desiredRealGrowthPct?: string;
  active: boolean;
  slabs: Slab[];
};

type TrackingRow = {
  customer: string;
  achievement: number;
  deflatedAchievement: number | null;
  currentSlabIdx: number;
  nextSlabIdx: number;
  distanceToNextSlab: number | null;
  daysRemaining: number;
  projectedTotal: number;
  willReachNextSlab: boolean | null;
  currentBenefitValue: number | null;
  nextBenefitValue: number | null;
  multiplier: number | null;
  multiplierLevel: string | null;
};

type PushEntry = {
  customer: string;
  achievement: number;
  nextSlabThreshold: number;
  distanceToNextSlab: number;
  daysRemaining: number;
  projectedTotal: number;
  projectedShortfall: number;
  willReachNextSlab: boolean;
  nextBenefitValue: number | null;
  effortToRewardScore: number;
};

// ── Scheme list + admin ───────────────────────────────────────────────────────

function SchemeAdmin({
  schemes,
  onCreated,
}: {
  schemes: Scheme[];
  onCreated: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [fy, setFy] = useState("2026-27");
  const [basis, setBasis] = useState<"value" | "qty">("value");
  const [appliesTo, setAppliesTo] = useState<string[]>(["distributor"]);
  const [slabs, setSlabs] = useState<Omit<Slab, "id">[]>([
    { slabOrder: 1, threshold: "", benefitType: "pct", benefitValue: "" },
  ]);
  const [saving, setSaving] = useState(false);

  function toggleAppliesTo(v: string) {
    setAppliesTo((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }

  function addSlab() {
    setSlabs((prev) => [
      ...prev,
      {
        slabOrder: prev.length + 1,
        threshold: "",
        benefitType: "pct",
        benefitValue: "",
      },
    ]);
  }

  async function handleSave() {
    if (!name.trim() || !slabs.length) return;
    setSaving(true);
    try {
      await fetch(`${BASE}/api/customers/schemes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          appliesTo,
          periodType: "fy",
          fy,
          basis,
          scopeType: "all",
          active: true,
          usePriceMultiplier: false,
          slabs,
        }),
      });
      setShowForm(false);
      setName("");
      setSlabs([{ slabOrder: 1, threshold: "", benefitType: "pct", benefitValue: "" }]);
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {schemes.length === 0
            ? "No schemes defined. Create one to start tracking customer slab progress."
            : `${schemes.length} scheme${schemes.length > 1 ? "s" : ""} configured.`}
        </p>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New Scheme"}
        </Button>
      </div>

      {showForm && (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-sm">New Scheme</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Name</label>
                <input
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Q1 Volume Scheme"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">FY</label>
                <input
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  value={fy}
                  onChange={(e) => setFy(e.target.value)}
                  placeholder="2026-27"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Basis</label>
              <div className="mt-1 flex gap-3">
                {["value", "qty"].map((b) => (
                  <label key={b} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={basis === b}
                      onChange={() => setBasis(b as "value" | "qty")}
                    />
                    {b === "value" ? "Order Value (₹)" : "Quantity (pcs)"}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Applies to</label>
              <div className="mt-1 flex gap-3">
                {["distributor", "direct_dealer", "retailer"].map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={appliesTo.includes(t)}
                      onChange={() => toggleAppliesTo(t)}
                    />
                    {t === "direct_dealer" ? "Direct Dealer" : t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">Slabs</label>
                <Button size="sm" variant="ghost" onClick={addSlab} className="h-6 text-xs">
                  + Add slab
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                {slabs.map((slab, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground w-4">{i + 1}</span>
                    <input
                      className="rounded border px-2 py-0.5 text-sm w-28"
                      value={slab.threshold}
                      onChange={(e) =>
                        setSlabs((prev) =>
                          prev.map((s, j) =>
                            j === i ? { ...s, threshold: e.target.value } : s,
                          ),
                        )
                      }
                      placeholder={basis === "value" ? "₹ threshold" : "pcs threshold"}
                    />
                    <select
                      className="rounded border px-1 py-0.5 text-sm"
                      value={slab.benefitType}
                      onChange={(e) =>
                        setSlabs((prev) =>
                          prev.map((s, j) =>
                            j === i
                              ? { ...s, benefitType: e.target.value as "pct" | "flat" }
                              : s,
                          ),
                        )
                      }
                    >
                      <option value="pct">%</option>
                      <option value="flat">Flat ₹</option>
                    </select>
                    <input
                      className="rounded border px-2 py-0.5 text-sm w-20"
                      value={slab.benefitValue}
                      onChange={(e) =>
                        setSlabs((prev) =>
                          prev.map((s, j) =>
                            j === i ? { ...s, benefitValue: e.target.value } : s,
                          ),
                        )
                      }
                      placeholder="value"
                    />
                    {slabs.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-red-500"
                        onClick={() =>
                          setSlabs((prev) =>
                            prev.filter((_, j) => j !== i).map((s, j) => ({
                              ...s,
                              slabOrder: j + 1,
                            })),
                          )
                        }
                      >
                        x
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <Button size="sm" disabled={saving || !name.trim()} onClick={handleSave}>
              {saving ? "Saving..." : "Save scheme"}
            </Button>
          </CardContent>
        </Card>
      )}

      {schemes.map((s) => (
        <div key={s.id} className="rounded-md border px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{s.name}</span>
            <div className="flex gap-1">
              <Badge variant="outline" className="text-xs">
                {s.basis === "value" ? "Value" : "Qty"}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {s.fy ?? `${s.periodStart} – ${s.periodEnd}`}
              </Badge>
              {s.usePriceMultiplier && (
                <Badge className="text-xs bg-blue-100 text-blue-700 border border-blue-300">
                  Laspeyres deflated
                </Badge>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Applies to: {s.appliesTo.join(", ")} &middot; {s.slabs.length} slab
            {s.slabs.length !== 1 ? "s" : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Tracking table ────────────────────────────────────────────────────────────

function TrackingTable({
  tracking,
  scheme,
}: {
  tracking: TrackingRow[];
  scheme: Scheme;
}) {
  const slabs = scheme.slabs.sort((a, b) => a.slabOrder - b.slabOrder);
  if (!tracking.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No achievement data for this scheme period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="text-right">Achievement</TableHead>
            {scheme.usePriceMultiplier && (
              <TableHead className="text-right">Deflated</TableHead>
            )}
            <TableHead className="text-right">Current slab</TableHead>
            <TableHead className="text-right">Distance to next</TableHead>
            <TableHead className="text-right">Days left</TableHead>
            <TableHead className="text-right">Projected total</TableHead>
            <TableHead className="text-right">On track?</TableHead>
            {scheme.usePriceMultiplier && (
              <TableHead className="text-right">Multiplier</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tracking.map((r) => {
            const currentSlab = r.currentSlabIdx >= 0 ? slabs[r.currentSlabIdx] : null;
            const fmt = scheme.basis === "value" ? fmtVal : fmtQty;
            return (
              <TableRow key={r.customer}>
                <TableCell className="font-medium">{r.customer}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(r.achievement)}
                </TableCell>
                {scheme.usePriceMultiplier && (
                  <TableCell className="text-right font-mono text-sm">
                    {r.deflatedAchievement != null ? fmt(r.deflatedAchievement) : "—"}
                  </TableCell>
                )}
                <TableCell className="text-right text-sm">
                  {currentSlab
                    ? `Slab ${currentSlab.slabOrder} (${currentSlab.benefitType === "pct" ? currentSlab.benefitValue + "%" : "₹" + currentSlab.benefitValue})`
                    : "None"}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {r.nextSlabIdx >= 0 && r.distanceToNextSlab != null
                    ? fmt(r.distanceToNextSlab)
                    : r.nextSlabIdx < 0
                    ? "Top slab"
                    : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">{r.daysRemaining}d</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fmt(r.projectedTotal)}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {r.nextSlabIdx < 0 ? (
                    <Badge className="text-xs bg-purple-100 text-purple-700 border border-purple-300">
                      At top
                    </Badge>
                  ) : r.willReachNextSlab === true ? (
                    <Badge className="text-xs bg-green-100 text-green-700 border border-green-300">
                      On track
                    </Badge>
                  ) : r.willReachNextSlab === false ? (
                    <Badge className="text-xs bg-red-100 text-red-700 border border-red-300">
                      Short
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {scheme.usePriceMultiplier && (
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {r.multiplier != null
                      ? `${r.multiplier.toFixed(4)} (${r.multiplierLevel})`
                      : "—"}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Push list ─────────────────────────────────────────────────────────────────

function PushListTable({ entries, scheme }: { entries: PushEntry[]; scheme: Scheme }) {
  const fmt = scheme.basis === "value" ? fmtVal : fmtQty;
  if (!entries.length) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No customers within striking distance of the next slab.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead className="text-right">Distance to next slab</TableHead>
            <TableHead className="text-right">Days left</TableHead>
            <TableHead className="text-right">Projected shortfall</TableHead>
            <TableHead className="text-right">Benefit at next slab</TableHead>
            <TableHead className="text-right">On track?</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e, i) => (
            <TableRow key={e.customer}>
              <TableCell className="text-muted-foreground text-sm">{i + 1}</TableCell>
              <TableCell className="font-medium">{e.customer}</TableCell>
              <TableCell className="text-right font-mono text-sm text-amber-700 dark:text-amber-400">
                {fmt(e.distanceToNextSlab)} to {fmt(e.nextSlabThreshold)}
              </TableCell>
              <TableCell className="text-right text-sm">{e.daysRemaining}d</TableCell>
              <TableCell className="text-right font-mono text-sm">
                {e.projectedShortfall > 0 ? fmt(e.projectedShortfall) : "None"}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {e.nextBenefitValue != null ? fmtVal(e.nextBenefitValue) : "—"}
              </TableCell>
              <TableCell className="text-right text-sm">
                {e.willReachNextSlab ? (
                  <Badge className="text-xs bg-green-100 text-green-700 border border-green-300">
                    On track
                  </Badge>
                ) : (
                  <Badge className="text-xs bg-amber-100 text-amber-700 border border-amber-300">
                    Borderline
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SchemeDashboard() {
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tracking, setTracking] = useState<TrackingRow[]>([]);
  const [pushList, setPushList] = useState<PushEntry[]>([]);
  const [loadingSchemes, setLoadingSchemes] = useState(true);
  const [loadingTracking, setLoadingTracking] = useState(false);
  const [tab, setTab] = useState<"admin" | "tracking" | "push">("admin");

  function loadSchemes() {
    setLoadingSchemes(true);
    fetch(`${BASE}/api/customers/schemes`)
      .then((r) => r.json())
      .then((d) => {
        const s: Scheme[] = d.schemes ?? [];
        setSchemes(s);
        if (s.length && selectedId == null) setSelectedId(s[0].id);
      })
      .catch(() => {})
      .finally(() => setLoadingSchemes(false));
  }

  useEffect(() => { loadSchemes(); }, []);

  useEffect(() => {
    if (selectedId == null || tab === "admin") return;
    setLoadingTracking(true);
    if (tab === "tracking") {
      fetch(`${BASE}/api/customers/schemes/${selectedId}/tracking`)
        .then((r) => r.json())
        .then((d) => setTracking(d.tracking ?? []))
        .catch(() => {})
        .finally(() => setLoadingTracking(false));
    } else if (tab === "push") {
      fetch(`${BASE}/api/customers/schemes/${selectedId}/push-list`)
        .then((r) => r.json())
        .then((d) => setPushList(d.pushList ?? []))
        .catch(() => {})
        .finally(() => setLoadingTracking(false));
    }
  }, [selectedId, tab]);

  const selectedScheme = schemes.find((s) => s.id === selectedId);

  return (
    <div className="flex flex-col gap-4">
      {schemes.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {schemes.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant={selectedId === s.id ? "default" : "outline"}
              onClick={() => setSelectedId(s.id)}
            >
              {s.name}
            </Button>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-b pb-2">
        {(["admin", "tracking", "push"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "px-3 py-1 text-sm rounded-md",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {t === "admin" ? "Scheme Config" : t === "tracking" ? "Entity Tracking" : "Push List"}
          </button>
        ))}
      </div>

      {loadingSchemes ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          Loading schemes...
        </div>
      ) : tab === "admin" ? (
        <SchemeAdmin schemes={schemes} onCreated={loadSchemes} />
      ) : !selectedScheme ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          Create a scheme first.
        </div>
      ) : loadingTracking ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          Computing...
        </div>
      ) : tab === "tracking" ? (
        <TrackingTable tracking={tracking} scheme={selectedScheme} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Customers within 20% of the next slab, sorted by smallest gap relative to benefit.
            This is the highest-ROI call list.
          </p>
          <PushListTable entries={pushList} scheme={selectedScheme} />
        </>
      )}
    </div>
  );
}
