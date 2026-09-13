export type ReportState<T> = {
  fy: string;
  memberKey: string;
  isCollapsed: boolean;
  report: T | null;
  loading: boolean;
  error: string | null;
  activeRequestId: number | null;
};

export type ReportAction<T> =
  | { type: "SET_PROPS"; fy: string; memberKey: string }
  | { type: "TOGGLE_COLLAPSE" }
  | { type: "GENERATE_START"; requestId: number }
  | { type: "GENERATE_SUCCESS"; requestId: number; report: T }
  | { type: "GENERATE_ERROR"; requestId: number; error: string };

export function reportReducer<T>(state: ReportState<T>, action: ReportAction<T>): ReportState<T> {
  switch (action.type) {
    case "SET_PROPS":
      if (state.fy !== action.fy || state.memberKey !== action.memberKey) {
        return {
          ...state,
          fy: action.fy,
          memberKey: action.memberKey,
          isCollapsed: true,
          report: null,
          error: null,
          loading: false,
          activeRequestId: null, // Invalidate any in-flight requests
        };
      }
      return state;

    case "TOGGLE_COLLAPSE":
      return { ...state, isCollapsed: !state.isCollapsed };

    case "GENERATE_START":
      return {
        ...state,
        loading: true,
        error: null,
        report: null,
        activeRequestId: action.requestId,
      };

    case "GENERATE_SUCCESS":
      if (state.activeRequestId !== action.requestId) return state;
      return {
        ...state,
        loading: false,
        report: action.report,
      };

    case "GENERATE_ERROR":
      if (state.activeRequestId !== action.requestId) return state;
      return {
        ...state,
        loading: false,
        error: action.error,
      };

    default:
      return state;
  }
}

export function deriveReportLayout<T>(state: ReportState<T>) {
  const hasReport = !!state.report;
  return {
    showPreGenActions: !hasReport,
    showPostGenHeader: hasReport,
    showGuardBadge: hasReport,
    showNarrative: hasReport && !state.isCollapsed,
  };
}
