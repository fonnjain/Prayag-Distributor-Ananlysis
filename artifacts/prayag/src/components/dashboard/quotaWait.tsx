// Shared helpers for the Google Sheets read-quota (503 { quota: true }) wait
// state. Pattern reference: SecondaryPerformanceDashboard.tsx (task 76).
import { Info } from "lucide-react";

/** Clamp the server's retryAfter hint to a sane 5–60s window, in ms. */
export function quotaDelayMs(retryAfter?: number): number {
  return Math.min(60, Math.max(5, retryAfter ?? 30)) * 1000;
}

/**
 * Inspect a non-OK response. Returns `{ retryAfter }` when the server signals
 * the Sheets quota window (503 + { quota: true }); otherwise throws an Error
 * with the server's message. Returns null for OK responses.
 */
export async function quotaOrThrow(
  r: Response,
): Promise<{ retryAfter: number } | null> {
  if (r.ok) return null;
  let j: { error?: string; quota?: boolean; retryAfter?: number } = {};
  try {
    j = await r.json();
  } catch {
    // Non-JSON error body — fall through to generic error.
  }
  if (r.status === 503 && j.quota) return { retryAfter: j.retryAfter ?? 30 };
  throw new Error(j.error ?? `HTTP ${r.status}`);
}

/** Amber "your data is loading" notice shown while waiting out the quota window. */
export function QuotaWaitBanner({ testId }: { testId: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
      data-testid={testId}
    >
      <Info className="h-4 w-4 mt-0.5 shrink-0" />
      <span>
        Your data is loading — Google briefly limits how fast sheets can be
        read. This resolves itself within a minute; this page will retry
        automatically.
      </span>
    </div>
  );
}
