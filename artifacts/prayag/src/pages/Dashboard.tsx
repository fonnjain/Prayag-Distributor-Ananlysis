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
  { id: "sources",         label: "Data Sources",    component: DataSources },
  { id: "data-health",     label: "Data Health",     component: DataHealth },
];

export const AREA_IDS = AREAS.map((a) => a.id);

export default function Dashboard() {
  const [location] = useLocation();
  const activeArea = AREAS.find((a) => location === `/${a.id}`)?.id ?? AREAS[0].id;
  const ActiveComponent = AREAS.find((a) => a.id === activeArea)?.component ?? Overview;
  const areaLabel = AREAS.find((a) => a.id === activeArea)?.label ?? "Overview";

  // Warning System is always current-FY — the global filter bar doesn't apply there.
  const hideFilterBar = activeArea === "warnings";

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
      <header className="mb-5">
        <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight mb-3">
          {areaLabel}
        </h2>
        {!hideFilterBar && <GlobalFilterBar />}
        {hideFilterBar && (
          <p className="text-sm text-muted-foreground">
            Always showing current fiscal year · FY 2026-27
          </p>
        )}
      </header>

      <ActiveComponent />
    </div>
  );
}
