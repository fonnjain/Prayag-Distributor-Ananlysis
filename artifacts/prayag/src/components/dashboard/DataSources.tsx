import { Link } from "wouter";
import { useDashboard } from "@/data/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, Database, FolderGit2, CheckCircle2, Clock, Target } from "lucide-react";
import Organisation from "./Organisation";

export default function DataSources() {
  const { manifest } = useDashboard();
  const generatedDate = new Date(manifest.generated);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      {/* Organisation model — State Heads, States, Employees */}
      <Organisation />

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
