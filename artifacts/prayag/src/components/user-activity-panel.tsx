import { useState } from "react";
import { Loader2, ArrowLeft, Clock, MousePointer2, Layout, Activity } from "lucide-react";
import { useActivityReport, useUsers, type ManagedUser } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function formatMs(ms: number) {
  if (!ms) return "0m";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function indiaDate(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const value = (part: string) => parts.find((item) => item.type === part)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addIndiaDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00+05:30`);
  result.setDate(result.getDate() + days);
  return indiaDate(result);
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateRangeError(from: string, to: string) {
  if (!validIsoDate(from) || !validIsoDate(to)) return "Select both dates.";
  if (from > to) return "The start date must be before the end date.";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > 31) return "Choose a span of 31 days or less.";
  return null;
}

function formatAction(action: string | null) {
  if (!action) return "Viewed page";
  return action.replace(/[._:-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ActivityFilters({
  users,
  selectedUserId,
  onUserSelect,
  rangePreset,
  onPresetChange,
  from,
  to,
  onFromChange,
  onToChange,
  rangeError,
}: {
  users: ManagedUser[];
  selectedUserId: number | null;
  onUserSelect: (id: number | null) => void;
  rangePreset: string;
  onPresetChange: (value: string) => void;
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  rangeError: string | null;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">User</Label>
        <Select
          value={selectedUserId === null ? "all" : String(selectedUserId)}
          onValueChange={(value) => onUserSelect(value === "all" ? null : Number(value))}
        >
          <SelectTrigger className="w-56 h-9 bg-background">
            <SelectValue placeholder="All users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.id} value={String(user.id)}>
                {user.displayName} · {user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Quick range</Label>
        <Select value={rangePreset} onValueChange={onPresetChange}>
          <SelectTrigger className="w-40 h-9 bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Today</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="custom">Custom dates</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="activity-from" className="text-[11px] uppercase tracking-wide text-muted-foreground">From</Label>
        <Input
          id="activity-from"
          type="date"
          value={from}
          max={to}
          onChange={(event) => onFromChange(event.target.value)}
          className="h-9 w-36 bg-background"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="activity-to" className="text-[11px] uppercase tracking-wide text-muted-foreground">To</Label>
        <Input
          id="activity-to"
          type="date"
          value={to}
          min={from}
          onChange={(event) => onToChange(event.target.value)}
          className="h-9 w-36 bg-background"
        />
      </div>
      {rangeError && <p className="pb-2 text-xs text-destructive">{rangeError}</p>}
    </div>
  );
}

export function UserActivityPanel({
  selectedUserId,
  onUserSelect
}: {
  selectedUserId: number | null;
  onUserSelect: (id: number | null) => void;
}) {
  const today = indiaDate(new Date());
  const [rangePreset, setRangePreset] = useState("7");
  const [to, setTo] = useState(today);
  const [from, setFrom] = useState(() => addIndiaDays(today, -6));
  const { data: usersData } = useUsers({ q: "", status: "all", role: "all" });
  const users = usersData?.users ?? [];
  const rangeError = dateRangeError(from, to);

  const { data, isLoading, isError } = useActivityReport({
    from,
    to,
    userId: selectedUserId ?? undefined,
    enabled: !rangeError,
  });

  const handlePresetChange = (value: string) => {
    setRangePreset(value);
    if (value === "custom") return;
    const days = Number(value);
    const end = indiaDate(new Date());
    setTo(end);
    setFrom(addIndiaDays(end, -(days - 1)));
  };

  const filters = (
    <ActivityFilters
      users={users}
      selectedUserId={selectedUserId}
      onUserSelect={onUserSelect}
      rangePreset={rangePreset}
      onPresetChange={handlePresetChange}
      from={from}
      to={to}
      onFromChange={(value) => {
        setFrom(value);
        setRangePreset("custom");
      }}
      onToChange={(value) => {
        setTo(value);
        setRangePreset("custom");
      }}
      rangeError={rangeError}
    />
  );

  if (isError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
        <Activity className="h-8 w-8 mb-4 opacity-50" />
        <p>Failed to load activity report.</p>
        <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  if (!selectedUserId) {
    // All Users View
    const summaries = data?.summaries || [];
    
    return (
      <div className="flex flex-col h-full overflow-hidden animate-in fade-in duration-200">
         <div className="p-4 border-b flex flex-col gap-3 shrink-0 bg-muted/20">
           <div>
             <h2 className="text-sm font-medium">Organization Activity Summary</h2>
             <p className="text-xs text-muted-foreground">Showing user activity from {from} to {to}</p>
           </div>
           {filters}
         </div>
         
         <div className="flex-1 overflow-auto bg-background">
           <Table>
             <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10 shadow-sm">
               <TableRow>
                 <TableHead>User</TableHead>
                 <TableHead className="text-right">Active Time</TableHead>
                 <TableHead className="text-right">Idle Time</TableHead>
                 <TableHead className="text-right">Page Views</TableHead>
                 <TableHead className="text-right">Actions</TableHead>
                 <TableHead className="text-right">Last Seen</TableHead>
               </TableRow>
             </TableHeader>
             <TableBody>
               {isLoading && (
                 <TableRow>
                   <TableCell colSpan={6} className="h-32 text-center">
                     <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                   </TableCell>
                 </TableRow>
               )}
               {!isLoading && summaries.length === 0 && (
                 <TableRow>
                   <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                     No activity recorded in this period.
                   </TableCell>
                 </TableRow>
               )}
               {!isLoading && summaries.map(s => (
                 <TableRow 
                   key={s.userId} 
                   className="cursor-pointer hover:bg-muted/50 transition-colors group" 
                   onClick={() => onUserSelect(s.userId)}
                 >
                   <TableCell>
                     <div className="flex items-center gap-2">
                       <div className="font-medium text-sm text-primary group-hover:underline underline-offset-4">{s.displayName}</div>
                        {s.current && <Badge variant="outline" className="text-[10px] px-1.5 h-4">Active now</Badge>}
                     </div>
                     <div className="text-xs text-muted-foreground">{s.email}</div>
                   </TableCell>
                   <TableCell className="text-right font-mono text-sm">{formatMs(s.activeMs)}</TableCell>
                   <TableCell className="text-right font-mono text-sm text-muted-foreground">{formatMs(s.idleMs)}</TableCell>
                   <TableCell className="text-right font-mono text-sm">{s.pageViews}</TableCell>
                   <TableCell className="text-right font-mono text-sm">{s.actionCount}</TableCell>
                   <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                     {s.lastSeenAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "short", timeStyle: "short" }).format(new Date(s.lastSeenAt)) : "Never"}
                   </TableCell>
                 </TableRow>
               ))}
             </TableBody>
           </Table>
         </div>
      </div>
    );
  }

  // Specific User View
  const summary = data?.summaries?.[0];
  const detail = data?.detail;

  return (
    <div className="flex flex-col h-full overflow-hidden animate-in slide-in-from-right-4 duration-300">
       <div className="p-4 border-b flex flex-col gap-3 shrink-0 bg-muted/20">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => onUserSelect(null)} className="h-8 w-8 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              {summary ? summary.displayName : <span className="w-24 h-4 bg-muted animate-pulse rounded block"></span>}
            </h2>
            <div className="text-xs text-muted-foreground">
              {summary ? summary.email : "Loading details..."}
            </div>
          </div>
        </div>
         {filters}
      </div>

      <div className="flex-1 overflow-auto bg-background p-4 md:p-6 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : !summary ? (
          <div className="text-center text-muted-foreground p-8">User data not found for this period.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active Time</CardTitle>
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="text-2xl font-bold">{formatMs(summary.activeMs)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Idle Time</CardTitle>
                  <Activity className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="text-2xl font-bold text-muted-foreground">{formatMs(summary.idleMs)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Page Views</CardTitle>
                  <Layout className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="text-2xl font-bold">{summary.pageViews}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</CardTitle>
                  <MousePointer2 className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="text-2xl font-bold">{summary.actionCount}</div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-sm font-medium">Daily Activity Trends</CardTitle>
              </CardHeader>
              <CardContent className="pb-6">
                <div className="flex items-end gap-1 h-32 w-full">
                  {summary.days.map((day) => {
                     const maxMs = Math.max(...summary.days.map(d => Math.max(d.activeMs + d.idleMs, 1)));
                     const activePct = (day.activeMs / maxMs) * 100;
                     const idlePct = (day.idleMs / maxMs) * 100;
                     const dt = new Date(day.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
                     
                     return (
                       <div key={day.date} className="flex-1 flex flex-col justify-end group relative h-full">
                         <div 
                           className="w-full bg-slate-200 dark:bg-slate-800 rounded-t-sm opacity-60 transition-opacity group-hover:opacity-100" 
                           style={{ height: `${idlePct}%` }}
                         />
                         <div 
                           className="w-full bg-primary/80 rounded-t-sm group-hover:bg-primary transition-colors absolute bottom-0" 
                           style={{ height: `${activePct}%` }}
                         />
                         <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 w-max bg-popover border text-popover-foreground text-xs p-2.5 rounded shadow-sm pointer-events-none">
                            <div className="font-semibold mb-1.5">{dt}</div>
                            <div className="flex justify-between gap-4">
                               <span className="text-muted-foreground">Active:</span> 
                               <span className="font-mono">{formatMs(day.activeMs)}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                               <span className="text-muted-foreground">Idle:</span> 
                               <span className="font-mono">{formatMs(day.idleMs)}</span>
                            </div>
                            <div className="mt-1.5 pt-1.5 border-t text-muted-foreground text-[10px]">
                              {day.pageViews} views &middot; {day.actionCount} actions
                            </div>
                         </div>
                       </div>
                     );
                  })}
                </div>
                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                  <div>{new Date(summary.days[0]?.date || from).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</div>
                  <div>{new Date(summary.days[summary.days.length - 1]?.date || to).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="flex flex-col">
                <CardHeader className="py-4 border-b">
                  <CardTitle className="text-sm font-medium">Most Visited Pages</CardTitle>
                </CardHeader>
                <div className="flex-1 overflow-auto max-h-[300px]">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>Path</TableHead>
                        <TableHead className="text-right">Views</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!detail?.pages?.length && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-muted-foreground py-8 text-sm">
                            No page views recorded.
                          </TableCell>
                        </TableRow>
                      )}
                      {detail?.pages.map(p => (
                        <TableRow key={p.path}>
                          <TableCell className="font-mono text-xs max-w-[200px] truncate" title={p.path}>
                            {p.path}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{p.views}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>

              <Card className="flex flex-col">
                <CardHeader className="py-4 border-b">
                  <CardTitle className="text-sm font-medium">Recent Actions</CardTitle>
                </CardHeader>
                <div className="flex-1 overflow-auto max-h-[300px]">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!detail?.events?.length && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-muted-foreground py-8 text-sm">
                            No actions recorded.
                          </TableCell>
                        </TableRow>
                      )}
                      {detail?.events.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {new Intl.DateTimeFormat("en-IN", { timeStyle: "short", dateStyle: "short" }).format(new Date(e.occurredAt))}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0">
                                {formatAction(e.action)}
                              </Badge>
                              <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[120px]" title={e.path ?? undefined}>
                                {e.path ?? "—"}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
