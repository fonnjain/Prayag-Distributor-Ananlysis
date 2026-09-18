import React, { useState, useMemo, useEffect } from "react";
import {
  useGetAiPlan,
  useGetAiPlanMonths,
  useGetAiPlanAnalytics,
  useGenerateAiPlan,
  useApproveAiPlan,
  useRegenerateAiPlan,
  useReconcileAiPlan,
  useGetAiPlanVsActual,
  getGetAiPlanQueryKey,
  getGetAiPlanVsActualQueryKey,
  useGetMgmtDeepDive,
  getGetMgmtDeepDiveQueryKey,
  getGetAiPlanMonthsQueryKey,
  getGetAiPlanAnalyticsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Map, RefreshCw, Check, FileDown, AlertTriangle, Calendar, User, Info, FileText, CheckCircle2, History, TrendingUp, Navigation, AlertCircle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function authenticatedJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${BASE}${url}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init.headers } });
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response.json();
}

// Helper to format values
const formatValue = (val: unknown): React.ReactNode => {
  if (val === null || val === undefined) return <span className="text-muted-foreground opacity-50">—</span>;
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") {
    // Basic heuristic: if it looks like a year, just return it; if it has decimals, format it
    if (val > 1900 && val < 2100 && Number.isInteger(val)) return val;
    return new Intl.NumberFormat('en-IN').format(val);
  }
  return String(val);
};

