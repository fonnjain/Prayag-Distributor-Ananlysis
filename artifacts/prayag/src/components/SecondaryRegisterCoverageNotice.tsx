import { AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { SecondaryRegisterCoverage } from "@/lib/secondaryRegisterCoverage";

export function SecondaryRegisterCoverageNotice({
  coverage,
  className,
}: {
  coverage: SecondaryRegisterCoverage;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200",
        className,
      )}
      data-testid="secondary-register-coverage-notice"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p>{coverage.message}</p>
          <p className="text-[10px] text-amber-800/80 dark:text-amber-300/80">
            Status: <strong>{coverage.status}</strong> · Owner: <strong>{coverage.owner}</strong>{" "}
            ·{" "}
            <Link
              href={coverage.resolutionUrl}
              className="font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              Resolution {coverage.code}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default SecondaryRegisterCoverageNotice;