// AppShell — single persistent sidebar across all sections of the app.
//
// Navigation groups:
//   Dashboard — Overview, Regional, Coverage, Products, Momentum, Growth,
//               AI Analyst, Reports, Company Reports, Targets, Pending, Sources, Health
//   Sales     — State Head, Sales People, Primary, Secondary, Combined
//   MRP       — MRP Master, Margin (GP contribution data)
//   Market    — Market Survey (competitor pricing intelligence)
//   Customers — Rankings, Price Shrinkers, At Risk & New, Schemes
//
// The sidebar is always visible on desktop.  On mobile a hamburger opens it as
// a slide-over.  Groups are collapsible via a chevron on the group header.
import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  LayoutGrid, Map, BarChart3, Package, TrendingUp, LineChart,
  Bot, FileSpreadsheet, BarChart2 as BarChartIcon, Target,
  ClipboardList, Database, ShieldCheck,
  LayoutDashboard, Users, ShoppingBag,
  AlertTriangle, UserMinus, Settings, Store, BookOpen, Network,
  ChevronDown, ChevronRight, Menu, X, Sun, Moon, Braces, Key, Layers, IndianRupee,
  Globe, FileSearch,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Nav registry ───────────────────────────────────────────────────────────────

interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
}

interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutGrid,
    items: [
      { id: "overview",        label: "Overview",        path: "/",                icon: LayoutGrid },
      { id: "regional",        label: "Regional",        path: "/regional",        icon: Map },
      { id: "resources",       label: "Coverage",        path: "/resources",       icon: BarChart3 },
      { id: "products",        label: "Products",        path: "/products",        icon: Package },
      { id: "momentum",        label: "Momentum",        path: "/momentum",        icon: TrendingUp },
      { id: "growth",          label: "Growth",          path: "/growth",          icon: LineChart },
      { id: "analyst",         label: "AI Analyst",      path: "/analyst",         icon: Bot },
      { id: "ai-reports",     label: "AI Reports",      path: "/ai-reports",      icon: FileSpreadsheet },
      { id: "reports",         label: "Reports",         path: "/reports",         icon: FileSpreadsheet },
      { id: "company-reports", label: "Company Reports", path: "/company-reports", icon: BarChartIcon },
      { id: "comparison",      label: "Comparison",      path: "/comparison",      icon: LineChart },
      { id: "targets",         label: "Targets",         path: "/targets",         icon: Target },
      { id: "pending",         label: "Pending Orders",  path: "/pending",         icon: ClipboardList },
      { id: "sources",         label: "Organization",    path: "/sources",         icon: Database },
      { id: "warnings",        label: "Warning System",  path: "/warnings",        icon: AlertTriangle },
      { id: "data-health",     label: "Data Health",     path: "/data-health",     icon: ShieldCheck },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    icon: Users,
    items: [
      { id: "state-head",             label: "State Head",             path: "/sales/state-head",             icon: LayoutDashboard },
      { id: "salespeople",            label: "Sales People",           path: "/sales/salespeople",            icon: Users },
      { id: "primary-performance",    label: "Primary Performance",    path: "/sales/primary-performance",    icon: BarChartIcon },
      { id: "secondary-performance",  label: "Secondary Performance",  path: "/sales/secondary-performance",  icon: ShoppingBag },
      { id: "deep-dive",              label: "Sales Deep Dive",        path: "/sales/deep-dive",              icon: BookOpen },
      { id: "distributor-deep-dive",  label: "Distributor Deep Dive",  path: "/sales/distributor-deep-dive",  icon: Network  },
      { id: "sku-deep-dive",          label: "SKU Deep Dive",          path: "/sku",                          icon: Layers   },
    ],
  },
  {
    id: "mrp",
    label: "MRP",
    icon: IndianRupee,
    items: [
      { id: "mrp-master",  label: "MRP Master",   path: "/mrp",            icon: IndianRupee },
      { id: "margin",      label: "Margin",        path: "/mrp/margin",     icon: BarChart3   },
      { id: "competition", label: "Competition",   path: "/mrp/competition",icon: Layers      },
    ],
  },
  {
    id: "market",
    label: "Market",
    icon: Globe,
    items: [
      { id: "market-survey", label: "Market Survey", path: "/market-survey", icon: FileSearch },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: Store,
    items: [
      { id: "rankings",  label: "Rankings",         path: "/customers",           icon: BarChartIcon },
      { id: "shrinkers", label: "Price Shrinkers",  path: "/customers/shrinkers", icon: AlertTriangle },
      { id: "churn",     label: "At Risk & New",    path: "/customers/churn",     icon: UserMinus },
      { id: "schemes",   label: "Schemes",          path: "/customers/schemes",   icon: Settings },
      { id: "master",    label: "Customer Data",    path: "/customers/master",    icon: BookOpen },
    ],
  },
  {
    id: "org",
    label: "Organisation",
    icon: Users,
    items: [
      { id: "org-people", label: "People", path: "/org/people", icon: Users },
    ],
  },
  {
    id: "developer",
    label: "Developer",
    icon: Braces,
    items: [
      { id: "api-portal", label: "API Portal",  path: "/dev/api",     icon: Braces },
      { id: "api-keys",   label: "API Keys",    path: "/dev/keys",    icon: Key },
      { id: "masters",    label: "Master Data", path: "/dev/masters", icon: Database },
    ],
  },
];

