// SalesPage — content-only page rendered inside AppShell.
// Sidebar is provided by AppShell; this renders the active Sales section.
import { LoadingState } from "@/components/ui/loading-state";
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "wouter";
import GlobalFilterBar from "@/components/GlobalFilterBar";
import StateHeadDashboard from "@/components/dashboard/StateHeadDashboard";
import SalesPeople from "@/components/dashboard/SalesPeople";
import SalesDeepDive from "@/components/dashboard/SalesDeepDive";
import SecondaryPerformanceDashboard from "@/components/dashboard/SecondaryPerformanceDashboard";
import { AlertTriangle } from "lucide-react";

const PrimaryPerformanceDashboard = lazy(
  () => import("@/components/dashboard/PrimaryPerformanceDashboard"),
);
const DistributorDeepDive = lazy(
  () => import("@/components/dashboard/DistributorDeepDive"),
);

const SECTIONS = [
  { id: "state-head",              label: "State Head",              component: StateHeadDashboard,            lazy: false },
  { id: "salespeople",             label: "Sales People",            component: SalesPeople,                   lazy: false },
  { id: "primary-performance",     label: "Primary Performance",     component: PrimaryPerformanceDashboard,   lazy: true },
  { id: "secondary-performance",   label: "Secondary Performance",   component: SecondaryPerformanceDashboard, lazy: false },
  { id: "deep-dive",               label: "Sales Deep Dive",         component: SalesDeepDive,                 lazy: false },
  { id: "distributor-deep-dive",   label: "Distributor Deep Dive",   component: DistributorDeepDive,           lazy: true },
] as const;

class SalesSectionErrorBoundary extends Component<
  { sectionLabel: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Sales section render failed", { error, info, section: this.props.sectionLabel });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p className="font-medium">{this.props.sectionLabel} could not be displayed.</p>
            <p className="text-sm">Reload this section to recover. If the issue continues, the error will remain visible instead of showing a blank page.</p>
            <button
              type="button"
              className="rounded-md border border-current px-3 py-1.5 text-sm font-medium hover:bg-red-100 dark:hover:bg-red-950/50"
              onClick={() => window.location.reload()}
            >
              Reload section
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
      <header className="mb-5">
        <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight mb-3">
          {activeSection.label}
        </h2>
        <GlobalFilterBar />
      </header>
      <SalesSectionErrorBoundary key={activeSection.id} sectionLabel={activeSection.label}>
        {activeSection.lazy ? (
          <Suspense
            fallback={<LoadingState className="h-48" />}
          >
            <ActiveComponent />
          </Suspense>
        ) : (
          <ActiveComponent />
        )}
      </SalesSectionErrorBoundary>
    </div>
  );
}
