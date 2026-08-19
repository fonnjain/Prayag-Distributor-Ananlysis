import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/data/auth-context";
import { Loader2, AlertCircle } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const { user, refetchUser } = useAuth();

  const sessionEnded = new URLSearchParams(search).get("reason") === "session_ended";

  useEffect(() => {
    if (user) {
      setLocation("/");
    }
  }, [user, setLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Login failed" }));
        throw new Error(data.error || data.message || "Invalid credentials");
      }

      const signedInUser = await refetchUser();
      if (!signedInUser) throw new Error("Unable to establish a session");
      setLocation("/");
    } catch (err: any) {
      toast({
        title: "Login failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-8 pb-6 flex flex-col items-center border-b border-border/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground text-xl mb-4 select-none">
            P
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-center">Prayag India</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">Sign in to your account</p>
        </div>
        {sessionEnded && (
          <div className="mx-6 mt-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>Your session has ended. Please sign in again to continue.</span>
          </div>
        )}
        <div className="p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="h-10"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-10 mt-2"
              disabled={isSubmitting || !email || !password}
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
