import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import AppShell from "@/components/AppShell";
import Dashboard, { AREA_IDS } from "@/pages/Dashboard";
import SalesPage from "@/pages/SalesPage";
import CustomersPage from "@/pages/CustomersPage";
import DevPortalPage from "@/pages/DevPortalPage";
import DevApiKeysPage from "@/pages/DevApiKeysPage";
import NotFound from "@/pages/not-found";
import { DashboardProvider } from "@/data/dashboard-context";
import { GlobalFilterProvider } from "@/data/global-filter-context";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <AppShell>
      <Switch>
        {/* Sales section */}
        <Route path="/sales/:section" component={SalesPage} />
        <Route path="/sales" component={SalesPage} />
        {/* Customer Performance */}
        <Route path="/customers/:section" component={CustomersPage} />
        <Route path="/customers" component={CustomersPage} />
        {/* Developer Portal */}
        <Route path="/dev/api" component={DevPortalPage} />
        <Route path="/dev/keys" component={DevApiKeysPage} />
        <Route path="/dev" component={DevPortalPage} />
        {/* Dashboard areas */}
        <Route path="/" component={Dashboard} />
        <Route path="/:area">
          {(params) =>
            AREA_IDS.includes(params.area) ? <Dashboard /> : <NotFound />
          }
        </Route>
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <TooltipProvider>
          <DashboardProvider>
            <GlobalFilterProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
            </GlobalFilterProvider>
          </DashboardProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
