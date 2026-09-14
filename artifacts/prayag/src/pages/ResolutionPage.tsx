import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ExcelJS from "exceljs";
import {
  ChevronDown, ChevronRight, Download, Loader2, Pencil, Plus, Printer,
  RefreshCw, Search, X,
} from "lucide-react";
import { useRoute } from "wouter";
import { useAuth } from "@/data/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  buildResolutionExportDocument, filterResolutionItems, groupResolutionItems, normalizeResolutionItem, RESOLUTION_EXPORT_HEADERS, sortResolutionItems,
  type ResolutionItem, type ResolutionSort,
} from "@/lib/resolutionItems";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const endpoint = `${BASE}/api/resolution-items`;
const CATEGORIES = ["data quality", "master data", "access", "infrastructure", "commercial"];

type ResolutionForm = {
  code: string; type: "HOLD" | "PENDING"; title: string; category: string;
  fiscalYear: string; month: string; scopeProduct: string; scopeMeasure: string;
  reason: string; evidence: string; valueAtStake: string; raisedOn: string;
  raisedBy: string; owner: string; blocksApi: boolean;
};

type ResolveForm = { status: "resolved" | "answered" | "accepted-as-is"; resolutionNote: string };

const emptyForm: ResolutionForm = {
  code: "", type: "PENDING", title: "", category: "data quality", fiscalYear: "",
  month: "", scopeProduct: "", scopeMeasure: "", reason: "", evidence: "",
  valueAtStake: "", raisedOn: new Date().toISOString().slice(0, 10),
  raisedBy: "", owner: "", blocksApi: false,
};

function formFor(item?: ResolutionItem | null): ResolutionForm {
  if (!item) return { ...emptyForm };
  return {
    code: item.code, type: item.type, title: item.title, category: item.category,
    fiscalYear: item.fiscalYear ?? "", month: item.month ?? "",
    scopeProduct: item.scopeProduct ?? "", scopeMeasure: item.scopeMeasure ?? "",
    reason: item.reason, evidence: item.evidence, valueAtStake: item.valueAtStake === null ? "" : String(item.valueAtStake),
    raisedOn: item.raisedOn, raisedBy: item.raisedBy, owner: item.owner, blocksApi: item.blocksApi,
  };
}

function createPayload(form: ResolutionForm): Record<string, unknown> {
  return {
    code: form.code, type: form.type, title: form.title, category: form.category,
    fiscalYear: form.fiscalYear || null, month: form.month || null, scopeProduct: form.scopeProduct || null,
    scopeMeasure: form.type === "HOLD" ? form.scopeMeasure : null, reason: form.reason, evidence: form.evidence,
    valueAtStake: form.valueAtStake === "" ? null : Number(form.valueAtStake), raisedOn: form.raisedOn,
    raisedBy: form.raisedBy, owner: form.owner, status: "open",
    blocksApi: form.type === "HOLD" ? form.blocksApi : false,
  };
}

function editPayload(form: ResolutionForm): Record<string, unknown> {
  return {
    title: form.title, category: form.category, fiscalYear: form.fiscalYear || null,
    month: form.month || null, scopeProduct: form.scopeProduct || null,
    scopeMeasure: form.type === "HOLD" ? form.scopeMeasure : null, reason: form.reason, evidence: form.evidence,
    valueAtStake: form.valueAtStake === "" ? null : Number(form.valueAtStake), raisedOn: form.raisedOn,
    raisedBy: form.raisedBy, owner: form.owner, blocksApi: form.type === "HOLD" ? form.blocksApi : false,
  };
}

