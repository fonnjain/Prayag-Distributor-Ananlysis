import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/data/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const IDLE_AFTER_MS = 5 * 60_000;
const HEARTBEAT_EVERY_MS = 60_000;
const FLUSH_AFTER_MS = 1_500;
const TAB_KEY = "prayag.activity-tab-id";

type EventKind = "page_view" | "heartbeat" | "action" | "session_end";
type ActivityState = "active" | "idle";

interface QueuedActivityEvent {
  clientEventId: string;
  kind: EventKind;
  path?: string;
  action?: string;
  state?: ActivityState;
}

function tabId(): string {
  const existing = window.sessionStorage.getItem(TAB_KEY);
  if (existing) return existing;
  const value = `tab-${crypto.randomUUID()}`;
  window.sessionStorage.setItem(TAB_KEY, value);
  return value;
}

function safePath(location: string): string {
  const path = location.split(/[?#]/, 1)[0] || "/";
  return path.startsWith("/") ? path.slice(0, 200) : "/";
}

/**
 * Records only page paths and explicit, safe action codes. It intentionally
 * never reads form values, typed keys, text content, cursor positions, or URLs'
 * query/hash parameters.
 */
export default function ActivityTelemetry() {
  const { user } = useAuth();
  const [location] = useLocation();
  const clientTabId = useRef<string | null>(null);
  const eventCounter = useRef(0);
  const queue = useRef<QueuedActivityEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const lastMeaningfulAt = useRef(Date.now());
  const currentPath = useRef(safePath(location));
  const currentState = useRef<ActivityState>("active");

  if (!clientTabId.current && typeof window !== "undefined") clientTabId.current = tabId();

  const flush = useCallback(async (keepalive = false) => {
    if (inFlight.current || queue.current.length === 0 || !clientTabId.current) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const events = queue.current.splice(0, 50);
    inFlight.current = true;
    try {
      const response = await fetch(`${BASE}/api/activity/events`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTabId: clientTabId.current, events }),
        keepalive,
      });
      if (!response.ok && !keepalive) queue.current.unshift(...events);
    } catch {
      if (!keepalive) queue.current.unshift(...events);
    } finally {
      inFlight.current = false;
      if (queue.current.length > 0 && !keepalive) {
        timer.current = setTimeout(() => void flush(), FLUSH_AFTER_MS);
      }
    }
  }, []);

  const record = useCallback((event: Omit<QueuedActivityEvent, "clientEventId">, immediate = false) => {
    eventCounter.current += 1;
    queue.current.push({
      ...event,
      clientEventId: `${Date.now().toString(36)}-${eventCounter.current.toString(36)}`,
    });
    if (immediate || queue.current.length >= 10) {
      void flush();
    } else if (!timer.current) {
      timer.current = setTimeout(() => void flush(), FLUSH_AFTER_MS);
    }
  }, [flush]);

  useEffect(() => {
    currentPath.current = safePath(location);
    if (!user) return;
    lastMeaningfulAt.current = Date.now();
    currentState.current = "active";
    record({ kind: "page_view", path: currentPath.current, state: "active" }, true);
  }, [location, record, user]);

  useEffect(() => {
    if (!user) return;

    const markMeaningful = () => {
      const wasIdle = currentState.current === "idle";
      lastMeaningfulAt.current = Date.now();
      currentState.current = "active";
      if (wasIdle) record({ kind: "heartbeat", path: currentPath.current, state: "active" }, true);
    };
    const recordAction = (event: MouseEvent) => {
      markMeaningful();
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-activity]") : null;
      const action = element?.dataset.activity;
      if (action && /^[a-z][a-z0-9_.:-]{0,99}$/.test(action)) {
        record({ kind: "action", path: currentPath.current, action, state: "active" }, true);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        markMeaningful();
      } else {
        currentState.current = "idle";
        record({ kind: "heartbeat", path: currentPath.current, state: "idle" }, true);
      }
    };
    const onPageHide = () => {
      record({ kind: "session_end", path: currentPath.current, state: "idle" });
      void flush(true);
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const state: ActivityState = Date.now() - lastMeaningfulAt.current < IDLE_AFTER_MS ? "active" : "idle";
      currentState.current = state;
      record({ kind: "heartbeat", path: currentPath.current, state }, true);
    }, HEARTBEAT_EVERY_MS);

    window.addEventListener("pointerdown", markMeaningful, { passive: true, capture: true });
    window.addEventListener("keydown", markMeaningful, { capture: true });
    window.addEventListener("scroll", markMeaningful, { passive: true, capture: true });
    window.addEventListener("touchstart", markMeaningful, { passive: true, capture: true });
    window.addEventListener("click", recordAction, { capture: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerdown", markMeaningful, true);
      window.removeEventListener("keydown", markMeaningful, true);
      window.removeEventListener("scroll", markMeaningful, true);
      window.removeEventListener("touchstart", markMeaningful, true);
      window.removeEventListener("click", recordAction, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      if (user) {
        record({ kind: "session_end", path: currentPath.current, state: "idle" });
        void flush(true);
      }
    };
  }, [flush, record, user]);

  return null;
}