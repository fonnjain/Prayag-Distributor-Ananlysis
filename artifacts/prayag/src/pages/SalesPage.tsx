import { useState, lazy, Suspense } from "react";
import { useLocation } from "wouter";
import { useTheme } from "next-themes";
import {
  Sun,
  Moon,
  Menu,
  X,
  ChevronLeft,
  LayoutDashboard,
  Users,
  BarChart2,
  GitMerge,
  ShoppingBag,
} from "lucide-react";
import StateHeadDashboard from "@/components/dashboard/StateHeadDashboard";
import SalesPeople from "@/components/dashboard/SalesPeople";
import { cn } from "@/lib/utils";

const PrimaryPerformanceDashboard = lazy(
  () => import("@/components/dashboard/PrimaryPerformanceDashboard"),
);
const SecondaryPerformanceDashboard = lazy(
  () => import("@/components/dashboard/SecondaryPerformanceDashboard"),
);
const CombinedPerformanceDashboard = lazy(
  () => import("@/components/dashboard/CombinedPerformanceDashboard"),
);

// ── Section registry ──────────────────────────────────────────────────────────
// Add new Sales sub-sections here. The first entry is the default.

const SECTIONS = [
  {
    id: "state-head",
    label: "State Head",
    icon: LayoutDashboard,
    component: StateHeadDashboard,
    lazy: false,
  },
  {
    id: "salespeople",
    label: "Sales People",
    icon: Users,
    component: SalesPeople,
    lazy: false,
  },
  {
    id: "primary-performance",
    label: "Primary Performance",
    icon: BarChart2,
    component: PrimaryPerformanceDashboard,
    lazy: true,
  },
  {
    id: "secondary-performance",
    label: "Secondary Performance",
    icon: ShoppingBag,
    component: SecondaryPerformanceDashboard,
    lazy: true,
  },
  {
    id: "combined",
    label: "Combined",
    icon: GitMerge,
    component: CombinedPerformanceDashboard,
    lazy: true,
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// ── Helper ────────────────────────────────────────────────────────────────────

function sectionFromPath(path: string): SectionId {
  // path is /sales, /sales/state-head, etc.
  const slug = path.replace(/^\/sales\/?/, "").split("?")[0] as SectionId;
  return SECTIONS.find((s) => s.id === slug)?.id ?? SECTIONS[0].id;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [location, setLocation] = useLocation();
  const { theme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isDark = theme === "dark";

  const activeSectionId = sectionFromPath(location);
  const activeSection =
    SECTIONS.find((s) => s.id === activeSectionId) ?? SECTIONS[0];
  const ActiveComponent = activeSection.component;

  const navigate = (id: SectionId) => {
    setLocation(`/sales/${id}`);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* ── Mobile top bar ─────────────────────────────────────────────────── */}
      <div className="md:hidden flex items-center justify-between p-4 bg-card border-b border-border/50 sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold font-display text-lg select-none">
            P
          </div>
          <span className="font-display font-semibold text-lg">Sales</span>
        </div>
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="p-2 text-foreground"
        >
          {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 bg-card border-r border-border/50 transform transition-transform duration-300 ease-in-out",
          "md:translate-x-0 md:static md:flex md:flex-col",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Logo / brand */}
        <div className="p-6 hidden md:flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold font-display text-xl shadow-sm select-none">
            P
          </div>
          <div>
            <h1 className="font-display font-bold text-xl tracking-tight leading-none">
              Prayag India
            </h1>
            <p className="text-xs text-muted-foreground mt-1 font-medium">
              Sales Intelligence
            </p>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 md:py-2 space-y-1 overflow-y-auto">
          {/* Back to main dashboard */}
          <button
            onClick={() => {
              setLocation("/");
              setMobileOpen(false);
            }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all duration-200"
          >
            <ChevronLeft className="w-4 h-4 opacity-70" />
            Dashboard
          </button>

          <div className="pt-1 pb-1 border-b border-border/30" />

          {/* Section group label */}
          <div className="px-3 pt-3 pb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Sales
            </span>
          </div>

          {/* Sub-section nav items */}
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection.id === section.id;
            return (
              <button
                key={section.id}
                onClick={() => navigate(section.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon
                  className={cn("w-4 h-4", isActive ? "opacity-100" : "opacity-70")}
                />
                {section.label}
              </button>
            );
          })}
        </nav>

        {/* Bottom toolbar */}
        <div className="p-4 border-t border-border/50 mt-auto">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="flex items-center justify-center w-9 h-9 rounded-md border border-border/50 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
          {/* Desktop section header */}
          <header className="mb-8 hidden md:block">
            <h2 className="font-display text-3xl font-bold tracking-tight">
              {activeSection.label}
            </h2>
          </header>

          {/* Mobile section header */}
          <div className="md:hidden mb-6">
            <h2 className="font-display text-2xl font-bold tracking-tight">
              {activeSection.label}
            </h2>
          </div>

          <ActiveComponent />
        </div>
      </main>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </div>
  );
}