async function readItems(): Promise<ResolutionItem[]> {
  const response = await fetch(endpoint, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not load resolution items (${response.status})`);
  const payload = await response.json() as { items?: unknown[] };
  return (payload.items ?? [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map(normalizeResolutionItem);
}

function typeClass(type: string): string {
  return type === "HOLD"
    ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
    : "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200";
}

function statusClass(status: string): string {
  if (status === "open") return "border-primary/30 bg-primary/5 text-primary";
  if (status === "answered") return "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-200";
  if (status === "resolved") return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200";
  return "border-muted bg-muted text-muted-foreground";
}

function money(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

function scopeText(item: ResolutionItem): string {
  return [
    item.fiscalYear && `FY ${item.fiscalYear}`,
    item.month,
    item.scopeProduct && `Product: ${item.scopeProduct}`,
    item.scopeMeasure && `Measure: ${item.scopeMeasure}`,
  ].filter(Boolean).join(" · ") || "No scope recorded.";
}

function ResolutionFormPanel({ initial, onClose, onSave, saving }: {
  initial?: ResolutionItem | null;
  onClose: () => void;
  onSave: (form: ResolutionForm) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(() => formFor(initial));
  const set = <K extends keyof ResolutionForm>(key: K, value: ResolutionForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const isHold = form.type === "HOLD";
  return (
    <Card className="no-print mb-5 border-primary/30">
      <CardHeader className="flex-row items-start justify-between pb-3">
        <div><CardTitle className="text-base">{initial ? "Edit resolution item" : "Add resolution item"}</CardTitle><p className="mt-1 text-xs text-muted-foreground">Create or update the register entry using the API's resolution fields.</p></div>
        <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-resolution-form" aria-label="Close form"><X /></Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => { event.preventDefault(); onSave(form); }} className="grid gap-4 md:grid-cols-2">
          {!initial && <label className="space-y-1 text-sm"><span>Code</span><Input required value={form.code} onChange={(e) => set("code", e.target.value)} data-testid="input-resolution-code" /></label>}
          <label className="space-y-1 text-sm"><span>Title</span><Input required value={form.title} onChange={(e) => set("title", e.target.value)} data-testid="input-resolution-title" /></label>
          <label className="space-y-1 text-sm"><span>Type</span><Select value={form.type} disabled={!!initial} onValueChange={(value) => set("type", value as ResolutionForm["type"])}><SelectTrigger data-testid="select-resolution-form-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="HOLD">HOLD</SelectItem><SelectItem value="PENDING">PENDING</SelectItem></SelectContent></Select></label>
          <label className="space-y-1 text-sm"><span>Category</span><Select value={form.category} onValueChange={(value) => set("category", value)}><SelectTrigger data-testid="select-resolution-form-category"><SelectValue /></SelectTrigger><SelectContent>{CATEGORIES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></label>
          <label className="space-y-1 text-sm"><span>Owner</span><Input required value={form.owner} onChange={(e) => set("owner", e.target.value)} data-testid="input-resolution-owner" /></label>
          <label className="space-y-1 text-sm"><span>Raised by</span><Input required value={form.raisedBy} onChange={(e) => set("raisedBy", e.target.value)} data-testid="input-resolution-raised-by" /></label>
          <label className="space-y-1 text-sm"><span>Raised on</span><Input required type="date" value={form.raisedOn} onChange={(e) => set("raisedOn", e.target.value)} data-testid="input-resolution-raised-on" /></label>
          <label className="space-y-1 text-sm"><span>Fiscal year</span><Input value={form.fiscalYear} onChange={(e) => set("fiscalYear", e.target.value)} data-testid="input-resolution-fiscal-year" /></label>
          <label className="space-y-1 text-sm"><span>Month</span><Input value={form.month} onChange={(e) => set("month", e.target.value)} data-testid="input-resolution-month" /></label>
          <label className="space-y-1 text-sm"><span>Product scope</span><Input value={form.scopeProduct} onChange={(e) => set("scopeProduct", e.target.value)} data-testid="input-resolution-scope-product" /></label>
          <label className="space-y-1 text-sm"><span>Measure scope{isHold ? " (required for HOLD)" : ""}</span><Input required={isHold} disabled={!isHold} value={isHold ? form.scopeMeasure : ""} onChange={(e) => set("scopeMeasure", e.target.value)} data-testid="input-resolution-scope-measure" /></label>
          <label className="space-y-1 text-sm"><span>Value at stake (₹)</span><Input type="number" min="0" value={form.valueAtStake} onChange={(e) => set("valueAtStake", e.target.value)} data-testid="input-resolution-value" /></label>
          {isHold && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.blocksApi} onChange={(e) => set("blocksApi", e.target.checked)} data-testid="input-resolution-blocks-api" /> Blocks API</label>}
          <label className="space-y-1 text-sm md:col-span-2"><span>Reason</span><Textarea required value={form.reason} onChange={(e) => set("reason", e.target.value)} data-testid="input-resolution-reason" /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>Evidence</span><Textarea required value={form.evidence} onChange={(e) => set("evidence", e.target.value)} data-testid="input-resolution-evidence" /></label>
          <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={saving} data-testid="button-save-resolution">{saving && <Loader2 className="animate-spin" />} {initial ? "Save changes" : "Add item"}</Button><Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-resolution">Cancel</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function ResolveFormPanel({ item, onClose, onResolve, saving }: {
  item: ResolutionItem; onClose: () => void; onResolve: (form: ResolveForm) => void; saving: boolean;
}) {
  const [form, setForm] = useState<ResolveForm>({ status: "resolved", resolutionNote: "" });
  return (
    <Card className="no-print mb-5 border-emerald-300">
      <CardHeader className="flex-row items-start justify-between pb-3"><div><CardTitle className="text-base">Resolve {item.code}</CardTitle><p className="mt-1 text-xs text-muted-foreground">Record what unblocked this item for the audit trail.</p></div><Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-resolve-form"><X /></Button></CardHeader>
      <CardContent><form onSubmit={(event) => { event.preventDefault(); onResolve(form); }} className="space-y-4">
        <label className="block space-y-1 text-sm"><span>Resolution status</span><Select value={form.status} onValueChange={(status) => setForm((current) => ({ ...current, status: status as ResolveForm["status"] }))}><SelectTrigger data-testid="select-resolution-resolve-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="resolved">Resolved</SelectItem><SelectItem value="answered">Answered</SelectItem><SelectItem value="accepted-as-is">Accepted as-is</SelectItem></SelectContent></Select></label>
        <label className="block space-y-1 text-sm"><span>What unblocked it</span><Textarea required value={form.resolutionNote} onChange={(e) => setForm((current) => ({ ...current, resolutionNote: e.target.value }))} data-testid="input-resolution-note" /></label>
        <div className="flex gap-2"><Button type="submit" disabled={saving} data-testid="button-submit-resolution-resolve">{saving && <Loader2 className="animate-spin" />} Save resolution</Button><Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-resolution-resolve">Cancel</Button></div>
      </form></CardContent>
    </Card>
  );
}

export default function ResolutionPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [, routeParams] = useRoute("/settings/resolution/:id");
  const deepLinkId = routeParams?.id;
  const isAdmin = user?.role === "admin";
  const { data: items = [], isLoading, isError, refetch } = useQuery({ queryKey: ["resolution-items"], queryFn: readItems });
  const [sort, setSort] = useState<ResolutionSort>("days-open");
  const [owner, setOwner] = useState("all");
  const [category, setCategory] = useState("all");
  const [type, setType] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string | number>>(() => new Set());
  const [highlightedId, setHighlightedId] = useState<string | undefined>(deepLinkId);
  const [formItem, setFormItem] = useState<ResolutionItem | null | undefined>(undefined);
  const [resolveItemState, setResolveItemState] = useState<ResolutionItem | null>(null);

  useEffect(() => {
    if (!deepLinkId) return;
    const match = items.find((item) => String(item.id) === deepLinkId);
    if (match) {
      setExpanded((current) => new Set(current).add(match.id));
      setHighlightedId(deepLinkId);
    }
  }, [deepLinkId, items]);

  const values = useMemo(() => ({
    owners: [...new Set(items.map((item) => item.owner))].sort(),
    categories: [...new Set(items.map((item) => item.category))].sort(),
    types: [...new Set(items.map((item) => item.type))].sort(),
  }), [items]);
  const visible = useMemo(() => sortResolutionItems(
    filterResolutionItems(items.filter((item) => `${item.code} ${item.title} ${item.category} ${item.reason} ${item.evidence}`.toLowerCase().includes(search.toLowerCase())),
      { owner, category, type }), sort,
  ), [items, owner, category, type, search, sort]);
  const openItems = useMemo(() => visible.filter((item) => item.status === "open"), [visible]);

  useEffect(() => {
    if (!deepLinkId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`resolution-card-${deepLinkId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [deepLinkId, expanded, visible]);

  const exportReport = useMemo(() => buildResolutionExportDocument(openItems, {
    owner, category, type, search, sort,
    generatedAt: new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }),
  }), [openItems, owner, category, type, search, sort]);

  const saveMutation = useMutation({
    mutationFn: async ({ id, form }: { id?: string | number; form: ResolutionForm }) => {
      const response = await fetch(id === undefined ? endpoint : `${endpoint}/${encodeURIComponent(String(id))}`, {
        method: id === undefined ? "POST" : "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(id === undefined ? createPayload(form) : editPayload(form)),
      });
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      return response.json();
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["resolution-items"] });
      setFormItem(undefined);
      toast({ title: "Resolution item saved" });
    },
    onError: (error: Error) => toast({ title: "Could not save resolution item", description: error.message, variant: "destructive" }),
  });
  const resolveMutation = useMutation({
    mutationFn: async ({ id, form }: { id: string | number; form: ResolveForm }) => {
      const response = await fetch(`${endpoint}/${encodeURIComponent(String(id))}/resolve`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      if (!response.ok) throw new Error(`Resolution failed (${response.status})`);
      return response.json();
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["resolution-items"] });
      setResolveItemState(null);
      toast({ title: "Resolution recorded" });
    },
    onError: (error: Error) => toast({ title: "Could not resolve item", description: error.message, variant: "destructive" }),
  });

  async function exportExcel() {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Prayag Sales Intelligence";
    const sheet = workbook.addWorksheet("Open resolution items");
    const columns = [
      { key: "code", width: 16 }, { key: "title", width: 36 },
      { key: "type", width: 14 }, { key: "reason", width: 36 },
      { key: "evidence", width: 50 }, { key: "valueAtStake", width: 16 },
      { key: "daysOpen", width: 12 }, { key: "owner", width: 22 },
      { key: "status", width: 14 }, { key: "fiscalYear", width: 14 },
      { key: "month", width: 16 }, { key: "scopeProduct", width: 28 },
      { key: "scopeMeasure", width: 28 }, { key: "blocksApi", width: 14 },
    ];
    sheet.columns = columns;
    sheet.mergeCells("A1:N1");
    sheet.getCell("A1").value = exportReport.title;
    sheet.getCell("A2").value = `Generated: ${exportReport.generatedAt}`;
    sheet.mergeCells("A3:N3");
    sheet.getCell("A3").value = `Filters: ${exportReport.filterContext}`;
    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF174A5B" } };
    sheet.getRow(3).font = { italic: true, color: { argb: "FF475569" } };
    let rowNumber = 5;
    for (const section of exportReport.sections) {
      sheet.mergeCells(rowNumber, 1, rowNumber, columns.length);
      sheet.getCell(rowNumber, 1).value = `Category: ${section.category}`;
      sheet.getRow(rowNumber).font = { bold: true, color: { argb: "FF174A5B" } };
      rowNumber += 1;
      const header = sheet.getRow(rowNumber);
      RESOLUTION_EXPORT_HEADERS.forEach((label, index) => { header.getCell(index + 1).value = label; });
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF64748B" } };
      rowNumber += 1;
      section.rows.forEach((row) => { sheet.addRow(row); rowNumber += 1; });
      rowNumber += 1;
    }
    sheet.views = [{ state: "frozen", ySplit: 5 }];
    const blob = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([blob], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = "open-resolution-items.xlsx"; link.click(); URL.revokeObjectURL(url);
  }

  function printExport() {
    document.body.classList.add("resolution-printing");
    window.setTimeout(() => { window.print(); document.body.classList.remove("resolution-printing"); }, 0);
  }

  const groups = useMemo(() => groupResolutionItems(visible, sort), [visible, sort]);
  return (
    <div className="resolution-page flex h-full flex-col bg-background" data-testid="page-resolution">
      <header className="border-b px-5 py-5 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Settings</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Resolution</h1><p className="mt-1 text-sm text-muted-foreground">A shared queue for decisions, blockers, and accountable next steps.</p></div>
          <div className="no-print flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void exportExcel()} disabled={!openItems.length} data-testid="button-export-resolution-excel"><Download /> Excel</Button>
            <Button variant="outline" size="sm" onClick={printExport} disabled={!openItems.length} data-testid="button-export-resolution-print"><Printer /> Print / PDF</Button>
            <Button variant="outline" size="sm" onClick={() => void refetch()} data-testid="button-refresh-resolution"><RefreshCw /> Refresh</Button>
            {isAdmin && <Button size="sm" onClick={() => setFormItem(null)} data-testid="button-add-resolution"><Plus /> Add item</Button>}
          </div>
        </div>
      </header>
      <div className="no-print border-b bg-muted/20 px-5 py-3 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[210px] flex-1"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" placeholder="Search resolution items" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-resolution-search" /></div>
          <Select value={owner} onValueChange={setOwner}><SelectTrigger className="w-[160px]" data-testid="select-resolution-owner"><SelectValue placeholder="Owner" /></SelectTrigger><SelectContent><SelectItem value="all">All owners</SelectItem>{values.owners.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
          <Select value={category} onValueChange={setCategory}><SelectTrigger className="w-[160px]" data-testid="select-resolution-category"><SelectValue placeholder="Category" /></SelectTrigger><SelectContent><SelectItem value="all">All categories</SelectItem>{values.categories.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
          <Select value={type} onValueChange={setType}><SelectTrigger className="w-[150px]" data-testid="select-resolution-type"><SelectValue placeholder="Type" /></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem>{values.types.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
          <Select value={sort} onValueChange={(value) => setSort(value as ResolutionSort)}><SelectTrigger className="w-[165px]" data-testid="select-resolution-sort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="days-open">Days open ↓</SelectItem><SelectItem value="value-at-stake">Value at stake ↓</SelectItem></SelectContent></Select>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">{openItems.length} open item{openItems.length === 1 ? "" : "s"} · Exports include open items and respect the current filters.</div>
      </div>
      <main className="flex-1 overflow-auto px-5 py-5 md:px-8">
        {isAdmin && formItem !== undefined && <ResolutionFormPanel key={formItem ? String(formItem.id) : "new"} initial={formItem} onClose={() => setFormItem(undefined)} saving={saveMutation.isPending} onSave={(form) => saveMutation.mutate({ id: formItem?.id, form })} />}
        {isAdmin && resolveItemState && <ResolveFormPanel item={resolveItemState} onClose={() => setResolveItemState(null)} saving={resolveMutation.isPending} onResolve={(form) => resolveMutation.mutate({ id: resolveItemState.id, form })} />}
        {isLoading && <div className="flex h-32 items-center justify-center text-muted-foreground" data-testid="status-resolution-loading"><Loader2 className="mr-2 animate-spin" /> Loading resolution items…</div>}
        {isError && <Card><CardContent className="py-10 text-center text-destructive" data-testid="status-resolution-error">Could not load resolution items. Try refreshing.</CardContent></Card>}
        {!isLoading && !isError && !visible.length && <Card><CardContent className="py-12 text-center text-muted-foreground" data-testid="status-resolution-empty">No resolution items match these filters.</CardContent></Card>}
        <div className="space-y-4">
          {groups.map((group) => <section key={`${group.partition}-${group.category}`} data-testid={`group-resolution-${group.partition}-${group.category}`}><h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{group.partition === "open" ? "Open" : "Closed"} · {group.category}<span className="ml-2 font-normal">({group.items.length})</span></h2><div className="space-y-2">{group.items.map((item) => {
            const isExpanded = expanded.has(item.id);
            const isHighlighted = highlightedId === String(item.id);
            return <Card key={String(item.id)} id={`resolution-card-${item.id}`} className={cn("overflow-hidden border-l-4", item.type === "HOLD" ? "border-l-amber-400" : "border-l-sky-400", isHighlighted && "ring-2 ring-primary ring-offset-2")} data-testid={`card-resolution-${item.id}`}>
              <div className="flex items-start gap-3 p-4">
                <button className="no-print mt-0.5 text-muted-foreground" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.title}`} data-testid={`button-expand-resolution-${item.id}`}>{isExpanded ? <ChevronDown /> : <ChevronRight />}</button>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold" data-testid={`text-resolution-title-${item.id}`}>{item.title}</h3><Badge variant="outline" className={typeClass(item.type)} data-testid={`type-resolution-${item.id}`}>{item.type}</Badge><Badge variant="outline" className={statusClass(item.status)} data-testid={`status-resolution-${item.id}`}>{item.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{scopeText(item)}</p><div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span><strong className="text-foreground">{item.owner}</strong> owner</span><span><strong className="text-foreground">{item.daysOpen ?? "—"}</strong> days open</span><span><strong className="text-foreground">{money(item.valueAtStake)}</strong> at stake</span>{item.blocksApi && <span className="font-semibold text-amber-700">Blocks API</span>}</div></div>
                {isAdmin && item.status === "open" && <div className="no-print flex shrink-0 gap-1"><Button variant="ghost" size="icon" onClick={() => setFormItem(item)} aria-label={`Edit ${item.title}`} data-testid={`button-edit-resolution-${item.id}`}><Pencil /></Button><Button variant="outline" size="sm" onClick={() => setResolveItemState(item)} data-testid={`button-resolve-resolution-${item.id}`}>Resolve</Button></div>}
              </div>
              {isExpanded && <div className="grid gap-4 border-t bg-muted/20 px-12 py-4 text-sm md:grid-cols-4"><div><p className="font-medium">Evidence</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.evidence || "No evidence recorded."}</p></div><div><p className="font-medium">Reason</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.reason || "No reason recorded."}</p></div><div><p className="font-medium">Scope</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{scopeText(item)}</p></div><div><p className="font-medium">What unblocked it</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.resolutionNote || (item.status === "open" ? "Not resolved yet." : "No resolution note recorded.")}</p></div></div>}
            </Card>;
          })}</div></section>)}
        </div>
      </main>
      <div className="resolution-print-export" aria-label="Printable open resolution items">
        <h1>{exportReport.title}</h1>
        <p><strong>Generated:</strong> {exportReport.generatedAt}</p>
        <p><strong>Filters:</strong> {exportReport.filterContext}</p>
        {exportReport.sections.map((section) => <section key={section.category}>
          <h2>Category: {section.category}</h2>
          <table><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Reason</th><th>Evidence</th><th>Value at stake</th><th>Days open</th><th>Owner</th><th>Status</th></tr></thead>
            <tbody>{section.rows.map((row) => <tr key={row.code}><td>{row.code}</td><td>{row.title}</td><td>{row.type}</td><td>{row.reason}</td><td>{row.evidence}</td><td>{money(row.valueAtStake)}</td><td>{row.daysOpen ?? "—"}</td><td>{row.owner}</td><td>{row.status}</td></tr>)}</tbody>
          </table>
        </section>)}
      </div>
    </div>
  );
}