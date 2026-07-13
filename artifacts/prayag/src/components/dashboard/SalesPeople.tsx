import { useMemo, useState } from "react";
import { SalesReports } from "@/components/dashboard/SalesReports";
import {
  useGetSalesPeopleTree,
  useGetSalesPersonDeepDive,
  useVerifySalesPeople,
  useAnalyzeSalesPerson,
  getGetSalesPersonDeepDiveQueryKey,
  getVerifySalesPeopleQueryKey,
  type RepNode,
  type DeepRow,
  type SalesVerifyHead,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Users,
  ChevronRight,
  ChevronDown,
  Loader2,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  Sparkles,
  BarChart2,
} from "lucide-react";

const FY_OPTIONS = ["2026-27", "2025-26", "2024-25"];

function formatCr(rupees: number): string {
  return `${(rupees / 1e7).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} Cr`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-IN");
}

function GrowthBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-xs text-muted-foreground">new</span>;
  }
  const up = pct >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        up ? "text-green-600 dark:text-green-400" : "text-destructive",
      )}
    >
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {up ? "+" : ""}
      {pct}%
    </span>
  );
}

function TreeRow({
  node,
  depth,
  selectedKey,
  onSelect,
}: {
  node: RepNode;
  depth: number;
  selectedKey: string | null;
  onSelect: (n: RepNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const selected = selectedKey === node.key;
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 py-2 pr-2 rounded-md cursor-pointer hover:bg-muted/60",
          selected && "bg-primary/10 ring-1 ring-primary/30",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => onSelect(node)}
      >
        {node.hasTeam ? (
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{node.name}</p>
          {node.state && <p className="text-xs text-muted-foreground truncate">{node.state}</p>}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm tabular-nums">{formatCr(node.teamNet)}</p>
          {node.hasTeam && node.ownNet > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">own {formatCr(node.ownNet)}</p>
          )}
        </div>
      </div>
      {open &&
        node.children.map((c) => (
          <TreeRow key={c.key} node={c} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} />
        ))}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg border border-border/50 bg-background/50">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
      {sub != null && <div className="text-xs mt-0.5">{sub}</div>}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  showFlag,
  limit = 10,
}: {
  title: string;
  rows: DeepRow[];
  showFlag?: boolean;
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data for this selection.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border/40">
                  <th className="text-left font-medium py-1.5 pr-2">Name</th>
                  <th className="text-right font-medium py-1.5 px-2">This FY</th>
                  <th className="text-right font-medium py-1.5 px-2">Last FY</th>
                  <th className="text-right font-medium py-1.5 px-2">Difference</th>
                  <th className="text-right font-medium py-1.5 px-2">Growth</th>
                  <th className="text-right font-medium py-1.5 pl-2">Share</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.label}-${i}`} className="border-b border-border/20 last:border-0">
                    <td className="py-1.5 pr-2">
                      <span className="truncate inline-block max-w-[180px] align-middle">{r.label}</span>
                      {showFlag && r.flag && (
                        <span
                          className={cn(
                            "ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide align-middle",
                            r.flag === "new" && "bg-green-500/15 text-green-600 dark:text-green-400",
                            r.flag === "churned" && "bg-destructive/15 text-destructive",
                            r.flag === "old" && "bg-muted text-muted-foreground",
                          )}
                        >
                          {r.flag}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums py-1.5 px-2">{formatCr(r.thisFy)}</td>
                    <td className="text-right tabular-nums py-1.5 px-2 text-muted-foreground">
                      {formatCr(r.lastFy)}
                    </td>
                    <td
                      className={cn(
                        "text-right tabular-nums py-1.5 px-2",
                        r.diff > 0 && "text-green-600 dark:text-green-400",
                        r.diff < 0 && "text-destructive",
                        r.diff === 0 && "text-muted-foreground",
                      )}
                    >
                      {r.diff > 0 ? "+" : ""}
                      {formatCr(r.diff)}
                    </td>
                    <td className="text-right py-1.5 px-2">
                      <GrowthBadge pct={r.growthPct} />
                    </td>
                    <td className="text-right tabular-nums py-1.5 pl-2 text-muted-foreground">
                      {r.sharePct == null ? "-" : `${r.sharePct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MoverList({ title, rows, up }: { title: string; rows: DeepRow[]; up: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1.5">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => (
            <li key={`${r.label}-${i}`} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{r.label}</span>
              <span
                className={cn(
                  "tabular-nums shrink-0",
                  up ? "text-green-600 dark:text-green-400" : "text-destructive",
                )}
              >
                {up ? "+" : ""}
                {formatCr(r.diff)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeadCheckChip({ status }: { status: SalesVerifyHead["status"] }) {
  const map = {
    pass: { Icon: CheckCircle2, cls: "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30", label: "Pass" },
    warn: { Icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30", label: "Warn" },
    fail: { Icon: XCircle, cls: "text-destructive bg-destructive/10 border-destructive/30", label: "Fail" },
  } as const;
  const { Icon, cls, label } = map[status];
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border shrink-0", cls)}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

export default function SalesPeople() {
  const [fy, setFy] = useState("2026-27");
  const [headKey, setHeadKey] = useState<string>("");
  const [selected, setSelected] = useState<RepNode | null>(null);
  const [scope, setScope] = useState<"own" | "team">("team");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"overview" | "reports">("overview");

  const tree = useGetSalesPeopleTree({ fy });
  const analyze = useAnalyzeSalesPerson();

  const selectedKey = selected?.key ?? null;
  const effectiveScope: "own" | "team" = selected?.hasTeam ? scope : "own";

  const deepDive = useGetSalesPersonDeepDive(
    { fy, repKey: selectedKey ?? "", scope: effectiveScope },
    {
      query: {
        enabled: !!selectedKey,
        retry: false,
        queryKey: getGetSalesPersonDeepDiveQueryKey({
          fy,
          repKey: selectedKey ?? "",
          scope: effectiveScope,
        }),
      },
    },
  );

  const verify = useVerifySalesPeople(
    { fy },
    { query: { retry: false, queryKey: getVerifySalesPeopleQueryKey({ fy }) } },
  );

  const heads = tree.data?.heads ?? [];
  const visibleHeads = headKey ? heads.filter((h) => h.key === headKey) : heads;
  const dive = deepDive.data;

  const selectNode = (n: RepNode) => {
    setSelected(n);
    setAnalysis(null);
    setScope(n.hasTeam ? "team" : "own");
    setSubTab("overview");
  };

  const runAnalysis = async (mode: "narrative" | "compare") => {
    if (!selected) return;
    setAnalysis(null);
    try {
      const res = await analyze.mutateAsync({
        data:
          mode === "narrative"
            ? { mode, fy, repKey: selected.key, scope: effectiveScope }
            : { mode, fy, head: selected.key },
      });
      setAnalysis(res.answer);
    } catch {
      setAnalysis("The analyst is temporarily unavailable. Please try again in a moment.");
    }
  };

  const overallColor = useMemo(() => {
    const o = verify.data?.overall;
    return o === "fail" ? "text-destructive" : o === "warn" ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400";
  }, [verify.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Users className="w-5 h-5" />
            Sales
          </h2>
          <p className="text-sm text-muted-foreground">
            One level below State Heads. Pick a person to see their book, team roll-up and year-on-year movements. Net secondary order booking.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Fiscal year</label>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={fy}
            onChange={(e) => {
              setFy(e.target.value);
              setHeadKey("");
              setSelected(null);
              setAnalysis(null);
            }}
          >
            {FY_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tree.data && !tree.data.multiLevel && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-muted-foreground">
            The roster is currently the flat State Head dashboard (head to rep). The full multi-level reporting chain needs the HR roster to be shared. Tree shows two levels for now.
          </p>
        </div>
      )}
      {tree.data?.loadDetail && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-border/50 bg-muted/40 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">{tree.data.loadDetail}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr] gap-4">
        <Card className="lg:sticky lg:top-4 h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reporting tree</CardTitle>
            <CardDescription>Pick a State Head, then drill into their sales people</CardDescription>
          </CardHeader>
          <CardContent>
            {tree.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading tree...
              </div>
            ) : tree.isError ? (
              <p className="text-sm text-destructive">Could not load the reporting tree.</p>
            ) : heads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sales people found.</p>
            ) : (
              <>
                <div className="mb-3">
                  <label className="text-xs text-muted-foreground">State Head</label>
                  <select
                    className="mt-1 w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={headKey}
                    onChange={(e) => {
                      const key = e.target.value;
                      setHeadKey(key);
                      const head = heads.find((h) => h.key === key) ?? null;
                      if (head) selectNode(head);
                    }}
                  >
                    <option value="">All State Heads</option>
                    {heads.map((h) => (
                      <option key={h.key} value={h.key}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="max-h-[70vh] overflow-y-auto -mx-1">
                  {visibleHeads.map((h) => (
                    <TreeRow key={h.key} node={h} depth={0} selectedKey={selectedKey} onSelect={selectNode} />
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {!selected ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="text-sm">Select a sales person from the tree to see their deep dive.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">{selected.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {selected.state || "All states"} · {fy} vs {dive?.priorFy ?? "prior year"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {selected.hasTeam && (
                    <div className="inline-flex rounded-md border border-border overflow-hidden">
                      {(["own", "team"] as const).map((s) => (
                        <button
                          key={s}
                          className={cn(
                            "px-3 py-1.5 text-sm",
                            effectiveScope === s ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                          )}
                          onClick={() => setScope(s)}
                        >
                          {s === "own" ? "Own" : "Team"}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50"
                    onClick={() => runAnalysis("narrative")}
                    disabled={analyze.isPending || !dive?.available}
                  >
                    {analyze.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    Explain
                  </button>
                  {selected.hasTeam && (
                    <button
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50"
                      onClick={() => runAnalysis("compare")}
                      disabled={analyze.isPending}
                    >
                      <BarChart2 className="w-4 h-4" />
                      Rank team
                    </button>
                  )}
                </div>
              </div>

              <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
                {(["overview", "reports"] as const).map((t) => (
                  <button
                    key={t}
                    className={cn(
                      "px-4 py-1.5 capitalize",
                      subTab === t ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                    )}
                    onClick={() => setSubTab(t)}
                  >
                    {t === "overview" ? "Overview" : "Reports"}
                  </button>
                ))}
              </div>

              {subTab === "overview" ? (
                deepDive.isLoading ? (
                <Card>
                  <CardContent className="py-12 flex items-center justify-center gap-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> Computing deep dive...
                  </CardContent>
                </Card>
                ) : !dive?.available ? (
                <Card>
                  <CardContent className="py-8 text-sm text-muted-foreground">
                    {dive?.reason ?? "No data available for this selection."}
                  </CardContent>
                </Card>
                ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Tile
                      label="Net order booked"
                      value={formatCr(dive.tiles.netOrderBooked)}
                      sub={<GrowthBadge pct={dive.tiles.growthPct} />}
                    />
                    <Tile label="Orders" value={formatInt(dive.tiles.orders)} />
                    <Tile
                      label="Active retailers"
                      value={formatInt(dive.tiles.activeRetailers)}
                      sub={<span className="text-muted-foreground">{formatInt(dive.tiles.newRetailers)} new</span>}
                    />
                    <Tile
                      label="Avg order value"
                      value={dive.tiles.avgOrderValue == null ? "-" : formatCr(dive.tiles.avgOrderValue)}
                    />
                    <Tile
                      label="Business / retailer"
                      value={dive.tiles.businessPerRetailer == null ? "-" : formatCr(dive.tiles.businessPerRetailer)}
                    />
                    <Tile
                      label="Target"
                      value={dive.tiles.target == null ? "-" : formatCr(dive.tiles.target)}
                    />
                    <Tile
                      label="Achievement"
                      value={dive.tiles.achievementPct == null ? "-" : `${dive.tiles.achievementPct}%`}
                    />
                    <Tile label="Last FY net" value={formatCr(dive.tiles.netOrderBookedLast)} />
                  </div>

                  {analysis && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Sparkles className="w-4 h-4" /> Analyst
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <TrendingUp className="w-4 h-4" /> Top movers
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                      <MoverList title="Parties gaining" rows={dive.movers.partiesUp} up />
                      <MoverList title="Parties declining" rows={dive.movers.partiesDown} up={false} />
                      <MoverList title="Segments gaining" rows={dive.movers.segmentsUp} up />
                      <MoverList title="Segments declining" rows={dive.movers.segmentsDown} up={false} />
                    </CardContent>
                  </Card>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <BreakdownTable title="By State" rows={dive.byState} />
                    <BreakdownTable title="By Group" rows={dive.byGroup} />
                    <BreakdownTable title="By Segment" rows={dive.bySegment} />
                    <BreakdownTable
                      title="By Party — top (largest active)"
                      rows={dive.parties.top}
                      showFlag
                    />
                    <BreakdownTable
                      title="By Party — bottom (weakest active)"
                      rows={dive.parties.bottom}
                      showFlag
                    />
                    <BreakdownTable
                      title={`By Party — new this year (${formatInt(dive.parties.newCount)})`}
                      rows={dive.parties.newTop}
                      showFlag
                    />
                    <BreakdownTable
                      title={`By Party — churned (${formatInt(dive.parties.churnedCount)} ordered last year, none this year)`}
                      rows={dive.parties.churned}
                      showFlag
                    />
                  </div>
                </>
                )
              ) : (
                <SalesReports
                  fy={fy}
                  selectedKey={selectedKey ?? ""}
                  effectiveScope={effectiveScope}
                />
              )}
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Data health
          </CardTitle>
          <CardDescription>
            Cross-foots each head's rolled-up rep total against signed-off anchors and checks roster name coverage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {verify.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Reconciling...
            </div>
          ) : verify.isError || !verify.data?.available ? (
            <p className="text-sm text-muted-foreground">
              {verify.data?.reason ?? "Verification is unavailable right now."}
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className={cn("font-semibold uppercase tracking-wide", overallColor)}>
                  {verify.data.overall}
                </span>
                <span className="text-muted-foreground">
                  Attributed {formatCr(verify.data.attributedTotal)} of {formatCr(verify.data.companyTotal)}
                  {verify.data.coveragePct != null && ` (${verify.data.coveragePct}% coverage)`}
                </span>
                {verify.data.nameMatch.matchPct != null && (
                  <span className="text-muted-foreground">
                    Name match {verify.data.nameMatch.matchPct}% ({formatInt(verify.data.nameMatch.matchedCount)}/
                    {formatInt(verify.data.nameMatch.fileNameCount)})
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                {verify.data.heads.map((h) => (
                  <div
                    key={h.name}
                    className="flex items-center justify-between gap-3 py-2 border-b border-border/40 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{h.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatInt(h.repCount)} people · Team {formatCr(h.repSaleTotal)}
                        {h.anchor != null && ` · Anchor ${formatCr(h.anchor)}`}
                        {h.deltaPct != null && ` · Δ ${h.deltaPct > 0 ? "+" : ""}${h.deltaPct}%`}
                        {!h.withinCrossFoot && " · cross-foot mismatch"}
                      </p>
                    </div>
                    <HeadCheckChip status={h.status} />
                  </div>
                ))}
              </div>
              {(verify.data.nameMatch.unmatchedFileNames.length > 0 ||
                verify.data.nameMatch.unmatchedRosterNames.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  {verify.data.nameMatch.unmatchedFileNames.length > 0 && (
                    <div>
                      <p className="font-medium text-muted-foreground mb-1">
                        In file, not in roster ({verify.data.nameMatch.unmatchedFileNames.length})
                      </p>
                      <p className="text-muted-foreground">
                        {verify.data.nameMatch.unmatchedFileNames.join(", ")}
                      </p>
                    </div>
                  )}
                  {verify.data.nameMatch.unmatchedRosterNames.length > 0 && (
                    <div>
                      <p className="font-medium text-muted-foreground mb-1">
                        In roster, no bookings ({verify.data.nameMatch.unmatchedRosterNames.length})
                      </p>
                      <p className="text-muted-foreground">
                        {verify.data.nameMatch.unmatchedRosterNames.join(", ")}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
