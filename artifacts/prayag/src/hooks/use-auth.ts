import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'normal';
  isActive: boolean;
}

export interface ManagedUser extends AuthUser {
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  lockedUntil: string | null;
}

const BASE = "/api/auth";

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!r.ok) {
    if (r.status === 401) {
      throw new Error("Unauthorized");
    }
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(body.error || body.message || `HTTP ${r.status}`);
  }
  if (r.status === 204) return {} as T;
  return r.json() as Promise<T>;
}

export function useAuthMe() {
  return useQuery<AuthUser | null>({
    queryKey: ["auth-me"],
    queryFn: async () => {
      try {
        const response = await fetchJson<{ user: AuthUser }>(`${BASE}/me`);
        return response.user;
      } catch (error) {
        if (error instanceof Error && error.message === "Unauthorized") return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 60 * 1000,
  });
}

export function useUsers(filters: { q?: string; status?: string; role?: string }) {
  return useQuery<{ users: ManagedUser[] }>({
    queryKey: ["auth-users", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.status && filters.status !== "all") params.set("status", filters.status);
      if (filters.role && filters.role !== "all") params.set("role", filters.role);
      return fetchJson(`${BASE}/users?${params.toString()}`);
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => fetchJson(`${BASE}/users`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; displayName?: string; role?: string }) =>
      fetchJson(`${BASE}/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-users"] }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => fetchJson(`${BASE}/users/${id}/deactivate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-users"] }),
  });
}

export function useReactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => fetchJson(`${BASE}/users/${id}/reactivate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-users"] }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      fetchJson(`${BASE}/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) }),
  });
}
