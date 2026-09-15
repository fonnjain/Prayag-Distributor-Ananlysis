import React, { useState, useMemo } from "react";
import { useGetAiSchemesHistory, useGenerateAiSchemesHistory, GenerateAiSchemesHistoryRequestSkuBand } from "@workspace/api-client-react";
import { AlertCircle, Database, Info, AlertTriangle, Lightbulb, Play, Calendar, History, BookOpen } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

const formatNumber = (num: number | null | undefined, decimals: number = 0) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(num);
};

const formatPct = (num: number | null | undefined, decimals: number = 1) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '0.0%';
  return new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(num / 100);
};

const formatIndianCurrency = (num: number | null | undefined) => {
  if (num === null || num === undefined) return '—';
  if (num === 0) return '₹0';
  const abs = Math.abs(num);
  if (abs >= 10000000) return `₹${(num / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000) return `₹${(num / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `₹${(num / 1000).toFixed(2)}K`;
  return `₹${num.toFixed(0)}`;
};

export const generatorSchema = z.object({
  itemGroup: z.string().optional().default(""),
  skuBand: z.string().optional().default(""),
  territory: z.string().min(1, "Territory is required"),
  marginCapPct: z.coerce.number().positive("Must be > 0"),
  breadthOpportunityRetailers: z.coerce.number().int("Must be an integer").positive("Must be > 0"),
  categoryGrossMarginInr: z.coerce.number().positive("Must be > 0"),
  grossMarginRatePct: z.coerce.number().positive("Must be > 0"),
}).refine(data => {
  const hasItemGroup = Boolean(data.itemGroup && data.itemGroup !== "all" && data.itemGroup !== "");
  const hasSkuBand = Boolean(data.skuBand && data.skuBand !== "all" && data.skuBand !== "");
  return (hasItemGroup && !hasSkuBand) || (!hasItemGroup && hasSkuBand);
}, {
  message: "Exactly one of Item Group or SKU Band must be provided",
  path: ["itemGroup"],
});

export type GeneratorFormValues = z.infer<typeof generatorSchema>;

export const buildQueryParams = (year: string, itemGroup: string, skuBand: string, territory: string) => {
  return {
    ...(year !== "all" ? { year } : {}),
    ...(itemGroup !== "all" ? { itemGroup } : {}),
    ...(skuBand !== "all" ? { skuBand: skuBand as typeof GenerateAiSchemesHistoryRequestSkuBand[keyof typeof GenerateAiSchemesHistoryRequestSkuBand] } : {}),
    ...(territory !== "all" ? { territory } : {}),
  };
};

interface HistorySummaryData {
  schemeCount: number;
  currentlyLiveCount: number;
  historicalCount: number;
  periodFrom?: string;
  periodTo?: string;
  source?: string;
}

interface ItemGroupCoverageData {
  allItemGroups: string[];
  covered: string[];
  neverCovered: string[];
  neverCoveredAvailable: boolean;
  statement: string;
  source: string;
}

interface ProposalData {
  name: string;
  qualificationBasis: string;
  settlement: string;
  estimatedCostInr: number;
  costAsMarginPct: number;
  costType: string;
  costStatement: string;
  modeledCostAssumption: string;
  duration: { periodFrom: string; periodTo: string | null; periodNote: string | null };
  slabs: Array<{ thresholdFrom: number; ratePct?: number | null; altReward?: string | null; freeGoods?: string | null }>;
}

interface MarginBreakevenData {
  value: number;
  statement: string;
  evidenceBasis: string;
}

interface FlagsData {
  beyondPrecedent: boolean;
  observedDefinitionExceeded: boolean;
  rateClamped: boolean;
  modeledRateCeilingApplied: boolean;
  modeledRateCeilingBinding: boolean;
  historicalCostCeilingAvailable: boolean;
  historicalCostComparisonPerformed: boolean;
  breadthBeyondPrecedent: boolean;
  amountBeyondPrecedent: boolean;
  targetGroupHistoryAvailable: boolean;
  borrowedFromComparableGroup: boolean;
  controlsAndLiftAvailable: boolean;
  statement: string;
}

interface GuardrailsData {
  sourceHonesty: string;
}

interface ControlLiftData {
  available: boolean;
  statement: string;
}

interface ClosestPrecedentData {
  name: string;
  schemeId: string;
  source: string;
  comparableBasis: string;
}

export function HistoricalBasisTab() {
  const [year, setYear] = useState("all");
  const [itemGroup, setItemGroup] = useState<string>("all");
  const [skuBand, setSkuBand] = useState<string>("all");
  const [territory, setTerritory] = useState<string>("all");

  const queryParams = buildQueryParams(year, itemGroup, skuBand, territory);
  const { data, isLoading, isError, error } = useGetAiSchemesHistory(queryParams);
  const generateMutation = useGenerateAiSchemesHistory();

  const form = useForm<GeneratorFormValues>({
    resolver: zodResolver(generatorSchema),
    defaultValues: {
      itemGroup: "",
      skuBand: "",
      territory: "",
      marginCapPct: 0,
      breadthOpportunityRetailers: 0,
      categoryGrossMarginInr: 0,
      grossMarginRatePct: 0,
    },
  });

  const availableYears = useMemo(() => {
    if (!data) return ['2026-27'];
    const years = new Set<string>();
    data.schemes.forEach(s => {
      const match = s.periodFrom.match(/\d{4}/);
      if (match) years.add(match[0]);
    });
    years.add('2026-27');
    return Array.from(years).sort();
  }, [data]);

  const onSubmit = (values: GeneratorFormValues) => {
    generateMutation.mutate({ data: {
      ...values,
      itemGroup: (values.itemGroup && values.itemGroup !== "all") ? values.itemGroup : undefined,
      skuBand: (values.skuBand && values.skuBand !== "all") ? (values.skuBand as GenerateAiSchemesHistoryRequestSkuBand) : undefined
    }});
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-full max-w-2xl bg-muted animate-pulse rounded" />
        <div className="h-[200px] w-full bg-muted animate-pulse rounded-xl" />
        <div className="h-[400px] w-full bg-muted animate-pulse rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error loading history</AlertTitle>
        <AlertDescription>{error?.message || "Failed to load historical basis data."}</AlertDescription>
      </Alert>
    );
  }

  const { filters, timeline, observedGrammar, coverage, outcomeAvailability, schemes, source, sourceLabels } = data;

  const historySummary = data.historySummary as unknown as HistorySummaryData;
  const groupCoverage = data.itemGroupCoverage as unknown as ItemGroupCoverageData;

  const handleGeneratorFieldChange = (field: "itemGroup" | "skuBand", value: string) => {
    if (value && value !== "all") {
      if (field === "itemGroup") form.setValue("skuBand", "");
      if (field === "skuBand") form.setValue("itemGroup", "");
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in-50 duration-500">
      
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 p-4 bg-muted/30 border rounded-lg shadow-sm" data-testid="container-filters">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Year</label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-[120px] bg-background" data-testid="filter-year">
              <SelectValue placeholder="All Years" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {availableYears.map(y => (
                <SelectItem key={y} value={y}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Item Group</label>
          <Select value={itemGroup} onValueChange={setItemGroup}>
            <SelectTrigger className="w-[180px] bg-background" data-testid="filter-item-group">
              <SelectValue placeholder="All Groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Groups</SelectItem>
              {filters.metadata.itemGroups.map(ig => (
                <SelectItem key={ig} value={ig}>{ig}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">SKU Band</label>
          <Select value={skuBand} onValueChange={setSkuBand}>
            <SelectTrigger className="w-[140px] bg-background" data-testid="filter-sku-band">
              <SelectValue placeholder="All Bands" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Bands</SelectItem>
              {filters.metadata.skuBands.map(sb => (
                <SelectItem key={sb} value={sb}>{sb}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Territory</label>
          <Select value={territory} onValueChange={setTerritory}>
            <SelectTrigger className="w-[180px] bg-background" data-testid="filter-territory">
              <SelectValue placeholder="All Territories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Territories</SelectItem>
              {filters.metadata.territories.map(t => (
                <SelectItem key={t.raw} value={t.raw}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* History Summary & Coverage Honesty */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="shadow-sm md:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              History Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Total Definitions</div>
                <div className="text-2xl font-bold font-mono" data-testid="status-scheme-count">{historySummary?.schemeCount || 0}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Live / Historical</div>
                <div className="text-lg font-mono">
                  <span className="text-emerald-600 dark:text-emerald-500" data-testid="status-live-count">{historySummary?.currentlyLiveCount || 0}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-muted-foreground" data-testid="status-historical-count">{historySummary?.historicalCount || 0}</span>
                </div>
              </div>
            </div>
            {historySummary?.source && (
              <Badge variant="outline" className="mt-4 text-[10px]" data-testid="source-summary">Source: {historySummary.source}</Badge>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm md:col-span-2 border-l-4 border-l-blue-500">
          <CardContent className="p-4 flex gap-4 h-full">
            <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
            <div className="space-y-3 w-full">
              <h3 className="font-semibold text-sm">Database Coverage & Item Groups</h3>
              <p className="text-xs text-muted-foreground leading-relaxed" data-testid="statement-coverage">
                {coverage.statement} {groupCoverage?.statement}
              </p>
              
              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/50">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Covered Groups</div>
                  <div className="text-sm font-medium" data-testid="status-covered-groups">
                    {groupCoverage?.covered?.length || 0} / {groupCoverage?.allItemGroups?.length || 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Never Covered</div>
                  <div className="text-sm text-amber-600 dark:text-amber-500 line-clamp-2" title={groupCoverage?.neverCovered?.join(", ")} data-testid="status-never-covered">
                    {groupCoverage?.neverCovered?.length ? groupCoverage.neverCovered.join(", ") : "None"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline" className="text-[10px] border-blue-200 text-blue-700 bg-blue-100/50 dark:border-blue-800 dark:text-blue-300" data-testid="source-coverage">
                  Source: {source}
                </Badge>
                {Object.entries(sourceLabels).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-[10px] border-blue-200 text-blue-700 bg-blue-100/50 dark:border-blue-800 dark:text-blue-300">
                    {k}: {v}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Alert className="border-l-4 border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500" />
          <AlertTitle className="text-amber-800 dark:text-amber-400">Outcomes & Lift Unavailable</AlertTitle>
          <AlertDescription className="text-amber-700/80 dark:text-amber-500/80 mt-2 text-sm leading-relaxed" data-testid="statement-absence">
            {outcomeAvailability.statement}
            <div className="mt-2 font-mono text-[10px] uppercase bg-amber-100 dark:bg-amber-900/40 px-2 py-1 rounded inline-block" data-testid="statement-evidence">
              Evidence Basis: {outcomeAvailability.evidenceBasis}
            </div>
          </AlertDescription>
        </Alert>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Timeline & Coverage Gaps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">{timeline.statement}</p>
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Observed Periods</div>
                <div className="flex flex-wrap gap-1.5">
                  {timeline.observedPeriods.length > 0 ? timeline.observedPeriods.map(p => (
                    <Badge key={p} variant="secondary" className="font-mono text-xs">{p}</Badge>
                  )) : <span className="text-sm text-muted-foreground">None</span>}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 text-amber-600">Coverage Gaps</div>
                <div className="flex flex-wrap gap-1.5">
                  {timeline.gaps.length > 0 ? timeline.gaps.map(g => (
                    <Badge key={g} variant="outline" className="font-mono text-xs border-amber-200 text-amber-700 bg-amber-50">{g}</Badge>
                  )) : <span className="text-sm text-muted-foreground">No explicit gaps recorded.</span>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              Observed Grammar
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">{observedGrammar.statement}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Qualification</div>
                <div className="text-sm">{observedGrammar.qualificationBases.join(", ") || "Unknown"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settlement</div>
                <div className="text-sm">{observedGrammar.settlementModes.join(", ") || "Unknown"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Threshold Units</div>
                <div className="text-sm">{observedGrammar.thresholdUnits.join(", ") || "Unknown"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Slab Count</div>
                <div className="text-sm">{observedGrammar.typicalSlabCount ?? "Unknown"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Scheme History
          </CardTitle>
          <CardDescription>
            Raw observed definitions from {source}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-[200px]">Scheme Name</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Slabs / Clarification</TableHead>
                  <TableHead>Rewards</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schemes.length > 0 ? schemes.map(scheme => (
                  <TableRow key={scheme.schemeId} data-testid={`row-scheme-${scheme.schemeId}`}>
                    <TableCell>
                      <div className="font-medium text-sm">{scheme.name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-1">{scheme.schemeId}</div>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {scheme.periodFrom} {scheme.periodTo ? `→ ${scheme.periodTo}` : ''}
                      {scheme.periodNote && <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[150px] truncate" title={scheme.periodNote}>{scheme.periodNote}</div>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {scheme.itemGroups.length > 0 && <div className="truncate max-w-[150px]" title={scheme.itemGroups.join(", ")}>Groups: {scheme.itemGroups.join(", ")}</div>}
                      {scheme.territoryGroup && <div>Territory: {scheme.territoryGroup}</div>}
                      {scheme.audience.length > 0 && <div className="text-muted-foreground truncate max-w-[150px]" title={scheme.audience.join(", ")}>Audience: {scheme.audience.join(", ")}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono">{scheme.observedStructure.slabCount} slabs</Badge>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        Unit: {scheme.observedStructure.thresholdUnit || 'N/A'}
                      </div>
                      {scheme.observedStructure.hasAlternativeReward && (
                        <div className="text-[10px] uppercase text-indigo-600 bg-indigo-50 mt-1 inline-block px-1 rounded">Alt Reward</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs space-y-1">
                      {scheme.slabs.map((slab, i) => (
                        <div key={i} className="flex flex-col border-b last:border-0 pb-1 last:pb-0 min-w-[140px]">
                          <div className="flex justify-between items-center">
                            <span className="font-mono text-muted-foreground">
                              {formatNumber(slab.thresholdFrom)} {slab.thresholdTo ? `- ${formatNumber(slab.thresholdTo)}` : '+'}
                            </span>
                            <span className="font-mono text-primary font-medium">
                              {slab.ratePct !== null ? `${slab.ratePct}%` : (slab.altReward || slab.freeGoods || 'Unknown')}
                            </span>
                          </div>
                          {slab.rewardStatus && slab.rewardStatus !== "CLEAR" && (
                            <span className="text-[9px] uppercase tracking-wider text-amber-600 bg-amber-50 rounded px-1 self-start mt-0.5">
                              {slab.rewardStatus}
                            </span>
                          )}
                        </div>
                      ))}
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No schemes matched the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm border-indigo-200 dark:border-indigo-900">
        <CardHeader className="bg-indigo-50/50 dark:bg-indigo-950/20 border-b border-indigo-100 dark:border-indigo-900/50">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base flex items-center gap-2 text-indigo-900 dark:text-indigo-200">
                <Lightbulb className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                Generate From History (Non-Persisting)
              </CardTitle>
              <CardDescription className="text-indigo-700/80 dark:text-indigo-300/80 mt-1">
                Copies an observed precedent structure without writing scheme tables. 
                Proposals include explicitly modeled costs and breakeven limits based on provided category facts.
              </CardDescription>
            </div>
            {generateMutation.isSuccess && (
              <Badge variant="outline" className="border-indigo-200 bg-indigo-100/50 text-indigo-700" data-testid="badge-persisted">
                Persisted: False
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="territory"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Territory</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger data-testid="input-territory">
                            <SelectValue placeholder="Select territory" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filters.metadata.territories.map(t => (
                            <SelectItem key={t.raw} value={t.raw}>{t.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="itemGroup"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Item Group</FormLabel>
                      <Select 
                        value={field.value} 
                        onValueChange={(val) => {
                          field.onChange(val);
                          handleGeneratorFieldChange("itemGroup", val);
                        }}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="input-item-group" disabled={!!form.watch("skuBand") && form.watch("skuBand") !== "all"}>
                            <SelectValue placeholder="Select item group (mutually exclusive)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="all">None</SelectItem>
                          {filters.metadata.itemGroups.map(ig => (
                            <SelectItem key={ig} value={ig}>{ig}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="skuBand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SKU Band</FormLabel>
                      <Select 
                        value={field.value} 
                        onValueChange={(val) => {
                          field.onChange(val);
                          handleGeneratorFieldChange("skuBand", val);
                        }}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="input-sku-band" disabled={!!form.watch("itemGroup") && form.watch("itemGroup") !== "all"}>
                            <SelectValue placeholder="Select SKU band (mutually exclusive)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="all">None</SelectItem>
                          {Object.values(GenerateAiSchemesHistoryRequestSkuBand).map(sb => (
                            <SelectItem key={sb} value={sb}>{sb}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="marginCapPct"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Margin Cap (%)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.1" placeholder="e.g. 5.5" data-testid="input-margin-cap" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="breadthOpportunityRetailers"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Breadth Opp. Retailers</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="e.g. 150" data-testid="input-breadth-opp" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="categoryGrossMarginInr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category GM (INR)</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="e.g. 500000" data-testid="input-cat-margin" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="grossMarginRatePct"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GM Rate (%)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.1" placeholder="e.g. 15.0" data-testid="input-margin-rate" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {form.formState.errors.itemGroup && (
                <Alert variant="destructive" className="mt-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Validation Error</AlertTitle>
                  <AlertDescription>{form.formState.errors.itemGroup.message}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end pt-4 border-t">
                <Button 
                  type="submit" 
                  disabled={generateMutation.isPending}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  data-testid="button-generate"
                >
                  {generateMutation.isPending ? 'Generating...' : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Generate Proposal
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>

          {generateMutation.isError && (
            <Alert variant="destructive" className="mt-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Generation Failed</AlertTitle>
              <AlertDescription>{generateMutation.error?.message || "An error occurred."}</AlertDescription>
            </Alert>
          )}

          {generateMutation.isSuccess && generateMutation.data && (
            <div className="mt-8 pt-8 border-t border-indigo-100 dark:border-indigo-900 animate-in slide-in-from-bottom-4 duration-500">
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Proposal Structure Panel */}
                <Card className="bg-muted/20 shadow-none border-dashed border-border/60">
                  <CardHeader className="pb-3 border-b border-border/50">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      Proposal Structure
                    </CardTitle>
                    {(() => {
                      const precedent = generateMutation.data.closestPrecedent as unknown as ClosestPrecedentData;
                      return precedent && (
                        <div className="text-xs text-muted-foreground mt-2" data-testid="result-precedent-name">
                          Closest Precedent: <span className="font-medium text-foreground">{precedent.name} ({precedent.schemeId})</span>
                        </div>
                      );
                    })()}
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    {(() => {
                      const p = generateMutation.data.proposal as unknown as ProposalData;
                      if (!p) return null;
                      return (
                        <>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Qualification</div>
                              <div className="font-medium">{p.qualificationBasis}</div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Settlement</div>
                              <div className="font-medium">{p.settlement}</div>
                            </div>
                            <div className="col-span-2">
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Duration</div>
                              <div>{p.duration?.periodFrom} → {p.duration?.periodTo || 'Ongoing'}</div>
                            </div>
                          </div>
                          
                          <div className="pt-2">
                            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Proposed Slabs</div>
                            <div className="bg-background border rounded p-2 space-y-2" data-testid="result-slabs">
                              {p.slabs?.map((slab, i) => (
                                <div key={i} className="flex justify-between items-center text-sm border-b last:border-0 pb-1 last:pb-0">
                                  <span className="font-mono">{formatNumber(slab.thresholdFrom)}</span>
                                  <span className="font-mono text-primary font-bold">
                                    {slab.ratePct !== null ? `${formatPct(slab.ratePct)}` : slab.altReward || slab.freeGoods}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </CardContent>
                </Card>

                {/* Economics Panel */}
                <Card className="bg-muted/20 shadow-none border-dashed border-border/60">
                  <CardHeader className="pb-3 border-b border-border/50">
                    <CardTitle className="text-sm font-semibold">Modeled Economics</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-5">
                    {(() => {
                      const p = generateMutation.data.proposal as unknown as ProposalData;
                      const b = generateMutation.data.breakevenLiftRequired as unknown as MarginBreakevenData;
                      return (
                        <>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Modeled Cost</div>
                              <div className="text-lg font-mono font-bold text-indigo-700 dark:text-indigo-400" data-testid="result-modeled-cost">
                                {formatIndianCurrency(p?.estimatedCostInr)}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Cost as % GM</div>
                              <div className="text-lg font-mono font-bold text-amber-600 dark:text-amber-500" data-testid="result-cost-pct">
                                {formatPct(p?.costAsMarginPct)}
                              </div>
                            </div>
                          </div>
                          
                          <div className="bg-background border rounded p-3 text-xs text-muted-foreground space-y-1">
                            <div className="font-medium text-foreground">Cost Assumption</div>
                            <div data-testid="result-cost-assumption">{p?.modeledCostAssumption}</div>
                          </div>

                          <div className="pt-2 border-t border-border/50">
                            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Breakeven Lift Required</div>
                            <div className="text-xl font-mono font-bold" data-testid="result-breakeven">
                              {formatIndianCurrency(b?.value)}
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              {b?.statement}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </CardContent>
                </Card>
              </div>

              {/* Flags & Guardrails */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                {(() => {
                  const flags = generateMutation.data.flags as unknown as FlagsData;
                  if (!flags || Object.keys(flags).length === 0) return null;
                  return (
                    <div className="p-4 rounded-lg bg-orange-50/50 border border-orange-200 dark:bg-orange-950/20 dark:border-orange-900" data-testid="result-flags">
                      <h4 className="text-sm font-semibold text-orange-800 dark:text-orange-400 mb-3 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" />
                        Warning Flags
                      </h4>
                      <ul className="space-y-2 text-xs text-orange-800 dark:text-orange-300">
                        {flags.beyondPrecedent && <li>• Requested definition structure goes beyond observed scheme definitions.</li>}
                        {flags.borrowedFromComparableGroup && <li>• <span className="font-semibold">Borrowed</span>: Target group lacked history; borrowed from comparable group.</li>}
                        {flags.modeledRateCeilingApplied && (
                          <li>• <span className="font-semibold">Modeled rate ceiling:</span> the supplied margin cap limits proposal rates; it is not an observed historical cost ceiling.</li>
                        )}
                        {flags.modeledRateCeilingBinding && <li>• The modeled rate ceiling was binding, so one or more observed rates were clamped.</li>}
                        {!flags.historicalCostCeilingAvailable && (
                          <li>• No historical cost ceiling is available, and no proposal-cost comparison against historical spend was performed.</li>
                        )}
                        <li>• {flags.statement}</li>
                      </ul>
                    </div>
                  );
                })()}

                {(() => {
                  const guardrails = generateMutation.data.guardrails as unknown as GuardrailsData;
                  const controlLift = generateMutation.data.controlLift as unknown as ControlLiftData;
                  
                  if ((!guardrails || Object.keys(guardrails).length === 0) && !controlLift) return null;
                  return (
                    <div className="p-4 rounded-lg bg-blue-50/50 border border-blue-200 dark:bg-blue-950/20 dark:border-blue-900" data-testid="result-guardrails">
                      <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-400 mb-2 flex items-center gap-2">
                        <Info className="h-4 w-4" />
                        Guardrails Applied
                      </h4>
                      <p className="text-xs text-blue-800 dark:text-blue-300 leading-relaxed space-y-2">
                        {guardrails?.sourceHonesty && <span className="block">• {guardrails.sourceHonesty}</span>}
                        {controlLift?.statement && <span className="block">• <span className="font-semibold" data-testid="result-no-control">No Control</span>: {controlLift.statement}</span>}
                      </p>
                    </div>
                  );
                })()}
              </div>

            </div>
          )}

        </CardContent>
      </Card>

    </div>
  );
}
