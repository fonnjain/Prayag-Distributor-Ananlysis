import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import AppShell from "@/components/AppShell";
import Dashboard, { AREA_IDS } from "@/pages/Dashboard";
import SalesPage from "@/pages/SalesPage";
import CustomersPage from "@/pages/CustomersPage";
import SkuPage from "@/pages/SkuPage";
import MrpPage from "@/pages/MrpPage";
import MarginPage from "@/pages/MarginPage";
import MarketSurveyPage from "@/pages/MarketSurveyPage";
import CompetitionPricePage from "@/pages/CompetitionPricePage";
import DevPortalPage from "@/pages/DevPortalPage";
import DevApiKeysPage from "@/pages/DevApiKeysPage";
import DevMastersPage from "@/pages/DevMastersPage";
import CatalogueReviewPage from "@/pages/CatalogueReviewPage";
import OrgCustomersPage from "@/pages/OrgCustomersPage";
import OrgPeoplePage    from "@/pages/OrgPeoplePage";
import OrgUsersPage     from "@/pages/OrgUsersPage";
import CoverageDriftPage from "@/pages/CoverageDriftPage";
import AlertsPage from "@/pages/AlertsPage";
import AlertRecipientsPage from "@/pages/AlertRecipientsPage";
import WarningsPage from "@/pages/WarningsPage";
import SecondaryOrdersPage from "@/pages/SecondaryOrdersPage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "@/pages/not-found";
import { DashboardProvider } from "@/data/dashboard-context";
import { GlobalFilterProvider } from "@/data/global-filter-context";
import { AuthProvider, useAuth } from "@/data/auth-context";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="h-screen w-screen flex items-center justify-center bg-background" />;
  }

  if (!user) {
    return null; // AuthProvider redirects
  }

  return (
    <DashboardProvider>
      <GlobalFilterProvider>
        <AppShell>
          <Switch>
        {/* Sales section */}
        <Route path="/sales/:section" component={SalesPage} />
        <Route path="/sales" component={SalesPage} />
        <Route path="/secondary-orders" component={SecondaryOrdersPage} />
        {/* SKU Deep Dive */}
        <Route path="/sku" component={SkuPage} />
        {/* MRP section */}
        <Route path="/mrp/competition" component={CompetitionPricePage} />
        <Route path="/mrp/margin" component={MarginPage} />
        <Route path="/mrp" component={MrpPage} />
        {/* Market Survey */}
        <Route path="/market-survey" component={MarketSurveyPage} />
        {/* Customer Performance */}
        <Route path="/customers/:section" component={CustomersPage} />
        <Route path="/customers" component={CustomersPage} />
        {/* Alerts */}
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/alert-recipients" component={AlertRecipientsPage} />
        <Route path="/warnings" component={WarningsPage} />
        {/* Organisation */}
        <Route path="/org/people"    component={OrgPeoplePage}    />
        <Route path="/org/customers" component={OrgCustomersPage} />
        <Route path="/org/coverage-review" component={CoverageDriftPage} />
        {user.role === 'admin' && <Route path="/org/users" component={OrgUsersPage} />}
        {/* Developer Portal */}
        <Route path="/dev/api" component={DevPortalPage} />
        <Route path="/dev/keys" component={DevApiKeysPage} />
        <Route path="/dev/masters" component={DevMastersPage} />
        {user.role === 'admin' && <Route path="/dev/catalogue-review" component={CatalogueReviewPage} />}
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
      </GlobalFilterProvider>
    </DashboardProvider>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route component={ProtectedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthProvider>
              <Router />
            </AuthProvider>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
