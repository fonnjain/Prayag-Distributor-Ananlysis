import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useTheme } from "next-themes";
import { Sun, Moon, Printer, Menu, X, BarChart3, Map, LayoutGrid, Package, TrendingUp, LineChart, Database, Bot, FileSpreadsheet, Target, Users } from "lucide-react";
import Overview from "@/components/dashboard/Overview";
import Regional from "@/components/dashboard/Regional";
import Resources from "@/components/dashboard/Resources";
import Products from "@/components/dashboard/Products";
import OrderMomentum from "@/components/dashboard/OrderMomentum";
import DataSources from "@/components/dashboard/DataSources";
import Growth from "@/components/dashboard/Growth";
import Analyst from "@/components/dashboard/Analyst";
import MgmtReports from "@/components/dashboard/MgmtReports";
import Targets from "@/components/dashboard/Targets";
import SalesPeople from "@/components/dashboard/SalesPeople";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { useDashboard } from "@/data/dashboard-context";

const AREAS = [
  { id: "overview", label: "Overview", icon: LayoutGrid, component: Overview },
  { id: "regional", label: "Regional", icon: Map, component: Regional },
  { id: "resources", label: "Coverage", icon: BarChart3, component: Resources },
  { id: "products", label: "Products", icon: Package, component: Products },
  { id: "momentum", label: "Momentum", icon: TrendingUp, component: OrderMomentum },
  { id: "growth", label: "Growth", icon: LineChart, component: Growth },
  { id: "analyst", label: "AI Analyst", icon: Bot, component: Analyst },
  { id: "reports", label: "Reports", icon: FileSpreadsheet, component: MgmtReports },
  { id: "sales-people", label: "Sales People", icon: Users, component: SalesPeople },
  { id: "targets", label: "Targets", icon: Target, component: Targets },
  { id: "sources", label: "Data Sources", icon: Database, component: DataSources },
];

export const AREA_IDS = AREAS.map((a) => a.id);

export default function Dashboard() {
  const { theme, setTheme } = useTheme();
  const [location, setLocation] = useLocation();
  const activeArea =
    AREAS.find((a) => location === `/${a.id}`)?.id ?? AREAS[0].id;
  const setActiveArea = (id: string) =>
    setLocation(id === AREAS[0].id ? "/" : `/${id}`);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isDark = theme === "dark";

  // Handle dark mode setup initially if needed
  useEffect(() => {
    if (!theme) {
      setTheme("light");
    }
  }, [theme, setTheme]);

  const ActiveComponent = AREAS.find(a => a.id === activeArea)?.component || Overview;

  const { syncedAt, sourceStatus, isRefreshing, refresh, refreshError } = useDashboard();
  const d = new Date(syncedAt ?? Date.now());
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const lastRefreshed = `${time} on ${date}`;
  const isLive = sourceStatus === "live";
  const statusLabel = isLive ? "Live from Google Sheets" : "Baseline dataset";

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 bg-card border-b border-border/50 sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold font-display text-lg">P</div>
          <span className="font-display font-semibold text-lg">Prayag India</span>
        </div>
        <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-foreground">
          {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* Sidebar Navigation */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-40 w-64 bg-card border-r border-border/50 transform transition-transform duration-300 ease-in-out md:translate-x-0 md:static md:flex md:flex-col",
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 hidden md:flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold font-display text-xl shadow-sm">P</div>
          <div>
            <h1 className="font-display font-bold text-xl tracking-tight leading-none">Prayag India</h1>
            <p className="text-xs text-muted-foreground mt-1 font-medium">Sales Intelligence</p>
          </div>
        </div>
        
        <nav className="flex-1 px-4 py-6 md:py-2 space-y-1 overflow-y-auto">
          {AREAS.map((area) => {
            const Icon = area.icon;
            const isActive = activeArea === area.id;
            return (
              <button
                key={area.id}
                onClick={() => {
                  setActiveArea(area.id);
                  setMobileMenuOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                  isActive 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className={cn("w-4 h-4", isActive ? "opacity-100" : "opacity-70")} />
                {area.label}
              </button>
            )
          })}
        </nav>

        <div className="p-4 border-t border-border/50 mt-auto">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="flex items-center justify-center w-9 h-9 rounded-md border border-border/50 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => window.print()}
              className="flex items-center justify-center w-9 h-9 rounded-md border border-border/50 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Print dashboard"
            >
              <Printer className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
          <header className="mb-8 hidden md:block">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-3xl font-bold tracking-tight">
                  {AREAS.find(a => a.id === activeArea)?.label}
                </h2>
                <div className="flex items-center gap-3 mt-2">
                  <span className={cn(
                    "text-sm font-medium px-2 py-0.5 rounded",
                    isLive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                  )}>{statusLabel}</span>
                  <span className="text-xs text-muted-foreground">Last synced {lastRefreshed}</span>
                  {refreshError && (
                    <span className="text-xs text-destructive">{refreshError}</span>
                  )}
                </div>
              </div>
              <button
                onClick={refresh}
                disabled={isRefreshing}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
              >
                <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                {isRefreshing ? "Refreshing" : "Refresh data"}
              </button>
            </div>
          </header>

          <div className="md:hidden mb-6">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-2xl font-bold tracking-tight">
                {AREAS.find(a => a.id === activeArea)?.label}
              </h2>
              <button
                onClick={refresh}
                disabled={isRefreshing}
                className="flex items-center justify-center w-9 h-9 rounded-md border border-border/50 hover:bg-muted transition-colors disabled:opacity-60 shrink-0"
                aria-label="Refresh data"
              >
                <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className={cn(
                "text-xs font-medium px-1.5 py-0.5 rounded",
                isLive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}>{statusLabel}</span>
              <span className="text-[10px] text-muted-foreground">Synced {lastRefreshed}</span>
            </div>
          </div>

          <ActiveComponent />
        </div>
      </main>

      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </div>
  );
}
