import React, { useState, useEffect, useRef } from "react";
import { Search, Store, User, MapPin, Network, Lock, Loader2, AlertTriangle, Info, X, Bot } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { formatCompact, formatINR } from "@/data/dataset";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", 
  "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli", "Daman and Diu", "Delhi", 
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", 
  "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", 
  "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", 
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", 
  "Uttarakhand", "West Bengal"
];

// API Types
type AiSalesPlanOptions = {
  members: { id: string; member: string; retailerCount: number }[];
  retailers: { id: string; retailer: string; member: string; state: string; distributor: string; distributorId: string }[];
  source: string;
  coverage: any;
  counts: any;
  retailer?: { truncated?: boolean }; // Fallback for truncation flag
};

type SharedComputeResponse = {
  coverage: any;
  holds: { code: string; title: string; reason: string }[];
  computations: {
    customerSku?: {
      availability: string;
      reason?: string;
      value: {
        code: string;
        fy2025_26?: { qty: number; value: number; months: number };
        fy2026_27?: { qty: number; value: number; months: number };
        qtyChange?: number;
        valueChange?: number;
        likeMonths?: { prior: number; current: number };
        flagBasis?: string;
        flag: "STOPPED" | "DOWN30" | "UP30" | null;
      }[];
      history: { 
        eligible?: boolean;
        isLimited?: boolean;
        priorSkuCount?: number;
        priorMonthCount?: number;
        eligibleRetailers?: number; 
        limitedHistoryRetailers?: number; 
        minimum?: any;
        availabilityPeriods?: any;
      };
      basis: any;
    };
    peerSet?: {
      availability: string;
      reason?: string;
      rawSize: number;
      refinedSize: number;
      basis: string;
      refinement: string;
      basisMetadata: any;
    };
    penetration?: {
      availability: string;
      reason?: string;
      value: {
        code: string;
        buyingRetailers: number;
        eligibleRetailers: number;
        penetrationPct: number;
        medianQty: number;
        medianValue: number;
      }[];
    };
    top80?: {
      availability: string;
      reason?: string;
      value: {
        snapshotId: string;
        frozenAt: string;
        sourceDate: string;
        source: string;
        period: any;
        rankingUniverse?: string;
        basis?: string;
        codeCount: number;
        rows: {
          code: string;
          stateAmount: number;
          stateQty: number;
          indiaAmount: number;
          indiaQty: number;
          stateRank: number;
          indiaRank: number;
          divergence: "strong-nationally-weak-here" | "strong-here-weak-nationally" | null;
        }[];
      };
    };
  };
};

function renderStructuredData(data: any): string {
  if (!data) return "N/A";
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(" | ");
  }
  return String(data);
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function useAiSalesPlanOptions(fy: string, q: string, memberId: string) {
  return useQuery({
    queryKey: ["ai-sales-plan-options", fy, q, memberId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ fy });
      if (q) params.set("q", q);
      if (memberId && memberId !== "all") params.set("member", memberId);
      const res = await fetch(`${BASE}/api/ai-sales-plan/options?${params}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error(await res.text() || "Failed to fetch options");
      return res.json() as Promise<AiSalesPlanOptions>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useAiSalesPlanSharedCompute(retailerId: string | null, state: string, fy: string) {
  return useQuery({
    queryKey: ["ai-sales-plan-compute", retailerId, state, fy],
    queryFn: async ({ signal }) => {
      if (!retailerId && (!state || state === "none")) return null;
      
      const params = new URLSearchParams({
        fy,
        computations: retailerId ? "customerSku,peerSet,penetration,top80" : "top80",
      });
      if (retailerId) {
        params.set("retailer", retailerId);
        params.set("peerBasis", "same-distributor");
      }
      if (state && state !== "none") params.set("state", state);
      
      const res = await fetch(`${BASE}/api/ai-sales-plan/shared-compute?${params}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error(await res.text() || "Failed to fetch computations");
      return res.json() as Promise<SharedComputeResponse>;
    },
    enabled: !!retailerId || (!!state && state !== "none"),
  });
}

const renderCompact = (val: any) => {
  if (val === null || val === undefined) return "—";
  if (val === 0) return "0";
  return formatCompact(val);
};

