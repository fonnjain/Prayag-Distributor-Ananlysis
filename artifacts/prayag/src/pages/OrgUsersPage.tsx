import { useState } from "react";
import {
  Search,
  Plus,
  MoreHorizontal,
  Loader2,
  Shield,
  ShieldAlert,
  UserCheck,
  UserX,
  KeyRound,
  Edit2
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";

import {
  useUsers,
  useCreateUser,
  useUpdateUser,
  useDeactivateUser,
  useReactivateUser,
  useResetPassword,
  type ManagedUser
} from "@/hooks/use-auth";
import { useAuth } from "@/data/auth-context";

export default function OrgUsersPage() {
  const { toast } = useToast();
  const { user: currentUser, logout } = useAuth();

  // Filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [role, setRole] = useState("all");

  const { data, isLoading, isError } = useUsers({ q, status, role });
  const users = data?.users || [];

  // Dialogs state
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [resetPassUser, setResetPassUser] = useState<ManagedUser | null>(null);
  const [statusUser, setStatusUser] = useState<ManagedUser | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  
  // Forms state
  const [formData, setFormData] = useState({ email: "", displayName: "", role: "normal", password: "" });
  
  // Mutations
  const createMut = useCreateUser();
  const updateMut = useUpdateUser();
  const deactivateMut = useDeactivateUser();
  const reactivateMut = useReactivateUser();
  const resetPassMut = useResetPassword();

  const handleCreateOpen = () => {
    setFormData({ email: "", displayName: "", role: "normal", password: "" });
    setConfirmPassword("");
    setCreateOpen(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    try {
      await createMut.mutateAsync(formData);
      toast({ title: "User created" });
      setCreateOpen(false);
    } catch (err: any) {
      toast({ title: "Failed to create user", description: err.message, variant: "destructive" });
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    try {
      await updateMut.mutateAsync({
        id: editUser.id,
        displayName: formData.displayName,
        role: formData.role
      });
      toast({ title: "User updated" });
      setEditUser(null);
      if (editUser.id === currentUser?.id && formData.role === "normal") {
        await logout();
      }
    } catch (err: any) {
      toast({ title: "Failed to update user", description: err.message, variant: "destructive" });
    }
  };

  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPassUser) return;
    if (formData.password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    try {
      await resetPassMut.mutateAsync({ id: resetPassUser.id, password: formData.password });
      toast({ title: "Password reset successful" });
      setResetPassUser(null);
      if (resetPassUser.id === currentUser?.id) {
        await logout();
      }
    } catch (err: any) {
      toast({ title: "Failed to reset password", description: err.message, variant: "destructive" });
    }
  };

  const handleToggleActive = async () => {
    if (!statusUser) return;
    try {
      if (statusUser.isActive) {
        await deactivateMut.mutateAsync(statusUser.id);
        toast({ title: "User deactivated" });
      } else {
        await reactivateMut.mutateAsync(statusUser.id);
        toast({ title: "User reactivated" });
      }
      const signedOutSelf = statusUser.isActive && statusUser.id === currentUser?.id;
      setStatusUser(null);
      if (signedOutSelf) await logout();
    } catch (err: any) {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-6 py-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-lg font-semibold">User Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage application access and administrator privileges.
          </p>
        </div>
        <Button onClick={handleCreateOpen} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add User
        </Button>
      </div>

      <div className="p-4 border-b flex items-center gap-3 shrink-0 bg-muted/20">
        <div className="relative w-64 shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="admin">Administrator</SelectItem>
            <SelectItem value="normal">Normal User</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10 shadow-sm">
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && isError && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-destructive">
                  Failed to load users.
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && users.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  No users found.
                </TableCell>
              </TableRow>
            )}
            {!isLoading && users.map((u) => (
              <TableRow key={u.id} className={cn(!u.isActive && "opacity-60")}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium text-sm">{u.displayName}</span>
                    <span className="text-xs text-muted-foreground">{u.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  {u.role === 'admin' ? (
                    <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/20">
                      <ShieldAlert className="h-3 w-3 mr-1" /> Admin
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      <Shield className="h-3 w-3 mr-1" /> Normal
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground bg-muted">
                      Deactivated
                    </Badge>
                  )}
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                    <Badge variant="destructive" className="ml-2">Locked</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Intl.DateTimeFormat("en-IN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(u.createdAt))}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setFormData({ email: u.email, displayName: u.displayName, role: u.role, password: "" });
                          setEditUser(u);
                        }}
                      >
                        <Edit2 className="h-4 w-4 mr-2" /> Edit Details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setFormData({ email: "", displayName: "", role: "normal", password: "" });
                          setConfirmPassword("");
                          setResetPassUser(u);
                        }}
                      >
                        <KeyRound className="h-4 w-4 mr-2" /> Reset Password
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setStatusUser(u)}
                        className={u.isActive ? "text-destructive" : "text-emerald-600"}
                      >
                        {u.isActive ? (
                          <><UserX className="h-4 w-4 mr-2" /> Deactivate</>
                        ) : (
                          <><UserCheck className="h-4 w-4 mr-2" /> Reactivate</>
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form onSubmit={handleCreateSubmit}>
            <DialogHeader>
              <DialogTitle>Add New User</DialogTitle>
              <DialogDescription>Create a new system user account.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="c-email">Email</Label>
                <Input
                  id="c-email"
                  type="email"
                  required
                  value={formData.email}
                  onChange={e => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="c-name">Display Name</Label>
                <Input
                  id="c-name"
                  required
                  value={formData.displayName}
                  onChange={e => setFormData({ ...formData, displayName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={formData.role} onValueChange={v => setFormData({ ...formData, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal User</SelectItem>
                    <SelectItem value="admin">Administrator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="c-pass">Initial Password</Label>
                <Input
                  id="c-pass"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Use at least 10 characters.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="c-pass-confirm">Confirm Password</Label>
                <Input
                  id="c-pass-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent>
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>Edit User Details</DialogTitle>
              <DialogDescription>Update info for {editUser?.email}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="e-name">Display Name</Label>
                <Input
                  id="e-name"
                  required
                  value={formData.displayName}
                  onChange={e => setFormData({ ...formData, displayName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={formData.role} onValueChange={v => setFormData({ ...formData, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal User</SelectItem>
                    <SelectItem value="admin">Administrator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>
                {updateMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetPassUser} onOpenChange={(open) => !open && setResetPassUser(null)}>
        <DialogContent>
          <form onSubmit={handleResetPasswordSubmit}>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={resetPassUser?.email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <DialogHeader>
              <DialogTitle>Reset Password</DialogTitle>
              <DialogDescription>Set a new password for {resetPassUser?.email}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="r-pass">New Password</Label>
                <Input
                  id="r-pass"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Use at least 10 characters. All existing sessions will be signed out.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="r-pass-confirm">Confirm New Password</Label>
                <Input
                  id="r-pass-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetPassUser(null)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={resetPassMut.isPending}>
                {resetPassMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Reset Password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Status confirmation */}
      <Dialog open={!!statusUser} onOpenChange={(open) => !open && setStatusUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statusUser?.isActive ? "Deactivate user?" : "Reactivate user?"}</DialogTitle>
            <DialogDescription>
              {statusUser?.isActive
                ? `${statusUser.displayName} will immediately lose access and all active sessions will be revoked. Audit history will be retained.`
                : `${statusUser?.displayName ?? "This user"} will be allowed to sign in again with their existing password.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStatusUser(null)}>Cancel</Button>
            <Button
              type="button"
              variant={statusUser?.isActive ? "destructive" : "default"}
              disabled={deactivateMut.isPending || reactivateMut.isPending}
              onClick={handleToggleActive}
            >
              {(deactivateMut.isPending || reactivateMut.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {statusUser?.isActive ? "Deactivate User" : "Reactivate User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
