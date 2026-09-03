import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SecondaryOrderRow {
  id: number;
  sourceEra: string;
  sourceKind: string | null;
  fiscalYear: string | null;
  periodCompleteness: string | null;
  orderId: string;
  orderDatetime: string;
  orderStatus: string; // API maps null source values to the exact unavailable label.
  salesUserName: string | null; salesUserId: string | null; customerName: string | null;
  dealerId: string | null; dealerMobile: string | null; cpName: string | null; cpCode: string | null;
  state: string | null; district: string | null; city: string | null; pincode: string | null;
  categoryName: string | null; segmentCanon: string | null; productCode: string | null;
  gstPct: number | null; gstAmount: number | null; qty: number | null; discountPct: number | null;
  discountAmount: number | null; dealerOrderValue: number | null; basicOrderValue: number | null;
  occurrence: number;
  isExactDuplicateExport: boolean;
}

export interface SecondaryOrdersResponse {
  basis: {
    measure: string;
    value: string;
    disclaimer: string;
    mixedEraNote: string;
  };
  coverage: {
    from: string | null;
    to: string | null;
  };
  summary: {
    orders: number;
    lines: number;
    retailers: number;
    distributors: number;
    distributorNote: string;
    totalQty: number;
    totalBasicValue: number;
    status: {
      status: string;
      lines: number;
      orders: number;
      basicValue: number;
    }[];
  };
  fiscalYearSummaries: {
    fiscalYear: string;
    coverage: { from: string | null; to: string | null };
    orders: number;
    lines: number;
    retailers: number;
    distributors: number;
    distributorNote: string;
    totalQty: number;
    totalBasicValue: number;
    status: {
      status: string;
      lines: number;
      orders: number;
      basicValue: number;
    }[];
  }[];
  rows: SecondaryOrderRow[];
  pagination: {
    pageSize: number;
    totalRows: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  filters: {
    stateHeads: { id: string; name: string }[];
    states: string[];
    distributors: { id: string; name: string }[];
    retailers: { id: string; name: string }[];
    statuses: string[];
  };
  quality: {
    exactDuplicateExportRows: number;
    exactDuplicateQty: number;
    exactDuplicateBasicValue: number;
    exactDuplicateRateAlert: boolean;
  };
}

export interface SecondaryOrdersParams {
  stateHead?: string;
  state?: string;
  cpCode?: string;
  dealerId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  pageSize?: number;
}

export function useSecondaryOrders(params: SecondaryOrdersParams) {
  return useQuery<SecondaryOrdersResponse>({
    queryKey: ["secondary-orders", params],
    queryFn: async () => {
      const search = new URLSearchParams();
      if (params.stateHead) search.set("stateHead", params.stateHead);
      if (params.state) search.set("state", params.state);
      if (params.cpCode) search.set("cpCode", params.cpCode);
      if (params.dealerId) search.set("dealerId", params.dealerId);
      if (params.status) search.set("status", params.status);
      if (params.from) search.set("from", params.from);
      if (params.to) search.set("to", params.to);
      if (params.cursor) search.set("cursor", params.cursor);
      if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));

      const res = await fetch(`${BASE}/api/secondary-orders?${search.toString()}`);
      if (!res.ok) {
        throw new Error("Failed to fetch secondary orders");
      }
      return res.json();
    },
    // We do not want to automatically refetch when typing or changing filters quickly, 
    // but React Query will handle deduplication. We use placeholder data or keepPreviousData if available.
    placeholderData: (prev) => prev,
  });
}

export function useSecondaryOrderRetailers(searchText: string) {
  return useQuery<{ retailers: { dealerId: string; customerName: string | null }[] }>({
    queryKey: ["secondary-order-retailers", searchText],
    enabled: searchText.trim().length >= 2,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/secondary-orders/filters?retailerSearch=${encodeURIComponent(searchText)}&retailerLimit=50`);
      if (!res.ok) throw new Error("Failed to search retailers");
      return res.json();
    },
    staleTime: 30_000,
  });
}