const renderINR = (val: any) => {
  if (val === null || val === undefined) return "—";
  if (val === 0) return "₹0";
  return formatINR(val);
};

const renderChange = (val: any, formatter: (v: number) => string) => {
  if (val === null || val === undefined) return "—";
  if (val === 0) return "0";
  return (val > 0 ? '+' : '') + formatter(val);
};

function WhatTheyBuyTab({ computeData, fy }: { computeData: SharedComputeResponse, fy: string }) {
  const customerSku = computeData.computations.customerSku;
  
  if (!customerSku || customerSku.availability === 'unavailable') {
    return <Alert><AlertTriangle className="h-4 w-4" /><AlertTitle>Unavailable</AlertTitle><AlertDescription>{customerSku?.reason || "Data not available"}</AlertDescription></Alert>;
  }

  const values = customerSku.value || [];
  const isLimitedHistory = customerSku.history?.isLimited === true;

  const top80Rows = computeData.computations.top80?.value?.rows || [];
  const top80Codes = new Set(top80Rows.map((r: any) => r.code));
  const penetrationRows = computeData.computations.penetration?.value || [];
  const penetrationByCode = new Map(penetrationRows.map((r: any) => [r.code, r]));
  const top80Purchased = values.filter((sku: any) => top80Codes.has(sku.code));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle>Historical Purchases</CardTitle>
              <CardDescription>
                 Population: {customerSku.history?.eligibleRetailers || 0} Eligible | {customerSku.history?.limitedHistoryRetailers || 0} Limited
                 {customerSku.history?.minimum && ` | Threshold: ${renderStructuredData(customerSku.history.minimum)}`}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-[10px] text-muted-foreground mb-3 font-mono uppercase tracking-wider">
            IDENTITY: secondary_order_line.dealer_id / valid cp_code | SKU HISTORY: secondary_sku_line.qty / net_amount | PERIOD: FY25-26 full year + FY26-27 loaded SKU months | COVERAGE: {renderStructuredData(computeData.coverage)} | BASIS: {computeData.computations.peerSet?.basis || 'N/A'}
          </div>

          <div className="bg-muted/40 border rounded-md p-3 mb-4 text-xs text-muted-foreground">
            <strong>Note on Changes & Trends:</strong> Displayed Qty/Value Changes reflect full FY25-26 versus FY26-27 YTD. 
            Trend badges (UP/DOWN/STOPPED) are calculated using like available months based on the <code>flagBasis</code>.
          </div>

          {isLimitedHistory && (
             <Alert className="mb-4 bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-200">
               <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-500" />
               <AlertTitle>Limited History</AlertTitle>
               <AlertDescription>
                 This retailer has limited history according to the eligibility criteria. Growth and decline flags are suppressed to avoid misleading inferences.
               </AlertDescription>
             </Alert>
          )}

          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">SKU Code</TableHead>
                  <TableHead className="text-xs text-right">FY25-26 Qty</TableHead>
                  <TableHead className="text-xs text-right">FY25-26 Value</TableHead>
                  <TableHead className="text-xs text-right border-l">FY26-27 YTD Qty</TableHead>
                  <TableHead className="text-xs text-right">FY26-27 YTD Value</TableHead>
                  <TableHead className="text-xs text-right border-l">Qty Change</TableHead>
                  <TableHead className="text-xs text-right">Value Change</TableHead>
                  {!isLimitedHistory && <TableHead className="text-xs text-center border-l">Trend</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {values.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No historical purchases found.</TableCell></TableRow>
                ) : (
                  values.map((row: any) => {
                    const priorQty = row.fy2025_26?.qty;
                    const priorValue = row.fy2025_26?.value;
                    const currentQty = row.fy2026_27?.qty;
                    const currentValue = row.fy2026_27?.value;
                    const qChange = row.qtyChange;
                    const vChange = row.valueChange;

                    return (
                      <TableRow key={row.code}>
                         <TableCell className="font-medium text-xs">{row.code}</TableCell>
                         <TableCell className="text-right text-xs">{renderCompact(priorQty)}</TableCell>
                         <TableCell className="text-right text-xs">{renderINR(priorValue)}</TableCell>
                         <TableCell className="text-right text-xs border-l">{renderCompact(currentQty)}</TableCell>
                         <TableCell className="text-right text-xs font-medium">{renderINR(currentValue)}</TableCell>
                         <TableCell className="text-right text-xs border-l">{renderChange(qChange, formatCompact)}</TableCell>
                         <TableCell className="text-right text-xs">{renderChange(vChange, formatINR)}</TableCell>
                         {!isLimitedHistory && (
                           <TableCell className="text-center border-l">
                             {row.flag === 'STOPPED' && <Badge variant="destructive" className="text-[10px]">STOPPED</Badge>}
                             {row.flag === 'DOWN30' && <Badge variant="outline" className="text-[10px] text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-900">DOWN 30%+</Badge>}
                             {row.flag === 'UP30' && <Badge variant="outline" className="text-[10px] text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-400 dark:bg-emerald-950/30 dark:border-emerald-900">UP 30%+</Badge>}
                             {!row.flag && <span className="text-muted-foreground opacity-50 text-[10px]">—</span>}
                           </TableCell>
                         )}
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top 80% SKUs Penetration</CardTitle>
          <CardDescription>
            Comparing current purchases against peer median (Basis: {computeData.computations.peerSet?.basis || 'N/A'}, Size: {computeData.computations.peerSet?.refinedSize || 0} retailers).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">SKU Code</TableHead>
                  <TableHead className="text-xs text-right">Retailer Qty (Current)</TableHead>
                  <TableHead className="text-xs text-right">Peer Median Qty</TableHead>
                  <TableHead className="text-xs text-right">Penetration %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {top80Purchased.map((sku: any) => {
                  const pen = penetrationByCode.get(sku.code);
                  const currentQty = sku.fy2026_27?.qty;
                  return (
                    <TableRow key={sku.code}>
                      <TableCell className="font-medium text-xs">{sku.code}</TableCell>
                      <TableCell className="text-right text-xs">{renderCompact(currentQty)}</TableCell>
                      <TableCell className="text-right text-xs">{pen ? renderCompact(pen.medianQty) : "—"}</TableCell>
                      <TableCell className="text-right text-xs">
                        {pen ? `${Number(pen.penetrationPct).toFixed(1)}%` : "—"}
                        {pen && <div className="text-[9px] text-muted-foreground">{pen.buyingRetailers} / {pen.eligibleRetailers} retailers</div>}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {top80Purchased.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8 text-sm">No Top 80% SKUs currently purchased by this retailer.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Top80Tab({ computeData, state }: { computeData: SharedComputeResponse, state: string }) {
  const top80 = computeData.computations.top80;
  
  if (!top80 || top80.availability === 'unavailable') {
     return <Alert><AlertTriangle className="h-4 w-4" /><AlertTitle>Unavailable</AlertTitle><AlertDescription>{top80?.reason || "Data not available"}</AlertDescription></Alert>;
  }

  const rows = top80.value?.rows || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top 80% SKUs: {state || "Unknown State"} vs India</CardTitle>
        <CardDescription>
          Sorted by {state || "Unknown State"} regional demand volume.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-[10px] text-muted-foreground mb-4 font-mono uppercase tracking-wider flex flex-wrap gap-x-4 gap-y-1">
          <span>SOURCE: {top80.value?.source || 'sale_line_current'}</span>
          <span>PERIOD: {renderStructuredData(top80.value?.period)}</span>
          <span>UNIVERSE: {top80.value?.rankingUniverse || 'N/A'}</span>
          <span>BASIS: {top80.value?.basis || 'N/A'}</span>
          <span>SKUS: {top80.value?.codeCount ?? 'N/A'}</span>
          <span>SNAPSHOT: {top80.value?.snapshotId}</span>
          <span>FROZEN: {top80.value?.frozenAt ? new Date(top80.value.frozenAt).toLocaleDateString() : 'N/A'}</span>
        </div>

        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs">SKU Code</TableHead>
                <TableHead className="text-xs text-right border-l">State Qty</TableHead>
                <TableHead className="text-xs text-right">State Amt</TableHead>
                <TableHead className="text-xs text-right">State Rank</TableHead>
                <TableHead className="text-xs text-right border-l">India Qty</TableHead>
                <TableHead className="text-xs text-right">India Amt</TableHead>
                <TableHead className="text-xs text-right">India Rank</TableHead>
                <TableHead className="text-xs border-l">Divergence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No Top 80% data available.</TableCell></TableRow>
              ) : (
                rows.map((row: any) => (
                  <TableRow key={row.code}>
                    <TableCell className="font-medium text-xs">{row.code}</TableCell>
                    
                    <TableCell className="text-right text-xs border-l">{renderCompact(row.stateQty)}</TableCell>
                    <TableCell className="text-right text-xs">{renderINR(row.stateAmount)}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">#{row.stateRank}</TableCell>
                    
                    <TableCell className="text-right text-xs border-l">{renderCompact(row.indiaQty)}</TableCell>
                    <TableCell className="text-right text-xs">{renderINR(row.indiaAmount)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">#{row.indiaRank}</TableCell>
                    
                    <TableCell className="border-l text-xs">
                      {row.divergence === 'strong-here-weak-nationally' && (
                        <Badge variant="outline" className="text-[10px] text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-950/30 dark:border-blue-900">Local Favorite</Badge>
                      )}
                      {row.divergence === 'strong-nationally-weak-here' && (
                        <Badge variant="outline" className="text-[10px] text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-900">Local Gap</Badge>
                      )}
                      {!row.divergence && <span className="text-muted-foreground opacity-50">—</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AiSalesPlanPage() {
  const fy = "2026-27";
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [selectedMemberId, setSelectedMemberId] = useState<string>("all");
  const [selectedState, setSelectedState] = useState<string>("none");
  const [selectedRetailer, setSelectedRetailer] = useState<any>(null);

  useEffect(() => {
    if (selectedRetailer) {
      setSearchTerm("");
    }
  }, [selectedRetailer]);

  // Sync state selector with selected retailer
  useEffect(() => {
    if (selectedRetailer && selectedRetailer.state && selectedRetailer.state !== selectedState) {
      setSelectedState(selectedRetailer.state);
    }
  }, [selectedRetailer]);

  const { data: options, isLoading: isOptionsLoading } = useAiSalesPlanOptions(fy, debouncedSearch, selectedMemberId);
  
  const effectiveState = selectedRetailer ? selectedRetailer.state : (selectedState === "none" ? "" : selectedState);

  const { data: computeData, isLoading: isComputeLoading, error: computeError } = useAiSalesPlanSharedCompute(
    selectedRetailer?.id || null,
    effectiveState,
    fy
  );

  const [activeTab, setActiveTab] = useState<string>("what-they-buy");

  useEffect(() => {
    if (selectedRetailer) {
      setActiveTab("what-they-buy");
    } else if (effectiveState) {
      setActiveTab("top-80");
    }
  }, [selectedRetailer, effectiveState]);

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSearchFocus = () => {
    if (debouncedSearch) setIsDropdownOpen(true);
  };
  
  useEffect(() => {
    if (debouncedSearch && options?.retailers && options.retailers.length > 0) {
      setIsDropdownOpen(true);
    } else {
      setIsDropdownOpen(false);
    }
  }, [debouncedSearch, options]);

  const uniqueMembers = React.useMemo(() => {
    if (!options?.members) return [];
    return options.members;
  }, [options]);

  const isSearchTruncated = 
    options?.retailer?.truncated || 
    options?.counts?.retailer?.truncated || 
    options?.counts?.retailers?.truncated || 
    (options as any)?.truncated;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <div className="flex-none px-6 py-6 border-b bg-card">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 max-w-[1600px] mx-auto w-full">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Bot className="h-6 w-6 text-primary" />
              AI Sales Plan
            </h1>
            <div className="text-sm text-muted-foreground mt-1">
              Historical purchase intelligence and contextual peer planning
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="h-9 px-3 bg-muted/50 rounded-md text-sm font-normal">FY {fy}</Badge>
            
            <Select value={selectedMemberId} onValueChange={(val) => {
              setSelectedMemberId(val);
              setSelectedRetailer(null);
            }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Members</SelectItem>
                {uniqueMembers.map((m: any) => (
                  <SelectItem key={m.id} value={m.id}>{m.member}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedState} onValueChange={(val) => {
              setSelectedState(val);
              if (selectedRetailer && selectedRetailer.state !== val && val !== "none") {
                setSelectedRetailer(null);
              }
            }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All States" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">All States</SelectItem>
                {INDIAN_STATES.map((state) => (
                  <SelectItem key={state} value={state}>{state}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative" ref={dropdownRef}>
              {selectedRetailer ? (
                <div className="flex items-center gap-2 border rounded-md px-3 h-9 bg-muted/50 w-[300px]">
                   <Store className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                   <span className="text-sm font-medium truncate flex-1">{selectedRetailer.retailer}</span>
                   <button onClick={() => setSelectedRetailer(null)}><X className="h-4 w-4 text-muted-foreground hover:text-foreground"/></button>
                </div>
              ) : (
                <>
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    placeholder="Search retailer..." 
                    value={searchTerm} 
                    onChange={e => setSearchTerm(e.target.value)}
                    onFocus={handleSearchFocus}
                    className="pl-9 w-[300px] h-9"
                  />
                  {isOptionsLoading && debouncedSearch !== "" && (
                    <Loader2 className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground animate-spin" />
                  )}
                  {isDropdownOpen && options && options.retailers && (
                    <div className="absolute top-full left-0 w-full mt-1 bg-popover border rounded-md shadow-md z-50 max-h-[300px] overflow-y-auto flex flex-col">
                      <div className="flex-1 overflow-y-auto">
                        {options.retailers.length === 0 ? (
                          <div className="p-3 text-sm text-muted-foreground text-center">No retailers found</div>
                        ) : (
                          options.retailers.map((r: any) => (
                            <div 
                              key={r.id} 
                              onClick={() => {
                                setSelectedRetailer(r);
                                setIsDropdownOpen(false);
                              }} 
                              className="px-3 py-2 hover:bg-muted cursor-pointer text-sm border-b last:border-0"
                            >
                              <div className="font-semibold text-foreground">{r.retailer} <span className="text-muted-foreground font-normal text-xs">({r.id})</span></div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">{r.distributor} &bull; {r.state} &bull; {r.member}</div>
                            </div>
                          ))
                        )}
                      </div>
                      {isSearchTruncated && (
                        <div className="px-3 py-2 text-xs font-medium text-amber-700 bg-amber-50 border-t border-amber-200 text-center sticky bottom-0">
                          Results truncated. Refine search.
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main content scroll area */}
      <div className="flex-1 overflow-y-auto p-6 bg-muted/10">
        <div className="max-w-[1600px] mx-auto w-full space-y-6">
           {!selectedRetailer && !effectiveState ? (
              <Card className="border-dashed bg-card/50">
                <CardContent className="flex flex-col items-center justify-center p-12 text-center">
                  <Bot className="h-12 w-12 text-muted-foreground/50 mb-4" />
                  <h3 className="text-lg font-semibold mb-2">Select a Retailer or State</h3>
                  <p className="text-muted-foreground text-sm max-w-md">
                    Search and select a retailer to view historical purchase patterns and peer context. 
                    Or select a State to view regional Top 80% performance.
                  </p>
                </CardContent>
              </Card>
           ) : isComputeLoading ? (
              <div className="flex items-center justify-center p-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
           ) : computeError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Failed to load data</AlertTitle>
                <AlertDescription>{computeError.message}</AlertDescription>
              </Alert>
           ) : computeData ? (
              <>
                {/* Context Header */}
                {selectedRetailer && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-card border shadow-sm">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Store className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{selectedRetailer.retailer}</span>
                        <Badge variant="outline" className="font-mono text-xs">{selectedRetailer.id}</Badge>
                      </div>
                      <div className="flex items-center gap-2 border-l pl-4 text-sm text-muted-foreground">
                        <User className="h-4 w-4" />
                        {selectedRetailer.member}
                      </div>
                      <div className="flex items-center gap-2 border-l pl-4 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        {selectedRetailer.state}
                      </div>
                      <div className="flex items-center gap-2 border-l pl-4 text-sm text-muted-foreground">
                        <Network className="h-4 w-4" />
                        {selectedRetailer.distributor}
                      </div>
                    </div>
                  </div>
                )}

                {computeData.holds && computeData.holds.length > 0 && (
                  <Alert className="bg-blue-50/50 text-blue-900 border-blue-200 dark:bg-blue-950/20 dark:text-blue-200 dark:border-blue-900">
                    <Info className="h-4 w-4 !text-blue-600 dark:!text-blue-500" />
                    <AlertTitle>Open resolution holds (global context)</AlertTitle>
                    <AlertDescription>
                      <div className="mb-3 mt-2 flex flex-col gap-2">
                        {computeData.holds.map((h: any, i: number) => (
                           <div key={i} className="flex items-start text-sm">
                             <Badge variant="outline" className="mr-2 bg-white/50 whitespace-nowrap">{h.code || "HOLD"}</Badge>
                             <div className="flex flex-col">
                                <span className="font-medium text-blue-950 dark:text-blue-100">{h.title || "Unknown Hold"}</span>
                                <span className="text-blue-800/80 dark:text-blue-200/80 text-[11px] mt-0.5">{h.reason || "No reason provided"}</span>
                             </div>
                           </div>
                        ))}
                      </div>
                      <div className="text-[11px] font-medium opacity-90 border-t border-blue-200/50 dark:border-blue-800/50 pt-2 mt-2">
                        Note: Applicability is measure/period scoped. Tabs 1/5 are qty/NET/demand and do not use margin weighting. 
                        These holds do not block the underlying analytics shown here.
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <TabsList className="flex flex-wrap lg:grid lg:grid-cols-6 mb-6 h-auto p-1 bg-muted/50 rounded-lg">
                    <TabsTrigger 
                      value="what-they-buy" 
                      disabled={!selectedRetailer}
                      className="py-2.5 data-[state=active]:shadow-sm uppercase text-[10px] tracking-wider font-semibold"
                    >
                      1. What They Buy
                      {!selectedRetailer && <Lock className="h-3 w-3 ml-1 inline opacity-50" />}
                    </TabsTrigger>
                    <TabsTrigger value="buy-more" disabled className="py-2.5 uppercase text-[10px] tracking-wider font-semibold opacity-50 flex items-center justify-center gap-1">2. Buy more of the Top 80% <Lock className="h-3 w-3" /></TabsTrigger>
                    <TabsTrigger value="sku-peers" disabled className="py-2.5 uppercase text-[10px] tracking-wider font-semibold opacity-50 flex items-center justify-center gap-1">3. SKU peers <Lock className="h-3 w-3" /></TabsTrigger>
                    <TabsTrigger value="new-sku" disabled className="py-2.5 uppercase text-[10px] tracking-wider font-semibold opacity-50 flex items-center justify-center gap-1">4. New SKU <Lock className="h-3 w-3" /></TabsTrigger>
                    <TabsTrigger 
                      value="top-80" 
                      className="py-2.5 data-[state=active]:shadow-sm uppercase text-[10px] tracking-wider font-semibold"
                    >
                      5. Top 80%, state versus India
                    </TabsTrigger>
                    <TabsTrigger value="rest-national" disabled className="py-2.5 uppercase text-[10px] tracking-wider font-semibold opacity-50 flex items-center justify-center gap-1">6. Rest by national performance <Lock className="h-3 w-3" /></TabsTrigger>
                  </TabsList>

                  <TabsContent value="what-they-buy" className="space-y-6 animate-in fade-in-50 duration-500">
                    {selectedRetailer && <WhatTheyBuyTab computeData={computeData} fy={fy} />}
                  </TabsContent>

                  <TabsContent value="top-80" className="space-y-6 animate-in fade-in-50 duration-500">
                    <Top80Tab computeData={computeData} state={effectiveState} />
                  </TabsContent>
                </Tabs>
              </>
           ) : null}
        </div>
      </div>
    </div>
  );
}
