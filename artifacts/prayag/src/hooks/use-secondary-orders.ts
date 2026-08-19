import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SecondaryOrderRow {
  orderId: string;
  orderDatetime: string;
  orderStatus: string;
  salesUserName: string;
  salesUserId: string;
  customerName: string;
  dealerId: string;
  dealerMobile: string;
  cpName: string;
  cpCode: string;
  state: string;
  district: string;
  city: string;
  pincode: string;
  categoryName: string;
  segmentCanon: string;
  productCode: string;
  gstPct: number;
  gstAmount: number;
  qty: number;
  discountPct: number;
  discountAmount: number;
  dealerOrderValue: number;
  basicOrderValue: number;
}

export interface SecondaryOrdersResponse {
  basis: {
    measure: string;
    value: string;
    disclaimer: string;
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
    totalQty: number;
    totalBasicValue: number;
    status: {
      status: string;
      lines: number;
      orders: number;
      basicValue: number;
    }[];
  };
  rows: SecondaryOrderRow[];
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
  filters: {
    stateHeads: { id: string; name: string }[];
    states: string[];
    distributors: { id: string; name: string }[];
    retailers: { id: string; name: string }[];
    statuses: string[];
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
  page?: number;
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
      if (params.page !== undefined) search.set("page", String(params.page));
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
