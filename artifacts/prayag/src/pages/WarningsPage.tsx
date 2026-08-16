// Standalone page for the Warning System, mounted at /warnings.
// Previously rendered as a Dashboard area; now a first-class Alerts sub-page.
import WarningSystem from "@/components/dashboard/WarningSystem";

export default function WarningsPage() {
  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
      <header className="mb-5">
        <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight mb-1">
          Warning System
        </h2>
        <p className="text-sm text-muted-foreground">
          Anomaly flags and distributor warnings for your territory.
        </p>
      </header>
      <WarningSystem />
    </div>
  );
}
