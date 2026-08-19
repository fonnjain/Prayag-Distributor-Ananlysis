import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuthMe, type AuthUser } from "@/hooks/use-auth";

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  logout: () => Promise<void>;
  refetchUser: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: user, isLoading, refetch } = useAuthMe();
  const qc = useQueryClient();
  const [location, setLocation] = useLocation();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // Track whether the user was previously authenticated so we can distinguish
  // a background session revocation from a fresh (never-logged-in) page load.
  const hadUserRef = useRef(false);

  const logout = async () => {
    try {
      setIsLoggingOut(true);
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (e) {
      // Local logout still completes if the network is unavailable. The
      // server-side session expires independently and no credential is logged.
    } finally {
      hadUserRef.current = false;
      qc.clear();
      qc.setQueryData(["auth-me"], null);
      setIsLoggingOut(false);
      setLocation("/login");
    }
  };

  useEffect(() => {
    if (isLoading) return;

    if (user) {
      // Record that we have a live session.
      hadUserRef.current = true;
      return;
    }

    // user is null and loading is done — we are unauthenticated.
    if (location === "/login") return;

    if (hadUserRef.current && !isLoggingOut) {
      // The polling detected a revoked session (password reset or deactivation).
      // Redirect with a reason so the login page can show a contextual notice.
      hadUserRef.current = false;
      setLocation("/login?reason=session_ended");
    } else {
      setLocation("/login");
    }
  }, [isLoading, user, location, isLoggingOut, setLocation]);

  return (
    <AuthContext.Provider value={{
      user: user ?? null,
      isLoading: isLoading || isLoggingOut,
      logout,
      refetchUser: async () => (await refetch()).data ?? null,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
