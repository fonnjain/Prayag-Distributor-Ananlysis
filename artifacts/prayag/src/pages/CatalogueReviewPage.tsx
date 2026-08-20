import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Lock, RefreshCw, Tags } from "lucide-react";
import { useAuth } from "@/data/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 50;

type GroupOption = { itemGroup: string; canonicalSegment: string };
type QueueItem = {
  code: string;
  productName: string | null;
  currentMrp: number | null;
  uploadedItemGroup: string | null;
  sourceDivisions: string[];
  saleSegments: string[];
  usage: {
    saleLineCount: number;
    customerCount: number;
    fiscalYearCount: number;
    totalNet: number;
    latestSaleDate: string | null;
  };
};
type MappingAudit = {
  id: number;
  code: string;
  previousItemGroup: string | null;
  previousSegment: string | null;
  itemGroup: string;
  canonicalSegment: string;
  mappedBy: string;
  note: string | null;
  mappedAt: string;
};
type ReviewPayload = {
  pending: number;
  items: QueueItem[];
  groupOptions: GroupOption[];
  recentMappings: MappingAudit[];
  note: string;
};

function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "—";
  if (Math.abs(value) >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (Math.abs(value) >= 100_000) return `₹${(value / 100_000).toFixed(1)} L`;
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function CatalogueReviewPage() {
  const { user } = useAuth();
  const [secret, setSecret] = useState(() => sessionStorage.getItem("adminSecret") ?? "");
  const [secretInput, setSecretInput] = useState("");
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [itemGroup, setItemGroup] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!secret) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${BASE}/api/sku/taxonomy-review`, {
        headers: { "X-Admin-Secret": secret },
      });
      if (response.status === 401) {
        sessionStorage.removeItem("adminSecret");
        setSecret("");
        setData(null);
        throw new Error("Secret rejected by the server.");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as ReviewPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the review queue.");
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !data) return data?.items ?? [];
    return data.items.filter((item) =>
      [item.code, item.productName, item.uploadedItemGroup, ...item.sourceDivisions, ...item.saleSegments]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
  }, [data, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [search]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  function unlock() {
    const next = secretInput.trim();
    if (!next) return;
    sessionStorage.setItem("adminSecret", next);
    setSecret(next);
    setSecretInput("");
    setSuccess(null);
  }

  function beginMapping(item: QueueItem) {
    setSelected(item);
    setItemGroup("");
    setNote("");
    setSuccess(null);
  }

  async function saveMapping() {
    if (!selected || !itemGroup || !user) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${BASE}/api/sku/taxonomy-review/${encodeURIComponent(selected.code)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
        body: JSON.stringify({ itemGroup, note }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setSuccess(`${selected.code} was mapped to ${itemGroup}.`);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the mapping.");
    } finally {
      setSaving(false);
    }
  }

  if (user?.role !== "admin") {
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> Catalogue Review</CardTitle>
          <CardDescription>Only application administrators can review and map local SKU taxonomy.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!secret) {
    return (
      <div className="max-w-xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Catalogue Review</h1>
          <p className="text-sm text-muted-foreground">Review active authoritative products that are still missing a local item-group mapping.</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4" /> Administrator access</CardTitle>
            <CardDescription>Enter the administrator secret to view the code queue and record audited mappings.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input type="password" value={secretInput} onChange={(event) => setSecretInput(event.target.value)} placeholder="Administrator secret" />
            <Button onClick={unlock} disabled={!secretInput.trim()}>Open queue</Button>
          </CardContent>
        </Card>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Catalogue Review</h1>
          <p className="text-sm text-muted-foreground">
            Local taxonomy only. Authoritative product existence and current MRP are not changed here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
      {success && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400 flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0" />{success}</div>}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Tags className="h-4 w-4" /> Unmapped active catalogue codes</CardTitle>
          <CardDescription>
            {data ? `${data.pending.toLocaleString("en-IN")} active code${data.pending === 1 ? "" : "s"} need a recognised local item group.` : "Loading review queue…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by code, product, source division, sale segment, or local group…" />
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[980px] text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Code / product</th>
                  <th className="px-3 py-2 text-left font-medium">Source divisions</th>
                  <th className="px-3 py-2 text-left font-medium">Sale evidence</th>
                  <th className="px-3 py-2 text-right font-medium">Usage</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => (
                  <tr key={item.code} className="border-t align-top">
                    <td className="px-3 py-2.5">
                      <div className="font-mono font-medium">{item.code}</div>
                      <div className="max-w-[260px] truncate text-muted-foreground">{item.productName ?? "No source product name"}</div>
                      {item.uploadedItemGroup && <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">Upload group: {item.uploadedItemGroup}</div>}
                      {item.currentMrp != null && <div className="mt-1 text-[10px] text-muted-foreground">Current MRP: ₹{item.currentMrp.toLocaleString("en-IN")}</div>}
                    </td>
                    <td className="px-3 py-2.5"><div className="flex max-w-[190px] flex-wrap gap-1">{item.sourceDivisions.length ? item.sourceDivisions.map((division) => <Badge key={division} variant="secondary" className="text-[10px]">{division}</Badge>) : <span className="text-muted-foreground">—</span>}</div></td>
                    <td className="px-3 py-2.5">
                      <div className="flex max-w-[220px] flex-wrap gap-1">{item.saleSegments.length ? item.saleSegments.map((segment) => <Badge key={segment} variant="outline" className="text-[10px]">{segment}</Badge>) : <span className="text-muted-foreground">No sales yet</span>}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">Latest: {formatDate(item.usage.latestSaleDate)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <div>{item.usage.saleLineCount.toLocaleString("en-IN")} lines</div>
                      <div className="text-muted-foreground">{item.usage.customerCount.toLocaleString("en-IN")} customers · {item.usage.fiscalYearCount} FYs</div>
                      <div className="mt-1 font-medium">{formatMoney(item.usage.totalNet)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right"><Button size="sm" variant="outline" onClick={() => beginMapping(item)}>Map group</Button></td>
                  </tr>
                ))}
                {!loading && pageItems.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No unmapped codes match this filter.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{filtered.length.toLocaleString("en-IN")} matching · page {page + 1} of {pageCount}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0}><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page >= pageCount - 1}><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selected && (
        <Card className="border-primary/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Map {selected.code}</CardTitle>
            <CardDescription>{selected.productName ?? "No source product name"} · this records a local taxonomy override and an audit entry.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label>Recognised local item group</Label>
              <Select value={itemGroup} onValueChange={setItemGroup}>
                <SelectTrigger><SelectValue placeholder="Choose an item group" /></SelectTrigger>
                <SelectContent>
                  {(data?.groupOptions ?? []).map((option) => <SelectItem key={option.itemGroup} value={option.itemGroup}>{option.canonicalSegment} — {option.itemGroup}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="taxonomy-note">Review note <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="taxonomy-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this group fits" rows={2} />
            </div>
            <div className="flex gap-2 md:col-span-2">
              <Button onClick={() => void saveMapping()} disabled={!itemGroup || saving}>{saving ? "Saving…" : "Apply mapping"}</Button>
              <Button variant="outline" onClick={() => setSelected(null)} disabled={saving}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Recent mapping audit</CardTitle><CardDescription>Every applied or revised local taxonomy mapping is retained here.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="text-muted-foreground"><tr><th className="pb-2 text-left font-medium">When</th><th className="pb-2 text-left font-medium">Code</th><th className="pb-2 text-left font-medium">Local item group</th><th className="pb-2 text-left font-medium">Reviewer</th><th className="pb-2 text-left font-medium">Note</th></tr></thead>
            <tbody>
              {(data?.recentMappings ?? []).slice(0, 20).map((mapping) => <tr key={mapping.id} className="border-t"><td className="py-2 pr-3 text-muted-foreground">{formatDate(mapping.mappedAt)}</td><td className="py-2 pr-3 font-mono">{mapping.code}</td><td className="py-2 pr-3"><span>{mapping.canonicalSegment}</span><span className="text-muted-foreground"> — {mapping.itemGroup}</span></td><td className="py-2 pr-3">{mapping.mappedBy}</td><td className="py-2 text-muted-foreground">{mapping.note ?? "—"}</td></tr>)}
              {data && data.recentMappings.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No manual taxonomy mappings have been recorded yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}