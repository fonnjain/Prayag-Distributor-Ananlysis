import { Card, CardContent } from "@/components/ui/card";
import EngineTargets from "./EngineTargets";

export default function AiTargets() {
  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <Card className="border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/20">
        <CardContent className="px-5 py-4 text-sm space-y-1">
          <p className="font-semibold text-foreground">AI proposals, not committed targets</p>
          <p className="text-muted-foreground">
            Primary proposals use company dispatch from PostgreSQL <code>sale_line_current</code>.
            Secondary People proposals use retailer booking from PostgreSQL{" "}
            <code>secondary_sku_line</code>. They measure different flows and must not be added.
          </p>
          <p className="text-muted-foreground">
            Editing a proposal stores an engine override only. Canonical target entry and monthly
            primary seasonal calculation remain on the Targets page.
          </p>
        </CardContent>
      </Card>
      <EngineTargets />
    </div>
  );
}