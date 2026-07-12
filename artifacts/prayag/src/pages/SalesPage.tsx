import { useLocation } from "wouter";
import { useTheme } from "next-themes";
import { ArrowLeft, Sun, Moon } from "lucide-react";
import SalesPeople from "@/components/dashboard/SalesPeople";

export default function SalesPage() {
  const [, setLocation] = useLocation();
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 bg-card border-b border-border/50 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center justify-center w-8 h-8 rounded-md border border-border/50 hover:bg-muted transition-colors text-muted-foreground"
          aria-label="Back to dashboard"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold font-display text-lg select-none">
          P
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground text-xs">Prayag India</span>
            <span className="text-muted-foreground text-xs">/</span>
            <span className="font-semibold truncate">Sales</span>
          </div>
        </div>
        <button
          onClick={() => setTheme(isDark ? "light" : "dark")}
          className="flex items-center justify-center w-8 h-8 rounded-md border border-border/50 hover:bg-muted transition-colors text-muted-foreground"
          aria-label="Toggle dark mode"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
        <SalesPeople />
      </main>
    </div>
  );
}
