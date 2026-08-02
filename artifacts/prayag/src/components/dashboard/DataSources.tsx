import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useDashboard } from "@/data/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, Database, FolderGit2, CheckCircle2, Clock, Target, UserX } from "lucide-react";
import Organisation from "./Organisation";

// ── Unmatched order-booking names ────────────────────────────────────────────
// Net Sale counted in the company total but attributed to no member or head —
// the largest single data-quality item on this page. Each name is checked
// against the identity registry so spelling variants the app can already
// resolve are separated from genuinely unknown names before anyone is asked
// to fix them by hand.

type UnmatchedName = {
  name: string;
  amount: number;
  registryStatus: "resolvable" | "ambiguous" | "unknown" | "unchecked";
  resolvedTo: string | null;
  candidates: string[] | null;
};

type UnmatchedPayload = {
  fy: string;
  count: number;
  totalAmount: number;
  registryAvailable: boolean;
  names: UnmatchedName[];
};

const fmtL = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : `₹${(n / 1e5).toFixed(2)} L`;

const STATUS_BADGE: Record<UnmatchedName["registryStatus"], { label: string; cls: string }> = {
  resolvable: { label: "Registry match", cls: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300" },
  ambiguous: { label: "Ambiguous", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  unknown: { label: "Unknown", cls: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" },
  unchecked: { label: "Not checked", cls: "bg-muted text-muted-foreground" },
};

function UnmatchedNamesCard() {
  const [data, setData] = useState<UnmatchedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/mgmt/unmatched-names", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: UnmatchedPayload) => setData(d))
      .catch((e) => {
        if (e?.name !== "AbortError") setError(String(e?.message ?? e));
      });
    return () => ctrl.abort();
  }, []);

  if (error) return null; // panel is diagnostic; never block the page on it
  const resolvable = data?.names.filter((n) => n.registryStatus === "resolvable").length ?? 0;
  const shown = data ? (expanded ? data.names : data.names.slice(0, 15)) : [];

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-3">
        <CardTitle className="text-xl flex items-center gap-2">
          <UserX className="w-5 h-5 text-amber-600" />
          Unmatched Order-Booking Names
        </CardTitle>
        <CardDescription>
          {data
            ? <>Order-booking names in {data.fy} that match no roster member — {data.count} names carrying {fmtL(data.totalAmount)} of net Sale counted in the company total but attributed to no member or head. {resolvable > 0 && <>The identity registry already resolves {resolvable} of them as spelling variants — fix those by mapping, not by hand.</>}</>
            : "Checking order-booking names against the roster and identity registry…"}
        </CardDescription>
      </CardHeader>
      {data && data.count > 0 && (
        <CardContent className="px-6 pb-6">
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Name in order file</th>
                  <th className="px-3 py-2 font-medium text-right">Value</th>
                  <th className="px-3 py-2 font-medium">Registry check</th>
                  <th className="px-3 py-2 font-medium">Likely member</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((n) => {
                  const badge = STATUS_BADGE[n.registryStatus];
                  return (
                    <tr key={n.name} className="border-t border-border/50">
                      <td className="px-3 py-1.5">{n.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtL(n.amount)}</td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {n.resolvedTo ?? (n.candidates ? n.candidates.join("; ") : "—")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.names.length > 15 && (
            <button
              className="mt-2 text-xs text-primary underline underline-offset-2"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show fewer" : `Show all ${data.names.length} names`}
            </button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function DataSources() {
  const { manifest } = useDashboard();
  const generatedDate = new Date(manifest.generated);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      {/* Organisation model — State Heads, States, Employees */}
      <Organisation />

      {/* Largest single data-quality item on this page */}
      <UnmatchedNamesCard />

      {/* Target editors moved to the Targets page — Data Sources describes sources, it does not edit targets. */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="px-6 py-5 flex items-start gap-3">
          <Target className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium">Looking for the target editors?</p>
            <p className="text-muted-foreground mt-0.5">
              State Head Targets and Secondary Targets are now edited on the{" "}
              <Link href="/targets" className="text-primary underline underline-offset-2">Targets page</Link>.
              This page describes where data comes from; it no longer edits targets.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            Dataset Provenance
          </CardTitle>
          <CardDescription>
            Transparency audit of all source files merged into this intelligence view.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-8">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-4 h-4" /> Last Generated
              </p>
              <p className="text-sm font-medium">{generatedDate.toLocaleString()}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <FolderGit2 className="w-4 h-4" /> Source Drive
              </p>
              <p className="text-sm font-medium truncate" title={manifest.drive_account}>{manifest.drive_account}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Pipeline Status
              </p>
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Validated & Normalized</p>
            </div>
          </div>

          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4">Primary Sources</h3>
              <div className="grid gap-3">
                {Object.entries(manifest.primary_sources).map(([key, source]) => (
                  <div key={key} className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-background/50">
                    <FileText className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{key.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{source.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-8">
              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-purple-500"></span> Sales Data Files
                </h3>
                <ul className="space-y-2">
                  {manifest.sales_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.fy})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span> Orders & Support
                </h3>
                <ul className="space-y-2">
                  {manifest.order_and_support_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.period})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {manifest.notes && manifest.notes.length > 0 && (
              <div className="pt-4 border-t border-border/50">
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-3">Processing Notes</h3>
                <ul className="space-y-2">
                  {manifest.notes.map((note, i) => (
                    <li key={i} className="text-sm text-muted-foreground italic">
                      Note: {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
