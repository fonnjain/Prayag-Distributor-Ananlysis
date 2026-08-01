// Cold-start snapshot freshness handling for GET /api/mgmt/data.
//
// On a production cold start the server serves the last persisted payload
// instantly with meta.snapshotSavedAt (unix ms) + meta.refreshing: true while
// a live rebuild runs in the background. This module gives every consumer of
// /api/mgmt/data the same two pieces:
//
//   - useSnapshotRefresh(meta, url, onFresh): while meta.refreshing is true,
//     silently re-fetches `url` every few seconds until the server returns a
//     payload without the refreshing flag, then hands that fresh payload to
//     onFresh (no loading spinner, no page blanking — figures just swap in).
//   - SnapshotBanner: subtle "Figures as of <time> — updating…" indicator.
//     Renders nothing when the data came from the live cache.
import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";

export type SnapshotMeta = {
  /** Unix ms of when the served payload was last built from live sources. */
  snapshotSavedAt?: number;
  /** True while a live rebuild is running in the background. */
  refreshing?: boolean;
};

const POLL_INTERVAL_MS = 8000; // background builds take ~20-30s on Sheets
const MAX_POLLS = 15; // give up after ~2 minutes; a manual reload still works

export function useSnapshotRefresh(
  meta: SnapshotMeta | null | undefined,
  url: string | null,
  onFresh: (payload: unknown) => void,
): void {
  // Keep the callback in a ref so the polling effect doesn't restart on every render.
  const onFreshRef = useRef(onFresh);
  onFreshRef.current = onFresh;

  const refreshing = meta?.refreshing === true;

  useEffect(() => {
    if (!refreshing || !url) return;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = () => {
      timer = setTimeout(() => {
        polls++;
        fetch(url)
          .then((r) => (r.ok ? (r.json() as Promise<{ meta?: SnapshotMeta }>) : null))
          .then((d) => {
            if (cancelled) return;
            if (d && d.meta?.refreshing !== true) {
              // Live figures arrived — swap them in silently.
              onFreshRef.current(d);
            } else if (polls < MAX_POLLS) {
              poll();
            }
          })
          .catch(() => {
            if (!cancelled && polls < MAX_POLLS) poll();
          });
      }, POLL_INTERVAL_MS);
    };
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshing, url]);
}

function fmtSavedAt(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}, ${time}`;
}

export function SnapshotBanner({ meta }: { meta: SnapshotMeta | null | undefined }) {
  if (meta?.refreshing !== true) return null;
  const savedAt = meta.snapshotSavedAt;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <RefreshCw className="h-3 w-3 shrink-0 animate-spin" style={{ animationDuration: "2.5s" }} />
      <span>
        {savedAt != null ? `Figures as of ${fmtSavedAt(savedAt)} — updating…` : "Figures updating…"}
      </span>
    </div>
  );
}
