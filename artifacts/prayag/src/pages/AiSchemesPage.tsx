import React from "react";
import {
  useGetAiSchemesAnalytics,
} from "@workspace/api-client-react";
import { AlertCircle, FileWarning, SearchX, Clock, MapPin, Database, Factory, PackageOpen, Boxes, CheckCircle2, FileX, Info, BookOpen, BarChart3 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

// Formatting helpers
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

export default function AiSchemesPage() {
  const [selectedFy, setSelectedFy] = React.useState<string>("2025-26");

  const { data, isLoading, isError, error } = useGetAiSchemesAnalytics({
    fy: '2025-26,2026-27',
  });

  React.useEffect(() => {
    if (data?.fys && data.fys.length > 0 && !data.fys.includes(selectedFy)) {
      setSelectedFy(data.fys[0]);
    }
  }, [data?.fys, selectedFy]);

  if (isLoading) {
    return (
      <div className="flex-1 p-8 flex flex-col gap-6">
        <div className="flex justify-between items-center">
          <div>
            <div className="h-8 w-48 bg-muted animate-pulse rounded mb-2" />
            <div className="h-4 w-96 bg-muted animate-pulse rounded" />
          </div>
        </div>
        <div className="h-10 w-full max-w-md bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="h-[400px] bg-muted animate-pulse rounded-xl" />
          <div className="h-[400px] bg-muted animate-pulse rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex-1 p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Cannot load analytics</AlertTitle>
          <AlertDescription>
            {error?.message || "An unknown error occurred loading AI Schemes data."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const report = data.reports.find(r => r.fy === selectedFy) || data.reports[0];

  if (!report) {
     return (
      <div className="flex-1 p-8">
        <Alert>
          <SearchX className="h-4 w-4" />
          <AlertTitle>No data available</AlertTitle>
          <AlertDescription>
            No scheme analytics reports are available for the selected parameters.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Dynamic Pipe vs Fitting Note
  const getMargin = (catName: string) => report.marginHeadroom.categories.find(c => c.category === catName)?.grossMarginPct;
  const cpvcFittings = getMargin('CPVC Fittings');
  const cpvcPipe = getMargin('CPVC Pipe');
  const agriFittings = getMargin('AGRI Fittings');
  const agriPipe = getMargin('AGRI Pipe');

  const cpvcNote = (cpvcFittings !== undefined && cpvcPipe !== undefined && cpvcFittings !== null && cpvcPipe !== null)
    ? `CPVC Fittings (${formatPct(cpvcFittings)}) vs CPVC Pipe (${formatPct(cpvcPipe)})`
    : 'CPVC pipe vs fitting economics unavailable';

  const agriNote = (agriFittings !== undefined && agriPipe !== undefined && agriFittings !== null && agriPipe !== null)
    ? `AGRI Fittings (${formatPct(agriFittings)}) vs AGRI Pipe (${formatPct(agriPipe)})`
    : 'AGRI pipe vs fitting economics unavailable';

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-muted/20">
      <div className="flex-none p-6 pb-0 max-w-[1600px] w-full mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" />
              AI Schemes Analytics
            </h1>
            <div className="text-sm text-muted-foreground mt-1">
              Read-only commercial analytics surface.
              {data.readOnly && <Badge variant="outline" className="ml-2 bg-background">Read Only Mode</Badge>}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Select value={selectedFy} onValueChange={setSelectedFy}>
              <SelectTrigger className="w-[140px] bg-background">
                <SelectValue placeholder="Select FY" />
              </SelectTrigger>
              <SelectContent>
                {data.fys.map(fy => (
                  <SelectItem key={fy} value={fy}>FY {fy}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="secondary" className="px-3 py-1 font-medium bg-primary/10 text-primary border-primary/20">
              Source: {data.source}
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-12 max-w-[1600px] w-full mx-auto">

        {/* Coverage Context - Crucial for "auditable commercial analytics" */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
           <Card className="md:col-span-3 border-l-4 border-l-blue-500 shadow-sm">
             <CardContent className="p-4 flex gap-4">
                <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-sm">Pipe & Fitting Economics Note</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    E2 uses secondary order-booking SKU lines for positive retailer-item pairs and authoritative current catalogue codes for dormant counts.
                    E3 uses gross contribution from margin_fact, with unknown margin and open resolution-held periods suppressed during calculation.
                    <br/>
                    <span className="font-medium text-foreground mt-1 block">
                      Observations: {cpvcNote} | {agriNote}
                    </span>
                  </p>
                </div>
             </CardContent>
           </Card>
           <Card className={`border-l-4 shadow-sm ${!report.coverage.geography.available ? 'border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/10' : 'border-l-emerald-500'}`}>
             <CardContent className="p-4 flex gap-3">
                {!report.coverage.geography.available ?
                  <MapPin className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" /> :
                  <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
                }
                <div className="space-y-1">
                  <h3 className="font-semibold text-sm">Geography Data</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                    {report.coverage.geography.statement}
                  </p>
                </div>
             </CardContent>
           </Card>
        </div>

        {/* Global Metadata Banner */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-6 text-xs text-muted-foreground bg-background border rounded-md px-4 py-3 shadow-sm">
           <div className="flex items-center gap-1.5" title="Months of active data loaded for this FY">
             <Clock className="h-3.5 w-3.5" />
             <span className="font-medium text-foreground">Loaded:</span>
             {report.coverage.loadedMonths.length > 0 ? report.coverage.loadedMonths.join(", ") : "None"}
           </div>

           {report.coverage.heldPeriods.length > 0 && (
             <div className="flex items-center gap-1.5" title="Periods held back from analysis (e.g. open resolutions)">
               <FileWarning className="h-3.5 w-3.5 text-amber-500" />
               <span className="font-medium text-amber-700 dark:text-amber-500">Held Periods:</span>
               <span className="text-amber-600 dark:text-amber-400">{report.coverage.heldPeriods.join(", ")}</span>
             </div>
           )}

            {report.coverage.heldPeriods.includes("Aug-26") && (
              <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                <FileWarning className="h-3.5 w-3.5" />
                <span className="font-semibold">H2:</span>
                <span>August 2026 is held and excluded from E2 calculations.</span>
              </div>
            )}

           <div className="flex-1" />

           <div className="flex items-center gap-4 border-l pl-4">
             {Object.entries(report.coverage.sources).map(([key, val]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <Database className="h-3 w-3 opacity-70" />
                  <span className="uppercase tracking-wider opacity-70">{key}:</span>
                  <span className="font-medium font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">{val}</span>
                </div>
             ))}
           </div>
        </div>

        <Tabs defaultValue="breadth" className="w-full">
          <TabsList className="grid w-full grid-cols-3 max-w-2xl mb-8">
            <TabsTrigger value="breadth">Breadth Opportunity</TabsTrigger>
            <TabsTrigger value="sku-bands">SKU Bands</TabsTrigger>
            <TabsTrigger value="margin">Margin Headroom</TabsTrigger>
          </TabsList>

          <TabsContent value="breadth" className="space-y-6 animate-in fade-in-50 duration-500">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* Pair Matrix */}
              <Card className="lg:col-span-1 shadow-sm flex flex-col">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Factory className="h-4 w-4 text-primary" />
                        Distribution Matrix
                      </CardTitle>
                      <CardDescription>
                        Base density of active items across ordering retailers.
                      </CardDescription>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-mono whitespace-nowrap">
                      {report.fy} Source
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6 flex-1">

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Active Retailers</div>
                      <div className="text-2xl font-bold font-mono">{formatNumber(report.pairMatrix.activeRetailers)}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Total SKUs</div>
                      <div className="text-2xl font-bold font-mono">{formatNumber(report.pairMatrix.skus)}</div>
                    </div>
                  </div>

                  <div className="p-4 bg-muted/40 rounded-lg border border-border/50">
                    <div className="flex justify-between items-end mb-2">
                      <div className="text-sm font-medium">Network Density</div>
                      <div className="text-xl font-bold text-primary">{formatPct(report.pairMatrix.pairDensityPct, 2)}</div>
                    </div>
                    <div className="text-xs text-muted-foreground mb-4">
                      {formatNumber(report.pairMatrix.positivePairs)} positive pairs
                    </div>

                    <div className="space-y-2 pt-4 border-t border-border/50">
                       <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Pair value (₹)</div>

                       <div className="flex justify-between items-center text-[10px] bg-muted/30 px-2 py-1 rounded">
                         <span className="text-muted-foreground uppercase tracking-wider">Bottom 10% Avg</span>
                         <span className="font-mono">{formatIndianCurrency(report.pairMatrix.valueDistribution.bottomDecileAverage)}</span>
                       </div>

                       <div className="flex justify-between items-center text-sm px-2">
                         <span className="text-muted-foreground">P10</span>
                         <span className="font-mono font-medium">{formatIndianCurrency(report.pairMatrix.valueDistribution.p10)}</span>
                       </div>
                       <div className="flex justify-between items-center text-sm px-2">
                         <span className="text-muted-foreground">P25</span>
                         <span className="font-mono font-medium">{formatIndianCurrency(report.pairMatrix.valueDistribution.p25)}</span>
                       </div>
                       <div className="flex justify-between items-center text-sm px-2">
                         <span className="text-foreground font-medium">Median</span>
                         <span className="font-mono font-bold text-primary">{formatIndianCurrency(report.pairMatrix.valueDistribution.median)}</span>
                       </div>
                       <div className="flex justify-between items-center text-sm px-2">
                         <span className="text-muted-foreground">P75</span>
                         <span className="font-mono font-medium">{formatIndianCurrency(report.pairMatrix.valueDistribution.p75)}</span>
                       </div>
                       <div className="flex justify-between items-center text-sm px-2">
                         <span className="text-muted-foreground">P90</span>
                         <span className="font-mono font-medium">{formatIndianCurrency(report.pairMatrix.valueDistribution.p90)}</span>
                       </div>

                       <div className="flex justify-between items-center text-[10px] bg-muted/30 px-2 py-1 rounded mt-1">
                         <span className="text-muted-foreground uppercase tracking-wider">Top 10% Avg</span>
                         <span className="font-mono">{formatIndianCurrency(report.pairMatrix.valueDistribution.topDecileAverage)}</span>
                       </div>
                    </div>
                  </div>

                  <div className="text-[11px] text-muted-foreground italic flex items-start gap-1.5 mt-auto">
                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    Identity Rule: {report.pairMatrix.identityRule}
                  </div>

                </CardContent>
              </Card>

              {/* Breadth Arithmetic */}
              <Card className="lg:col-span-2 shadow-sm flex flex-col">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <PackageOpen className="h-4 w-4 text-primary" />
                        Breadth Arithmetic (+1 / +2 / +3)
                      </CardTitle>
                      <CardDescription>
                        {report.breadthArithmetic.label}
                      </CardDescription>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-mono whitespace-nowrap">
                      {report.fy} Source
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex-1">
                   <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent border-b-2">
                        <TableHead className="w-[200px] font-semibold">Expansion Scenario</TableHead>
                        <TableHead className="text-right font-semibold">Observed P10 Arithmetic</TableHead>
                        <TableHead className="text-right font-semibold bg-primary/5 text-primary">Median Arithmetic</TableHead>
                        <TableHead className="text-right font-semibold">Observed P90 Arithmetic</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.breadthArithmetic.increments.map((inc, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium bg-muted/20">
                            +{inc.additionalSkusPerRetailer} SKU{inc.additionalSkusPerRetailer > 1 ? 's' : ''} per retailer
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {formatIndianCurrency(inc.lowValue)}
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold bg-primary/5 text-primary">
                            {formatIndianCurrency(inc.medianValue)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {formatIndianCurrency(inc.highValue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                   </Table>

                </CardContent>
              </Card>

            </div>
          </TabsContent>

          <TabsContent value="sku-bands" className="space-y-6 animate-in fade-in-50 duration-500">
            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-start justify-between pb-4">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Boxes className="h-4 w-4 text-primary" />
                    Catalogue Banding
                  </CardTitle>
                  <CardDescription>
                    Performance tiers based on primary value share.
                  </CardDescription>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <Badge variant="outline" className="text-[10px] font-mono whitespace-nowrap">
                    {report.fy} Source
                  </Badge>
                  {report.dormant.catalogueCodes > 0 && (
                    <Badge variant="outline" className="px-3 py-1.5 flex gap-2 items-center bg-muted/30 mt-1">
                      <FileX className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono">{formatNumber(report.dormant.catalogueCodes)}</span>
                      <span className="text-muted-foreground font-normal">Authoritative catalogue codes</span>
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="w-[120px]">Band</TableHead>
                        <TableHead className="text-right">Codes</TableHead>
                        <TableHead className="text-right">Primary Value</TableHead>
                        <TableHead className="text-right w-[120px]">Share</TableHead>
                        <TableHead className="text-right text-muted-foreground">Sales / Code</TableHead>
                        <TableHead className="text-right text-muted-foreground">Retailers (Mean)</TableHead>
                        <TableHead className="text-right text-muted-foreground">Retailers (Med)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.skuBands.map((band) => {
                        const isDormant = band.band === 'DORMANT' || band.band === 'SCARCE';
                        return (
                          <TableRow key={band.band} className={isDormant ? "bg-muted/10" : ""}>
                            <TableCell className="font-medium">
                              {band.band}
                              {isDormant && band.dormantBasis && (
                                <span className="block text-[10px] text-muted-foreground font-normal mt-0.5" title="Reason for dormant classification">
                                  {band.dormantBasis}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono">{formatNumber(band.codes)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatIndianCurrency(band.primaryValue)}
                            </TableCell>
                            <TableCell className="text-right">
                              {band.primarySharePct > 0 ? (
                                <div className="flex items-center justify-end gap-2">
                                  <div className="font-mono text-sm">{formatPct(band.primarySharePct, 1)}</div>
                                  <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-primary/70 rounded-full"
                                      style={{ width: `${Math.min(100, band.primarySharePct)}%` }}
                                    />
                                  </div>
                                </div>
                              ) : <span className="font-mono text-sm">0.0%</span>}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {formatIndianCurrency(band.salesPerCode)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {formatNumber(band.retailersPerSkuMean, 1)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {formatNumber(band.retailersPerSkuMedian, 1)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {report.dormant && (report.dormant.neverSold > 0 || report.dormant.zeroPrimarySales > 0) && (
                  <div className="mt-6 grid grid-cols-2 gap-4">
                     {report.dormant.neverSold > 0 && (
                       <div className="p-4 border rounded-lg bg-red-50/30 dark:bg-red-950/10 flex items-center justify-between">
                         <div className="space-y-1">
                           <div className="text-sm font-semibold text-red-800 dark:text-red-400">Never Sold</div>
                           <div className="text-xs text-muted-foreground">Current-catalogue codes never sold in any loaded primary FY</div>
                         </div>
                         <div className="text-2xl font-mono font-bold text-red-700 dark:text-red-500">
                           {formatNumber(report.dormant.neverSold)}
                         </div>
                       </div>
                     )}
                     {report.dormant.zeroPrimarySales > 0 && (
                       <div className="p-4 border rounded-lg bg-orange-50/30 dark:bg-orange-950/10 flex items-center justify-between">
                         <div className="space-y-1">
                           <div className="text-sm font-semibold text-orange-800 dark:text-orange-400">Zero Primary Dispatches</div>
                           <div className="text-xs text-muted-foreground">Current-catalogue codes with zero primary dispatch in selected FY</div>
                         </div>
                         <div className="text-2xl font-mono font-bold text-orange-700 dark:text-orange-500">
                           {formatNumber(report.dormant.zeroPrimarySales)}
                         </div>
                       </div>
                     )}
                  </div>
                )}

              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="margin" className="space-y-6 animate-in fade-in-50 duration-500">

            {report.marginHeadroom.suppressedUnknownMargin && (
              <Alert className="bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900 text-blue-800 dark:text-blue-300">
                <Info className="h-4 w-4 !text-blue-600 dark:!text-blue-400" />
                <AlertTitle className="text-blue-900 dark:text-blue-200">Unknown Margin Suppressed</AlertTitle>
                <div className="text-sm text-blue-800/80 dark:text-blue-300/80 mt-2 space-y-1">
                  <div>Transactions lacking established margin facts have been explicitly suppressed from headroom calculations to maintain auditability.</div>
                  <div>
                    Metrics reflect <span className="font-mono font-semibold">{formatPct(report.marginHeadroom.valueRepresentedPct, 1)}</span> of total value
                    and <span className="font-mono font-semibold">{report.marginHeadroom.secondarySkuCount > 0 ? formatPct(report.marginHeadroom.usableSecondarySkuCount * 100 / report.marginHeadroom.secondarySkuCount, 1) : '0.0%'}</span> of SKUs
                    ({formatNumber(report.marginHeadroom.usableSecondarySkuCount)} / {formatNumber(report.marginHeadroom.secondarySkuCount)}).
                  </div>
                </div>
              </Alert>
            )}

            <Card className="shadow-sm">
              <CardHeader className="pb-4">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-primary" />
                      Category Margin Economics
                    </CardTitle>
                    <CardDescription>
                      Gross contribution and maximum theoretical scheme depth limits.
                    </CardDescription>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant="outline" className="text-[10px] font-mono whitespace-nowrap">
                      {report.fy} Source
                    </Badge>
                    {report.marginHeadroom.marginFactMonths.length > 0 && (
                      <div className="text-[10px] text-muted-foreground text-right mt-1">
                        <div className="font-semibold uppercase tracking-wider mb-0.5">Margin Fact Months</div>
                        <div className="font-mono max-w-[200px] truncate" title={report.marginHeadroom.marginFactMonths.join(", ")}>
                          {report.marginHeadroom.marginFactMonths.join(", ")}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="w-[100px]">Tier</TableHead>
                        <TableHead className="text-right">Gross Margin</TableHead>
                        <TableHead className="text-right">Max Depth Limit</TableHead>
                        <TableHead className="text-right">Limit Share of Margin</TableHead>
                        <TableHead className="text-right text-muted-foreground">SKU Coverage</TableHead>
                        <TableHead className="text-right text-muted-foreground">Value Coverage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.marginHeadroom.categories.map((cat) => {
                        const isHeld = cat.heldCategories && cat.heldCategories.includes(cat.category);
                        const isBareZero = cat.marginTier === 'BARE' && cat.maximumSchemeDepthPct === 0;

                        return (
                          <TableRow key={cat.category}>
                            <TableCell className="font-medium">
                              {cat.category}
                              {isHeld && <Badge variant="outline" className="ml-2 text-[9px] uppercase tracking-wider text-amber-700 bg-amber-50 dark:bg-amber-900/30 border-amber-200">Hold Applied</Badge>}
                            </TableCell>
                            <TableCell>
                              {cat.marginTier ? (
                                <Badge variant="outline" className={`
                                  ${cat.marginTier === 'RICH' ? 'border-emerald-200 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/20' : ''}
                                  ${cat.marginTier === 'MID' ? 'border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-950/20' : ''}
                                  ${cat.marginTier === 'THIN' ? 'border-amber-200 text-amber-700 bg-amber-50 dark:bg-amber-950/20' : ''}
                                  ${cat.marginTier === 'BARE' ? 'border-red-200 text-red-700 bg-red-50 dark:bg-red-950/20' : ''}
                                `}>
                                  {cat.marginTier}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono font-medium">
                              {formatPct(cat.grossMarginPct, 1)}
                            </TableCell>
                            <TableCell className="text-right font-mono font-bold text-primary">
                              {isBareZero ? (
                                <span className="flex flex-col items-end">
                                  <span>0.0%</span>
                                  <span className="text-[9px] font-sans font-normal text-muted-foreground uppercase mt-0.5">No cash scheme</span>
                                </span>
                              ) : formatPct(cat.maximumSchemeDepthPct, 1)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {cat.maximumSchemeShareOfGrossMarginPct !== null && cat.maximumSchemeShareOfGrossMarginPct > 50 ? (
                                <span className="text-amber-600 dark:text-amber-500">
                                  {formatPct(cat.maximumSchemeShareOfGrossMarginPct, 1)}
                                </span>
                              ) : formatPct(cat.maximumSchemeShareOfGrossMarginPct, 1)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground text-sm">
                              {formatPct(cat.skuCoveragePct, 1)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground text-sm">
                              {formatPct(cat.valueCoveragePct, 1)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
