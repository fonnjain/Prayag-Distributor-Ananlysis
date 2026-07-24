import { Card, CardContent } from "@/components/ui/card";
import { ReactNode } from "react";

export function KPICard({ 
  title, 
  value, 
  subtitle,
  icon,
  detail,
}: { 
  title: string; 
  value: ReactNode; 
  subtitle?: string;
  icon?: ReactNode;
  detail?: string[];
}) {
  return (
    <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm shadow-sm transition-all hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
            <p className="text-3xl font-bold font-display text-foreground tracking-tight">{value}</p>
            {(subtitle || detail) && (
              <div className="mt-2 space-y-0.5">
                {subtitle && (
                  <p className="text-xs text-muted-foreground">{subtitle}</p>
                )}
                {detail?.map((line, i) => (
                  <p key={i} className="text-xs text-muted-foreground leading-tight">{line}</p>
                ))}
              </div>
            )}
          </div>
          {icon && (
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0 ml-2">
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-popover border border-border rounded-lg shadow-lg p-3 text-sm">
        <p className="font-medium text-foreground mb-1">{label}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} style={{ color: entry.color }} className="text-xs">
            {entry.name}: {typeof entry.value === "number" ? entry.value.toLocaleString() : entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

export function CustomLegend({ payload }: any) {
  if (!payload) return null;
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {payload.map((entry: any, index: number) => (
        <div key={index} className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-xs text-muted-foreground">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}
