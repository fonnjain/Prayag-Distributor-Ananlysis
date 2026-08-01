import { Loader2 } from "lucide-react";

/**
 * Shared loading placeholder for dashboards: spinner circle + message.
 * Shown while data for the selected FY / period is being fetched — figures
 * must never render until the correct data is available.
 */
export function LoadingState({
  label = "Data loading…",
  className = "py-12",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center gap-2 text-sm text-muted-foreground ${className}`}
      role="status"
      data-testid="loading-state"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}