// Determine which group & item is active from the current URL.
function activeIds(location: string): { groupId: string; itemId: string } {
  if (location.startsWith("/sales")) {
    const slug = location.replace(/^\/sales\/?/, "").split("?")[0];
    const item = NAV[1].items.find((i) => i.id === slug) ?? NAV[1].items[0];
    return { groupId: "sales", itemId: item.id };
  }
  if (location === "/sku" || location.startsWith("/sku/")) {
    return { groupId: "sales", itemId: "sku-deep-dive" };
  }
  if (location === "/mrp" || location === "/mrp/") {
    return { groupId: "mrp", itemId: "mrp-master" };
  }
  if (location === "/mrp/margin" || location.startsWith("/mrp/margin")) {
    return { groupId: "mrp", itemId: "margin" };
  }
  if (location === "/mrp/competition" || location.startsWith("/mrp/competition")) {
    return { groupId: "mrp", itemId: "competition" };
  }
  if (location.startsWith("/market-survey")) {
    return { groupId: "market", itemId: "market-survey" };
  }
  if (location.startsWith("/customers")) {
    const slug = location.replace(/^\/customers\/?/, "").split("?")[0];
    const grp = NAV.find((g) => g.id === "customers")!;
    const item = grp.items.find((i) => i.id === slug) ?? grp.items[0];
    return { groupId: "customers", itemId: item!.id };
  }
  if (location.startsWith("/org")) {
    const grp = NAV.find((g) => g.id === "org")!;
    return { groupId: "org", itemId: grp.items[0]!.id };
  }
  if (location.startsWith("/dev")) {
    const slug = location.replace(/^\/dev\/?/, "").split("?")[0] || "api-portal";
    const grp = NAV.find((g) => g.id === "developer")!;
    const item = grp.items.find((i) => i.id === slug) ?? grp.items[0];
    return { groupId: "developer", itemId: item!.id };
  }
  // Dashboard
  const slug = location === "/" ? "overview" : location.replace(/^\//, "").split("?")[0];
  const item = NAV[0].items.find((i) => i.id === slug) ?? NAV[0].items[0];
  return { groupId: "dashboard", itemId: item.id };
}

// ── AppShell ───────────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { theme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { groupId: activeGroupId, itemId: activeItemId } = activeIds(location);

  // Start with the active group expanded; others collapsed.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    dashboard: activeGroupId === "dashboard",
    sales:     activeGroupId === "sales",
    mrp:       activeGroupId === "mrp",
    market:    activeGroupId === "market",
    customers: activeGroupId === "customers",
    developer: activeGroupId === "developer",
  });

  function toggleGroup(id: string) {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function navigate(path: string) {
    setLocation(path);
    setMobileOpen(false);
  }

  const isDark = theme === "dark";

  const sidebar = (
    <aside className="flex h-full w-56 flex-col border-r bg-card">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-primary font-bold text-primary-foreground text-base select-none">
          P
        </div>
        <div className="min-w-0">
          <p className="font-bold text-sm leading-none truncate">Prayag India</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Sales Intelligence</p>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map((group) => {
          const isOpen = openGroups[group.id] ?? false;
          const GroupIcon = group.icon;
          return (
            <div key={group.id} className="mb-0.5">
              {/* Group header */}
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors",
                  activeGroupId === group.id
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <GroupIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-1 text-left">{group.label}</span>
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 opacity-60" />
                ) : (
                  <ChevronRight className="h-3 w-3 opacity-60" />
                )}
              </button>

              {/* Items */}
              {isOpen && (
                <div className="ml-1 border-l border-border/30 pl-1 pb-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeItemId === item.id && activeGroupId === group.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => navigate(item.path)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Bottom toolbar */}
      <div className="border-t px-3 py-2.5">
        <button
          type="button"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {isDark ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar — always visible */}
      <div className="hidden md:flex md:flex-shrink-0">{sidebar}</div>

      {/* Mobile slide-over sidebar */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">{sidebar}</div>
        </>
      )}

      {/* Content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center gap-3 border-b px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold text-sm">
            {NAV.flatMap((g) => g.items).find((i) => i.id === activeItemId)?.label ?? "Prayag India"}
          </span>
          {mobileOpen && (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="ml-auto text-muted-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