export default function AiPlanPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Default to 2026-27 per instruction.
  const [selectedFy, setSelectedFy] = useState<string>("2026-27");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [selectedMember, setSelectedMember] = useState<string>("");

  // Queries
  // 1. Get member list for dropdown
  const { data: memberListData, isLoading: isLoadingMembers } = useGetMgmtDeepDive({ fy: selectedFy });

  // 2. Get valid months for the dropdown
  const { data: monthsData, isLoading: isLoadingMonths } = useGetAiPlanMonths({ fy: selectedFy });

  // 3. Get plan list filtered by history
  const { data: planListResp, isLoading: isLoadingPlans, isError: isPlansError } = useGetAiPlan(
    { fy: selectedFy, member: selectedMember, month: selectedMonth, history: true },
    {
      query: {
        enabled: !!selectedMember && !!selectedMonth,
        queryKey: getGetAiPlanQueryKey({ fy: selectedFy, member: selectedMember, month: selectedMonth, history: true })
      }
    }
  );

  // 4. Get analytics for PACE and COVERAGE GAP
  const { data: analyticsResp, isLoading: isLoadingAnalytics } = useGetAiPlanAnalytics({ fy: selectedFy });

  const availableMembers = useMemo(() => memberListData?.members || [], [memberListData]);
  const validMonths = useMemo(() => monthsData?.months || [], [monthsData]);

  // Derived forward months for 2026-27
  useEffect(() => {
    if (validMonths.length > 0 && selectedMonth && !validMonths.includes(selectedMonth)) {
      setSelectedMonth("");
    }
  }, [validMonths, selectedMonth]);

  useEffect(() => {
    if (selectedMember && availableMembers.length > 0) {
      const exists = availableMembers.some(m => m.name === selectedMember);
      if (!exists) {
        setSelectedMember("");
      }
    }
  }, [selectedFy, availableMembers, selectedMember]);

  const historyPlans = useMemo(() => {
    if (!planListResp?.revisionHistory) return [];
    return planListResp.revisionHistory;
  }, [planListResp]);

  const currentPlan = useMemo(() => {
    if (!planListResp?.plans) return null;
    return planListResp.currentPlanId
      ? planListResp.plans.find((p: any) => p.id === planListResp.currentPlanId)
      : planListResp.plans.find((p: any) => p.status !== 'superseded');
  }, [planListResp]);

  const analyticsFigure = useMemo(() => {
    if (!analyticsResp?.figures || !currentPlan) return null;
    return analyticsResp.figures.find((f: any) =>
      f.member === selectedMember &&
      f.month === selectedMonth &&
      f.source_snapshot_hash === currentPlan.sourceSnapshotHash
    );
  }, [analyticsResp, currentPlan, selectedMember, selectedMonth]);

  const stateHeadFigure = useMemo(() => {
    if (!analyticsResp?.stateHeads || !selectedMember || !selectedMonth) return null;
    const shName = availableMembers.find(m => m.name === selectedMember)?.stateHead;
    if (!shName) return null;
    return analyticsResp.stateHeads.find((sh: any) => sh.stateHead === shName && sh.month === selectedMonth);
  }, [analyticsResp, availableMembers, selectedMember, selectedMonth]);

  // Specific plan queries
  const { data: vsActualData, isLoading: isLoadingVsActual, refetch: refetchVsActual } = useGetAiPlanVsActual(currentPlan?.id || 0, {
    query: {
      enabled: !!currentPlan?.id,
      queryKey: getGetAiPlanVsActualQueryKey(currentPlan?.id || 0)
    }
  });

  // Manual query for Travel Plan (Guidance)
  const { data: travelPlanData, isLoading: isLoadingTravelPlan, error: travelPlanError } = useQuery({
    queryKey: ["ai-travel-plan", selectedFy, selectedMember, selectedMonth],
    queryFn: async () => {
      const stateHead = availableMembers.find(m => m.name === selectedMember)?.stateHead || "";
      return authenticatedJson("/api/ai/travel-plan", {
        method: "POST",
        body: JSON.stringify({ fy: selectedFy, member: selectedMember, stateHead, period: selectedMonth })
      });
    },
    enabled: !!selectedMember && !!selectedFy && !!selectedMonth,
  });

  // Mutations
  const generatePlan = useGenerateAiPlan();
  const approvePlan = useApproveAiPlan();
  const regeneratePlan = useRegenerateAiPlan();
  const reconcilePlan = useReconcileAiPlan();

  const handleGenerate = () => {
    if (!selectedMember || !selectedMonth) return;
    const stateHead = availableMembers.find(m => m.name === selectedMember)?.stateHead || "";
    generatePlan.mutate(
      { data: { member: selectedMember, stateHead, fy: selectedFy, month: selectedMonth } },
      {
        onSuccess: () => {
          toast({ title: "Plan generated successfully" });
          queryClient.invalidateQueries({ queryKey: getGetAiPlanQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: "destructive", title: "Generation failed", description: err.message || "Unknown error" });
        }
      }
    );
  };

  const handleApprove = () => {
    if (!currentPlan) return;
    approvePlan.mutate(
      { id: currentPlan.id },
      {
        onSuccess: () => {
          toast({ title: "Plan approved" });
          queryClient.invalidateQueries({ queryKey: getGetAiPlanQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: "destructive", title: "Approval failed", description: err.message || "Unknown error" });
        }
      }
    );
  };

  const handleRegenerate = () => {
    if (!currentPlan) return;
    const stateHead = availableMembers.find(m => m.name === selectedMember)?.stateHead || "";
    regeneratePlan.mutate(
      { id: currentPlan.id, data: { member: selectedMember, stateHead, fy: selectedFy, month: selectedMonth } },
      {
        onSuccess: () => {
          toast({ title: "Plan regenerated", description: "Prior proposal superseded." });
          queryClient.invalidateQueries({ queryKey: getGetAiPlanQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: "destructive", title: "Regeneration failed", description: err.message || "Unknown error" });
        }
      }
    );
  };

  const handleReconcile = () => {
    if (!currentPlan) return;
    reconcilePlan.mutate(
      { id: currentPlan.id },
      {
        onSuccess: (res) => {
          toast({ title: "Reconciliation complete", description: res.inference });
          refetchVsActual();
        },
        onError: (err: any) => {
          toast({ variant: "destructive", title: "Reconciliation failed", description: err.message || "Unknown error" });
        }
      }
    );
  };

  const handleExport = async () => {
    if (!currentPlan) return;
    try {
      const response = await fetch(`${BASE}/api/ai-plan/${currentPlan.id}/export`, { method: "GET", credentials: "include" });
      if (!response.ok) throw new Error((await response.text()) || `Export failed (${response.status})`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-plan-${currentPlan.id}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Export failed", description: err.message || "Unknown error" });
    }
  };

  if (isPlansError) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading AI Visit Plans</AlertTitle>
          <AlertDescription>Could not connect to the server.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const neverVisited = analyticsFigure?.coverageNeverVisitedRanking || [];
  const dormantList = analyticsFigure?.dormantRetailers || [];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <div className="flex-none px-6 py-6 border-b bg-card">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 max-w-[1600px] mx-auto w-full">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Map className="h-6 w-6 text-primary" />
              AI Visit Plan
            </h1>
            <div className="text-sm text-muted-foreground mt-1">
              Source-explicit visit priorities and inferred outcomes
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
             <Select value={selectedFy} onValueChange={setSelectedFy}>
               <SelectTrigger className="w-[120px]">
                 <SelectValue placeholder="FY" />
               </SelectTrigger>
               <SelectContent>
                 <SelectItem value="2026-27">2026-27</SelectItem>
               </SelectContent>
             </Select>

             <Select value={selectedMonth} onValueChange={setSelectedMonth} disabled={isLoadingMonths || validMonths.length === 0}>
               <SelectTrigger className="w-[120px]">
                 <SelectValue placeholder={isLoadingMonths ? "Loading..." : "Month"} />
               </SelectTrigger>
               <SelectContent>
                 {validMonths.map((m: string) => (
                   <SelectItem key={m} value={m}>{m}</SelectItem>
                 ))}
                 {validMonths.length === 0 && (
                   <SelectItem value="none" disabled>No valid months</SelectItem>
                 )}
               </SelectContent>
             </Select>

             <Select value={selectedMember} onValueChange={setSelectedMember} disabled={isLoadingMembers}>
               <SelectTrigger className="w-[220px]">
                 <SelectValue placeholder={isLoadingMembers ? "Loading..." : "Select Member"} />
               </SelectTrigger>
               <SelectContent>
                 {availableMembers.map(m => (
                   <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
                 ))}
                 {availableMembers.length === 0 && (
                    <SelectItem value="none" disabled>No members loaded</SelectItem>
                 )}
               </SelectContent>
             </Select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 bg-muted/10">
        <div className="max-w-[1600px] mx-auto w-full space-y-6">

          {/* Missing Plan State */}
          {(!isLoadingPlans && !isLoadingMembers) && !currentPlan && (
            <Card className="border-dashed bg-card/50">
              <CardContent className="flex flex-col items-center justify-center p-12 text-center">
                <Map className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Plan Found</h3>
                <p className="text-muted-foreground text-sm max-w-md mb-6">
                  No AI Visit Plan exists for {selectedMember || 'this member'} in {selectedMonth || 'this month'} ({selectedFy}). Generate a new proposal to begin.
                </p>
                <Button onClick={handleGenerate} disabled={!selectedMember || !selectedMonth || generatePlan.isPending} className="gap-2">
                  <RefreshCw className={`h-4 w-4 ${generatePlan.isPending ? 'animate-spin' : ''}`} />
                  {generatePlan.isPending ? 'Generating...' : 'Generate Plan'}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Active Plan View */}
          {currentPlan && (
            <>
              {/* Context Banner */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-card border shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="font-semibold">{currentPlan.member}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground border-l pl-4">
                    <Calendar className="h-4 w-4" />
                    <span>{currentPlan.month}</span>
                  </div>
                  <div className="flex items-center gap-2 border-l pl-4">
                    <Badge variant={
                      currentPlan.status === 'approved' ? 'default' :
                      currentPlan.status === 'superseded' ? 'destructive' : 'secondary'
                    } className="capitalize">
                      {currentPlan.status}
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleExport} className="gap-2" disabled={currentPlan.status === 'superseded'}>
                    <FileDown className="h-4 w-4" />
                    Export
                  </Button>
                  {currentPlan.status === 'proposed' && (
                    <>
                      <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={regeneratePlan.isPending} className="gap-2">
                        <RefreshCw className={`h-4 w-4 ${regeneratePlan.isPending ? 'animate-spin' : ''}`} />
                        Regenerate
                      </Button>
                      <Button size="sm" onClick={handleApprove} disabled={approvePlan.isPending} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
                        <Check className="h-4 w-4" />
                        Approve
                      </Button>
                    </>
                  )}
                  {currentPlan.status === 'approved' && (
                    <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={regeneratePlan.isPending} className="gap-2 text-amber-600 border-amber-200 hover:bg-amber-50">
                      <History className="h-4 w-4" />
                      Supersede & Regenerate
                    </Button>
                  )}
                </div>
              </div>

              {/* Defaulted Input Warning */}
              {(!selectedMember || !selectedFy || !selectedMonth) && (
                 <Alert className="bg-amber-50/50 border-amber-200 text-amber-900 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-200">
                   <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-500" />
                   <AlertTitle>Defaulted Inputs</AlertTitle>
                   <AlertDescription>
                     Some filters were not provided. Defaulting to available options. Note that AI plans are highly sensitive to exact periods.
                   </AlertDescription>
                 </Alert>
              )}

              <Tabs defaultValue="this-month" className="w-full">
                <TabsList className="grid w-full grid-cols-5 mb-6 h-auto p-1 bg-muted/50 rounded-lg">
                  <TabsTrigger value="this-month" className="py-2.5 data-[state=active]:shadow-sm uppercase text-[11px] tracking-wider font-semibold">THIS MONTH</TabsTrigger>
                  <TabsTrigger value="pace" className="py-2.5 data-[state=active]:shadow-sm uppercase text-[11px] tracking-wider font-semibold">PACE</TabsTrigger>
                  <TabsTrigger value="coverage-gap" className="py-2.5 data-[state=active]:shadow-sm uppercase text-[11px] tracking-wider font-semibold">COVERAGE GAP</TabsTrigger>
                  <TabsTrigger value="plan-vs-actual" className="py-2.5 data-[state=active]:shadow-sm uppercase text-[11px] tracking-wider font-semibold">PLAN VS ACTUAL</TabsTrigger>
                  <TabsTrigger value="ai-travel-plan" className="py-2.5 data-[state=active]:shadow-sm uppercase text-[11px] tracking-wider font-semibold">AI VISIT PLAN</TabsTrigger>
                </TabsList>

                {/* Tab 1: THIS MONTH */}
                <TabsContent value="this-month" className="space-y-6 animate-in fade-in-50 duration-500">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <Card className="lg:col-span-2">
                      <CardHeader>
                        <div className="flex justify-between items-start">
                          <div>
                            <CardTitle className="text-base flex items-center gap-2">
                              <Map className="h-4 w-4 text-primary" />
                              Target List
                            </CardTitle>
                            <CardDescription>Source-explicit priority targets proposed by the AI model for this month.</CardDescription>
                          </div>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            Snapshot: {currentPlan.sourceSnapshotHash.substring(0,8)}...
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {currentPlan.targets && currentPlan.targets.length > 0 ? (
                          <div className="rounded-md border overflow-x-auto">
                            <Table>
                              <TableHeader className="bg-muted/50">
                                <TableRow>
                                  <TableHead className="text-xs">Retailer</TableHead>
                                  <TableHead className="text-xs">Type</TableHead>
                                  <TableHead className="text-xs text-right">Score</TableHead>
                                  <TableHead className="text-xs text-right">Plan (₹)</TableHead>
                                  <TableHead className="text-xs text-right">Distance</TableHead>
                                  <TableHead className="text-xs">Status</TableHead>
                                  <TableHead className="text-xs">Defaults</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {currentPlan.targets.map((t: any) => (
                                  <TableRow key={t.id}>
                                    <TableCell className="font-medium">
                                      {t.retailerName}
                                      {t.district && <span className="block text-[10px] text-muted-foreground font-normal">{t.district}</span>}
                                    </TableCell>
                                    <TableCell>
                                      <Badge variant="outline" className="text-[10px] capitalize">{t.priorityType}</Badge>
                                    </TableCell>
                                    <TableCell className="text-right font-mono text-xs">{formatValue(t.priorityScore)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs">{formatValue(t.businessPlan)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs">{t.distanceKm ? `${t.distanceKm} km` : '—'}</TableCell>
                                    <TableCell>
                                      <Badge variant="secondary" className="text-[10px] capitalize">{t.status}</Badge>
                                    </TableCell>
                                    <TableCell>
                                      {t.defaultedInputs && Array.isArray(t.defaultedInputs) && t.defaultedInputs.length > 0 ? (
                                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px]">
                                          {t.defaultedInputs.join(', ')}
                                        </Badge>
                                      ) : (
                                        <span className="text-muted-foreground opacity-50 text-xs">—</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : (
                          <div className="p-8 text-center text-muted-foreground text-sm border rounded-md bg-muted/20">No targets in this plan.</div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="lg:col-span-1">
                      <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                          <History className="h-4 w-4 text-primary" />
                          Revision Provenance
                        </CardTitle>
                        <CardDescription>Audit history for this period.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-md border border-border/50 space-y-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Snapshot Hash</span>
                            <span className="font-mono text-xs break-all">{currentPlan.sourceSnapshotHash}</span>
                            <span className="text-[10px] text-muted-foreground mt-1">This hash irreversibly binds the AI decisions to the exact state of the database at generation time.</span>
                          </div>
                        </div>

                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-6 mb-3">All Revisions</h4>
                        <div className="space-y-3">
                          {historyPlans.map((hp) => (
                            <div key={hp.id} className={`p-3 rounded-md border ${hp.id === currentPlan.id ? 'border-primary bg-primary/5' : 'bg-card'}`}>
                               <div className="flex justify-between items-center mb-1">
                                 <span className="font-mono text-xs font-semibold">#{hp.id}</span>
                                 <Badge variant={hp.status === 'approved' ? 'default' : hp.status === 'superseded' ? 'destructive' : 'secondary'} className="text-[9px] h-4">
                                   {hp.status}
                                 </Badge>
                               </div>
                               <div className="text-[10px] text-muted-foreground">
                                 {hp.generatedAt ? format(new Date(hp.generatedAt), "PPP p") : "Unknown date"}
                               </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>

                {/* Tab 2: PACE */}
                <TabsContent value="pace" className="space-y-6 animate-in fade-in-50 duration-500">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <TrendingUp className="h-4 w-4 text-primary" />
                        Network Pace
                      </CardTitle>
                      <CardDescription>
                        Analytic assessment of visit velocity for {selectedFy}.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {isLoadingAnalytics ? (
                        <div className="h-32 flex items-center justify-center text-muted-foreground animate-pulse">Loading pace...</div>
                      ) : !analyticsFigure ? (
                        <div className="p-8 text-center text-muted-foreground border rounded-md bg-muted/20 text-sm">Pace metrics unavailable for this plan's snapshot. Generate a plan first or select another member.</div>
                      ) : (
                        <div className="space-y-8">
                          {/* Member View */}
                          <div className="space-y-4">
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground border-b pb-2">Member: {currentPlan.member}</h3>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Visits Done</div>
                                 <div className="text-2xl font-bold">{formatValue(analyticsFigure.paceVisitsDone)}</div>
                               </div>
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Pro-Rated Required</div>
                                 <div className="text-2xl font-bold">{formatValue(analyticsFigure.paceProRatedRequired)}</div>
                               </div>
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Visit Deficit</div>
                                 <div className={`text-2xl font-bold ${Number(analyticsFigure.paceDeficit) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                   {Number(analyticsFigure.paceDeficit) > 0 ? '+' : ''}{formatValue(analyticsFigure.paceDeficit)}
                                 </div>
                                 <div className="text-[10px] text-muted-foreground">Positive means behind schedule</div>
                               </div>
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Capacity Gap</div>
                                 <div className={`text-2xl font-bold ${Number(analyticsFigure.capacityGap) < 0 ? 'text-red-600' : 'text-foreground'}`}>
                                   {formatValue(analyticsFigure.capacityGap)}
                                 </div>
                                 <div className="text-[10px] text-muted-foreground">Negative means shortfall vs anchor</div>
                               </div>
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Demonstrated Rate</div>
                                 <div className="text-2xl font-bold">
                                   {analyticsFigure.demonstratedRate !== null && analyticsFigure.demonstratedRate !== undefined
                                     ? Number(analyticsFigure.demonstratedRate).toFixed(2)
                                     : "—"}
                                   <span className="text-sm font-normal text-muted-foreground"> / day</span>
                                 </div>
                                 <div className="text-[10px] text-muted-foreground">Numerator: {formatValue(analyticsFigure.demonstratedRateNumerator)} visits</div>
                               </div>
                               <div className="space-y-1">
                                 <div className="text-xs text-muted-foreground uppercase font-semibold">Denominator Source</div>
                                 <div className="text-sm font-medium">{String(analyticsFigure.demonstratedRateDenominatorAuthority || "N/A")}</div>
                                 <div className="text-[10px] text-muted-foreground">Value: {String(analyticsFigure.demonstratedRateDenominator ?? "N/A")}</div>
                               </div>
                            </div>
                          </div>

                          {/* State Head View */}
                          {stateHeadFigure && (
                            <div className="space-y-4">
                              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground border-b pb-2">State Head: {stateHeadFigure.stateHead} (Aggregate)</h3>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Visits Done</div>
                                   <div className="text-xl font-semibold">{formatValue(stateHeadFigure.paceVisitsDone)}</div>
                                 </div>
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Pro-Rated Required</div>
                                   <div className="text-xl font-semibold">{formatValue(stateHeadFigure.paceProRatedRequired)}</div>
                                 </div>
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Visit Deficit</div>
                                   <div className={`text-xl font-semibold ${Number(stateHeadFigure.paceDeficit) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                     {Number(stateHeadFigure.paceDeficit) > 0 ? '+' : ''}{formatValue(stateHeadFigure.paceDeficit)}
                                   </div>
                                 </div>
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Capacity Gap</div>
                                   <div className={`text-xl font-semibold ${Number(stateHeadFigure.capacityGap) < 0 ? 'text-red-600' : 'text-foreground'}`}>
                                     {formatValue(stateHeadFigure.capacityGap)}
                                   </div>
                                 </div>
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Demonstrated Rate</div>
                                   <div className="text-xl font-semibold">
                                     {stateHeadFigure.demonstratedRate !== null && stateHeadFigure.demonstratedRate !== undefined
                                       ? Number(stateHeadFigure.demonstratedRate).toFixed(2)
                                       : "—"}
                                     <span className="text-sm font-normal text-muted-foreground"> / day</span>
                                   </div>
                                   <div className="text-[10px] text-muted-foreground">Numerator: {formatValue(stateHeadFigure.demonstratedRateNumerator)} visits</div>
                                 </div>
                                 <div className="space-y-1">
                                   <div className="text-xs text-muted-foreground uppercase font-semibold">Denominator Source</div>
                                   <div className="text-sm font-medium">{String(stateHeadFigure.demonstratedRateAuthority || "N/A")}</div>
                                   <div className="text-[10px] text-muted-foreground">Value: {String(stateHeadFigure.demonstratedRateDenominator ?? "N/A")}</div>
                                 </div>
                              </div>
                              {stateHeadFigure.authorityMix && stateHeadFigure.authorityMix.length > 0 && (
                                <div className="mt-2 text-xs text-muted-foreground bg-muted/20 p-2 rounded-md border">
                                  <strong>Authority Mix:</strong> {stateHeadFigure.authorityMix.join(', ')}
                                </div>
                              )}
                              {stateHeadFigure.sourceSnapshotDisclosure && (
                                <div className="mt-2 text-xs text-muted-foreground bg-muted/20 p-2 rounded-md border">
                                  <strong>Source Snapshot:</strong> {stateHeadFigure.sourceSnapshotDisclosure.mixed ? "Mixed" : "Uniform"}
                                  <div className="mt-1">
                                    Cutoffs: {stateHeadFigure.sourceSnapshotDisclosure.cutoffDates.join(', ')}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Tab 3: COVERAGE GAP */}
                <TabsContent value="coverage-gap" className="space-y-6 animate-in fade-in-50 duration-500">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Map className="h-4 w-4 text-primary" />
                          Never-Visited Ranking
                        </CardTitle>
                        <CardDescription>
                          Retailers in {selectedFy} working sheet with zero recorded visits.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {isLoadingAnalytics ? (
                          <div className="h-32 flex items-center justify-center text-muted-foreground animate-pulse">Loading ranking...</div>
                        ) : !analyticsFigure ? (
                          <div className="p-8 text-center text-muted-foreground border rounded-md bg-muted/20 text-sm">Pace metrics unavailable for this plan's snapshot. Generate a plan first or select another member.</div>
                        ) : neverVisited.length > 0 ? (
                          <div className="rounded-md border overflow-y-auto max-h-[400px]">
                            <Table>
                              <TableHeader className="bg-muted/50 sticky top-0">
                                <TableRow>
                                  <TableHead className="text-xs">Retailer</TableHead>
                                  <TableHead className="text-xs text-right">Score</TableHead>
                                  <TableHead className="text-xs text-right">Plan (₹)</TableHead>
                                  <TableHead className="text-xs text-right">Dist (km)</TableHead>
                                  <TableHead className="text-xs">Defaulted</TableHead>
                                  <TableHead className="text-xs">Reasons</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {neverVisited.map((r: any, i: number) => (
                                  <TableRow key={i}>
                                    <TableCell className="font-medium py-2">
                                      {r.retailer}
                                      {r.district && <span className="block text-[10px] text-muted-foreground font-normal">{r.district}</span>}
                                    </TableCell>
                                    <TableCell className="text-right font-mono text-xs py-2">{formatValue(r.priorityScore)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs py-2">{formatValue(r.businessPlan)}</TableCell>
                                    <TableCell className="text-right font-mono text-xs py-2">{formatValue(r.distanceKm)}</TableCell>
                                    <TableCell className="py-2">
                                      {r.defaultedInputs && Array.isArray(r.defaultedInputs) && r.defaultedInputs.length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                          {r.defaultedInputs.map((d: string, j: number) => (
                                            <Badge key={j} variant="outline" className="text-[9px] bg-amber-50 text-amber-700 border-amber-200">{d}</Badge>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-muted-foreground opacity-50 text-[10px]">—</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="py-2 max-w-[200px] truncate text-[10px] text-muted-foreground">
                                      {r.inputReasons && Object.keys(r.inputReasons).length > 0 ? (
                                        Object.entries(r.inputReasons).map(([k, v]) => `${k}: ${v}`).join('; ')
                                      ) : (
                                        <span className="opacity-50">—</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : (
                          <div className="p-8 text-center text-muted-foreground text-sm border rounded-md bg-muted/20">No never-visited retailers found.</div>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <div className="flex justify-between items-start">
                           <div>
                             <CardTitle className="flex items-center gap-2 text-base">
                               <User className="h-4 w-4 text-primary" />
                               Dormant / Win-Back
                             </CardTitle>
                             <CardDescription>
                               Customers active in prior FYs but missing from {selectedFy} sheet.
                             </CardDescription>
                           </div>
                           <Badge variant="outline">{dormantList.length} Dormant</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {isLoadingAnalytics ? (
                          <div className="h-32 flex items-center justify-center text-muted-foreground animate-pulse">Loading list...</div>
                        ) : !analyticsFigure ? (
                          <div className="p-8 text-center text-muted-foreground border rounded-md bg-muted/20 text-sm">Pace metrics unavailable for this plan's snapshot. Generate a plan first or select another member.</div>
                        ) : dormantList.length > 0 ? (
                          <div className="rounded-md border overflow-y-auto max-h-[400px]">
                            <Table>
                              <TableHeader className="bg-muted/50 sticky top-0">
                                <TableRow>
                                  <TableHead className="text-xs">Customer</TableHead>
                                  <TableHead className="text-xs">District</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {dormantList.map((d: any, i: number) => (
                                  <TableRow key={i}>
                                    <TableCell className="font-medium text-xs py-2">{d.retailer}</TableCell>
                                    <TableCell className="text-xs py-2">{d.district || '—'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : (
                          <div className="p-8 text-center text-muted-foreground text-sm border rounded-md bg-muted/20">No dormant customers identified.</div>
                        )}

                        {(currentPlan as any)?.excludedCount !== undefined && (currentPlan as any).excludedCount > 0 && (
                          <div className="mt-4 p-4 border rounded-md bg-muted/30">
                            <div className="text-sm font-semibold mb-1">Plan Exclusions</div>
                            <div className="text-xs text-muted-foreground mb-2">{(currentPlan as any).excludedCount} retailers were excluded from the current AI plan.</div>
                            {(currentPlan as any).excludedReason && (
                              <div className="text-xs italic border-l-2 pl-2 border-primary/30">"{(currentPlan as any).excludedReason}"</div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>

                {/* Tab 4: PLAN VS ACTUAL */}
                <TabsContent value="plan-vs-actual" className="space-y-6 animate-in fade-in-50 duration-500">
                  <Card>
                    <CardHeader>
                       <div className="flex justify-between items-start">
                         <div>
                           <CardTitle className="text-base flex items-center gap-2">
                             <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                             Inferred Actuals
                           </CardTitle>
                           <CardDescription>Honest, inference-based reconciliation of planned targets against real activity (orders/claims).</CardDescription>
                         </div>
                         <Button variant="outline" size="sm" onClick={handleReconcile} disabled={reconcilePlan.isPending} className="gap-2">
                           <RefreshCw className={`h-4 w-4 ${reconcilePlan.isPending ? 'animate-spin' : ''}`} />
                           Run Reconciliation
                         </Button>
                       </div>
                    </CardHeader>
                    <CardContent>
                      {isLoadingVsActual ? (
                        <div className="h-32 flex items-center justify-center text-muted-foreground animate-pulse">Loading actuals...</div>
                      ) : !vsActualData || !vsActualData.rows || vsActualData.rows.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground text-sm border rounded-md bg-muted/20">No actuals data available for this plan.</div>
                      ) : (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2 mb-2">
                            <Badge variant="secondary" className="font-mono text-[10px]">Denominator Source: {vsActualData.source}</Badge>
                          </div>
                          <div className="rounded-md border overflow-x-auto">
                            <Table>
                              <TableHeader className="bg-muted/50">
                                <TableRow>
                                  <TableHead className="text-xs">Priority Type</TableHead>
                                  <TableHead className="text-xs text-right">Planned</TableHead>
                                  <TableHead className="text-xs text-right">Visited</TableHead>
                                  <TableHead className="text-xs text-right">Pending</TableHead>
                                  <TableHead className="text-xs text-right">Not Visited (Closed)</TableHead>
                                  <TableHead className="text-xs text-right">Visited w/ Order</TableHead>
                                  <TableHead className="text-xs text-right">Post-Visit Order (₹)</TableHead>
                                  <TableHead className="text-xs text-right">Order Delta (₹)</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {vsActualData.rows.map((r: any, i: number) => {
                                  const pending = Number(r.planned || 0) - Number(r.visited || 0) - Number(r.not_visited || 0);
                                  return (
                                    <TableRow key={i}>
                                      <TableCell className="font-medium text-xs capitalize">{r.priority_type}</TableCell>
                                      <TableCell className="text-right text-xs font-mono">{formatValue(r.planned)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono text-emerald-600">{formatValue(r.visited)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono">{formatValue(pending)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono">{formatValue(r.not_visited)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono">{formatValue(r.visited_with_order)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono font-semibold">{formatValue(r.order_value_after)}</TableCell>
                                      <TableCell className="text-right text-xs font-mono">{formatValue(r.order_value_delta)}</TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </div>
                          {vsActualData.orderValueDelta !== undefined && (
                            <div className="flex justify-end p-2 bg-muted/20 border rounded-md">
                              <div className="flex items-center gap-2">
                                <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Total Order Value Delta</span>
                                <span className={`text-sm font-bold font-mono ${Number(vsActualData.orderValueDelta) > 0 ? 'text-emerald-600' : ''}`}>
                                  {Number(vsActualData.orderValueDelta) > 0 ? '+' : ''}{formatValue(vsActualData.orderValueDelta)}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Tab 5: AI VISIT PLAN */}
                <TabsContent value="ai-travel-plan" className="space-y-6 animate-in fade-in-50 duration-500">
                  <div className="space-y-6">
                    <Alert className="bg-blue-50/50 border-blue-200 text-blue-900 dark:bg-blue-950/30 dark:text-blue-200 dark:border-blue-900">
                      <Navigation className="h-4 w-4 !text-blue-600 dark:!text-blue-400" />
                      <AlertTitle>Advisory Guidance (Not a Strict Route)</AlertTitle>
                      <AlertDescription>
                        The targets presented are a prioritized <em>guidance surface</em> derived from current network gaps, scheme pacing, and historical purchasing latency. They do <strong>not</strong> constitute a mandated, strict geographical travel route.
                        <br/><br/>
                        <span className="italic opacity-80">"The model provides the 'Why' and 'Who'. You decide the 'How' and 'When'."</span>
                      </AlertDescription>
                    </Alert>

                    {isLoadingTravelPlan ? (
                      <div className="h-48 flex items-center justify-center text-muted-foreground animate-pulse bg-card border rounded-md">Generating AI Guidance...</div>
                    ) : travelPlanError ? (
                      <div className="p-8 text-center text-red-600 border border-red-200 rounded-md bg-red-50/50">
                        {travelPlanError instanceof Error ? travelPlanError.message : "Failed to load AI guidance."}
                      </div>
                    ) : !travelPlanData?.sections ? (
                      <div className="p-8 text-center text-muted-foreground border rounded-md bg-card">No guidance sections available for this plan.</div>
                    ) : (
                      <div className="grid gap-6">
                        {Object.values(travelPlanData.sections as Record<string, { title: string, body: string }>).map((sec, i) => (
                          <Card key={i} className="shadow-sm">
                            <CardHeader className="py-4 border-b bg-muted/20">
                              <CardTitle className="text-base font-semibold">{sec.title}</CardTitle>
                            </CardHeader>
                            <CardContent className="text-sm leading-relaxed whitespace-pre-wrap p-6 pt-5 text-foreground/90 font-medium">
                              {sec.body}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

              </Tabs>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
