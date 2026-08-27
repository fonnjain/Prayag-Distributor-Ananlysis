import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/data/auth-context";
import { useChangePassword } from "@/hooks/use-auth";

export default function ChangePasswordPage() {
  const { user, isLoading, refetchUser, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const changePassword = useChangePassword();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    } else if (user && !user.mustChangePassword) {
      setLocation("/");
    }
  }, [isLoading, setLocation, user]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 10) {
      toast({ title: "Use at least 10 characters", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    try {
      await changePassword.mutateAsync(newPassword);
      const updatedUser = await refetchUser();
      if (!updatedUser || updatedUser.mustChangePassword) {
        throw new Error("Your password was updated, but your session could not be refreshed");
      }
      setLocation("/");
      toast({ title: "Password updated", description: "You can now use the application." });
    } catch (error: any) {
      toast({
        title: "Unable to update password",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  if (isLoading || !user) {
    return <div className="h-screen w-screen bg-muted/30" />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex flex-col items-center border-b border-border/40 p-8 pb-6">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KeyRound className="h-6 w-6" />
          </div>
          <h1 className="text-center text-xl font-semibold tracking-tight">Choose your password</h1>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            For your account security, choose a new password before continuing.
          </p>
        </div>
        <div className="mx-6 mt-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>You cannot use the application until this password is changed.</span>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5 p-8 pt-5">
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">Use at least 10 characters and do not reuse the supplied password.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-new-password">Confirm new password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
              className="h-10"
            />
          </div>
          <Button
            type="submit"
            className="h-10 w-full"
            disabled={changePassword.isPending || newPassword.length < 10 || confirmPassword.length < 10}
          >
            {changePassword.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update password
          </Button>
          <Button type="button" variant="ghost" className="h-9 w-full" onClick={() => void logout()}>
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}