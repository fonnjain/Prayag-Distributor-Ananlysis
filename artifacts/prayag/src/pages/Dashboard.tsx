// Dashboard — content-only page rendered inside AppShell.
// Sidebar and shell chrome are provided by AppShell; this component renders
// only the title header and the active area component.
import { useLocation } from "wouter";
import { RefreshCw } from "lucide-react";
import Overview from "@/components/dashboard/Overview";
import Regional from "@/components/dashboard/Regional";
import Resources from "@/components/dashboard/Resources";
import Products from "@/components/dashboard/Products";
import OrderMomentum from "@/components/dashboard/OrderMomentum";
import DataSources from "@/components/dashboard/DataSources";
import Growth from "@/components/dashboard/Growth";
import Analyst from "@/components/dashboard/Analyst";
import AiReports from "@/components/dashboard/AiReports";
import MgmtReports from "@/components/dashboard/MgmtReports";
import CompanyReports from "@/components/dashboard/CompanyReports";
import Targets from "@/components/dashboard/Targets";
import DataHealth from "@/components/dashboard/DataHealth";
import PendingOrders from "@/components/dashboard/PendingOrders";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/data/dashboard-context";

const AREAS = [
  { id: "overview",        label: "Overview",        component: Overview },
  { id: "regional",        label: "Regional",        component: Regional },
  { id: "resources",       label: "Coverage",        component: Resources },
  { id: "products",        label: "Products",        component: Products },
  { id: "momentum",        label: "Momentum",        component: OrderMomentum },
  { id: "growth",          label: "Growth",          component: Growth },
  { id: "analyst",         label: "AI Analyst",      component: Analyst },
  { id: "ai-reports",     label: "AI Reports",      component: AiReports },
  { id: "reports",         label: "Reports",         component: MgmtReports },
  { id: "company-reports", label: "Company Reports", component: CompanyReports },
  { id: "targets",         label: "Targets",         component: Targets },
  { id: "pending",         label: "Pending Orders",  component: PendingOrders },
  { id: "sources",         label: "Data Sources",    component: DataSources },
  { id: "data-health",     label: "Data Health",     component: DataHealth },
];

export const AREA_IDS = AREAS.map((a) => a.id);

export default function Dashboard() {
  const [location] = useLocation();
  const activeArea = AREAS.find((a) => location === `/${a.id}`)?.id ?? AREAS[0].id;
  const ActiveComponent = AREAS.find((a) => a.id === activeArea)?.component ?? Overview;
  const areaLabel = AREAS.find((a) => a.id === activeArea)?.label ?? "Overview";

  const { syncedAt, sourceStatus, isRefreshing, refresh, refreshError } = useDashboard();
  const d = new Date(syncedAt ?? Date.now());
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const isLive = sourceStatus === "live";

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight">{areaLabel}</h2>
          <div className="flex items-center gap-3 mt-1.5">
            <span className={cn(
              "text-xs font-medium px-2 py-0.5 rounded",
              isLive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
            )}>
              {isLive ? "Live from Google Sheets" : "Baseline dataset"}
            </span>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Last synced {time} on {date}
            </span>
            {refreshError && (
              <span className="text-xs text-destructive hidden sm:inline">{refreshError}</span>
            )}
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={isRefreshing}
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
        >
          <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
          <span className="hidden sm:inline">{isRefreshing ? "Refreshing" : "Refresh data"}</span>
        </button>
      </header>

      <ActiveComponent />
    </div>
  );
}
