// SalesPage — content-only page rendered inside AppShell.
// Sidebar is provided by AppShell; this renders the active Sales section.
import { lazy, Suspense } from "react";
import { useLocation } from "wouter";
import StateHeadDashboard from "@/components/dashboard/StateHeadDashboard";
import SalesPeople from "@/components/dashboard/SalesPeople";
import SalesDeepDive from "@/components/dashboard/SalesDeepDive";

const PrimaryPerformanceDashboard = lazy(
  () => import("@/components/dashboard/PrimaryPerformanceDashboard"),
);
const SecondaryPerformanceDashboard = lazy(
  () => import("@/components/dashboard/SecondaryPerformanceDashboard"),
);
const CombinedPerformanceDashboard = lazy(
  () => import("@/components/dashboard/CombinedPerformanceDashboard"),
);

const DistributorDeepDive = lazy(
  () => import("@/components/dashboard/DistributorDeepDive"),
);

const SECTIONS = [
  { id: "state-head",              label: "State Head",              component: StateHeadDashboard,            lazy: false },
  { id: "salespeople",             label: "Sales People",            component: SalesPeople,                   lazy: false },
  { id: "primary-performance",     label: "Primary Performance",     component: PrimaryPerformanceDashboard,   lazy: true },
  { id: "secondary-performance",   label: "Secondary Performance",   component: SecondaryPerformanceDashboard, lazy: true },
  { id: "combined",                label: "Combined",                component: CombinedPerformanceDashboard,  lazy: true },
  { id: "deep-dive",               label: "Sales Deep Dive",         component: SalesDeepDive,                 lazy: false },
  { id: "distributor-deep-dive",   label: "Distributor Deep Dive",   component: DistributorDeepDive,           lazy: true },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function sectionFromPath(path: string): SectionId {
  const slug = path.replace(/^\/sales\/?/, "").split("?")[0] as SectionId;
  return SECTIONS.find((s) => s.id === slug)?.id ?? SECTIONS[0].id;
}

export default function SalesPage() {
  const [location] = useLocation();
  const activeSectionId = sectionFromPath(location);
  const activeSection = SECTIONS.find((s) => s.id === activeSectionId) ?? SECTIONS[0];
  const ActiveComponent = activeSection.component;

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
      <header className="mb-6">
        <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight">
          {activeSection.label}
        </h2>
      </header>
      {activeSection.lazy ? (
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
              Loading...
            </div>
          }
        >
          <ActiveComponent />
        </Suspense>
      ) : (
        <ActiveComponent />
      )}
    </div>
  );
}
