// Dashboard — content-only page rendered inside AppShell.
// Sidebar and shell chrome are provided by AppShell; this component renders
// the global filter bar, title header, and the active area component.
import { useLocation } from "wouter";
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
import WarningSystem from "@/components/dashboard/WarningSystem";
import PendingOrders from "@/components/dashboard/PendingOrders";
import GlobalFilterBar from "@/components/GlobalFilterBar";
import { useDashboard } from "@/data/dashboard-context";
import { RefreshCw } from "lucide-react";

/**
 * Friendly notice shown while Google briefly rate-limits Sheets reads.
 * The dashboard query auto-retries; this banner makes the ≤60s cold-start
 * window feel intentional rather than broken.
 */
function QuotaWaitBanner() {
  const { quotaWait } = useDashboard();
  if (!quotaWait) return null;
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
      data-testid="banner-quota-wait"
    >
      <RefreshCw className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
      <span>
        Your data is loading — Google briefly limits how fast sheets can be
        read. This resolves itself within a minute; the dashboard will refresh
        automatically.
      </span>
    </div>
  );
}

const AREAS = [
  { id: "overview",        label: "Overview",        component: Overview },
  { id: "regional",        label: "Regional",        component: Regional },
  { id: "resources",       label: "Coverage",        component: Resources },
  { id: "products",        label: "Products",        component: Products },
  { id: "momentum",        label: "Momentum",        component: OrderMomentum },
  { id: "growth",          label: "Growth",          component: Growth },
  { id: "warnings",        label: "Warning System",  component: WarningSystem },
  { id: "analyst",         label: "AI Analyst",      component: Analyst },
  { id: "ai-reports",     label: "AI Reports",      component: AiReports },
  { id: "reports",         label: "Reports",         component: MgmtReports },
  { id: "company-reports", label: "Company Reports", component: CompanyReports },
  { id: "targets",         label: "Targets",         component: Targets },
  { id: "pending",         label: "Pending Orders",  component: PendingOrders },
  { id: "sources",         label: "Organization",    component: DataSources },
  { id: "data-health",     label: "Data Health",     component: DataHealth },
];

export const AREA_IDS = AREAS.map((a) => a.id);

export default function Dashboard() {
  const [location] = useLocation();
  const activeArea = AREAS.find((a) => location === `/${a.id}`)?.id ?? AREAS[0].id;
  const ActiveComponent = AREAS.find((a) => a.id === activeArea)?.component ?? Overview;
  const areaLabel = AREAS.find((a) => a.id === activeArea)?.label ?? "Overview";

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
      <header className="mb-5">
        <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight mb-3">
          {areaLabel}
        </h2>
        {/* GlobalFilterBar reads periodCapability from context and renders accordingly.
            FULL pages show all controls; FY_ONLY pages show FY selector + reason;
            NONE pages show only the sync row + a brief note. */}
        <GlobalFilterBar />
      </header>

      <QuotaWaitBanner />

      <ActiveComponent />
    </div>
  );
}
