import { Card, CardContent } from "@/components/ui/card";
import { ReactNode } from "react";

export function KPICard({ 
  title, 
  value, 
  subtitle,
  icon
}: { 
  title: string; 
  value: ReactNode; 
  subtitle?: string;
  icon?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm shadow-sm transition-all hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
            <p className="text-3xl font-bold font-display text-foreground tracking-tight">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-2">{subtitle}</p>
            )}
          </div>
          {icon && (
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        backgroundColor: "hsl(var(--card))",
        borderRadius: "8px",
        padding: "12px",
        border: "1px solid hsl(var(--border))",
        color: "hsl(var(--foreground))",
        fontSize: "13px",
        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      }}
    >
      <div style={{ marginBottom: "8px", fontWeight: 600, borderBottom: "1px solid hsl(var(--border))", paddingBottom: "4px" }}>
        {label}
      </div>
      {payload.map((entry: any, index: number) => (
        <div key={index} style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
          {entry.color && entry.color !== "#ffffff" && (
            <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: entry.color, flexShrink: 0 }} />
          )}
          <span style={{ color: "hsl(var(--muted-foreground))" }}>{entry.name}</span>
          <span style={{ marginLeft: "12px", fontWeight: 600, color: "hsl(var(--foreground))" }}>
            {typeof entry.value === "number" ? entry.value.toLocaleString() : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CustomLegend({ payload }: any) {
  if (!payload || payload.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px 16px", fontSize: "12px", marginTop: "12px" }}>
      {payload.map((entry: any, index: number) => (
        <div key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: entry.color, flexShrink: 0 }} />
          <span style={{ color: "hsl(var(--muted-foreground))" }}>{entry.value}</span>
        </div>
      ))}
    </div>
  );
}
