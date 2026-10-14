import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRoundIcon, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { ROLES, type Role, type User } from '@/api/types';
import { FormMessage, PasswordField } from '@/components/AuthCard';
import { CopyButton, EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/common';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ROLE_LABELS, roleLabel, useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { formatDate } from '@/lib/format';
import { MAX_PASSWORD, MIN_PASSWORD, generatePassword, validateNewPassword } from '@/lib/password';
import { displayText } from '@/lib/safety';

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'viewer' || v === 'member';
}

export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="bidi-isolate">{displayText(user.email)}</span>
            <Badge variant="secondary">{roleLabel(user.role)}</Badge>
          </span>
        }
      />
      <ChangePassword />
      {user.role === 'admin' ? <UsersSection me={user} /> : null}
      {user.role === 'member' ? <DeleteAccount /> : null}
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateNewPassword(next, confirm);
    if (err) return setMessage({ kind: 'error', text: err });
    setBusy(true);
    setMessage(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ kind: 'ok', text: 'Password changed. Other sessions were logged out and all API keys were revoked.' });
    } catch (e2) {
      setMessage({ kind: 'error', text: errorMessage(e2) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Changing your password signs out your other sessions and revokes all your API keys.</CardDescription>
        </CardHeader>
        <CardContent className="flex max-w-sm flex-col gap-4">
          <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <PasswordField
            label="New password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            hint={`At least ${MIN_PASSWORD} characters.`}
          />
          <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD} />
          {message ? <FormMessage kind={message.kind}>{message.text}</FormMessage> : null}
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={busy}>
            <KeyRoundIcon aria-hidden="true" />
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Roles an admin can assign: hosted mode has no viewers (sign-ups are members). */
function useAssignableRoles(current?: Role): readonly Role[] {
  const { publicConfig } = useAuth();
  const roles = publicConfig.signupEnabled ? ROLES.filter((r) => r !== 'viewer') : ROLES;
  return current && !roles.includes(current) ? [...roles, current] : roles;
}

function RoleSelect({ value, onChange, disabled, label, size = 'default' }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string; size?: 'sm' | 'default' }) {
  const roles = useAssignableRoles(value);
  const hosted = useAuth().publicConfig.signupEnabled;
  return (
    <Select<Role> value={value} onValueChange={(v) => (isRole(v) ? onChange(v) : undefined)} disabled={disabled}>
      <SelectTrigger size={size} aria-label={label} className="w-28">
        <SelectValue>{(v: Role) => roleLabel(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {roles.map((r) => (
          <SelectItem key={r} value={r} disabled={hosted && r === 'viewer'}>
            {ROLE_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UsersSection({ me }: { me: User }) {
  const { publicConfig } = useAuth();
  const { data: users, error, loading, reload } = useApi((signal) => api.listUsers(signal), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const changeRole = async (u: User, role: Role) => {
    if (role === u.role) return;
    setBusyId(u.id);
    setActionError(null);
    try {
      await api.updateUser(u.id, { role });
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (u: User) => {
    setBusyId(u.id);
    setActionError(null);
    try {
      await api.deleteUser(u.id);
      setDeleting(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
      setDeleting(null);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>Users</CardTitle>
        <CardDescription>
          Admins manage all sites and users.{' '}
          {publicConfig.signupEnabled ? '' : 'Viewers can see all sites and statistics. '}Members are self-service accounts that
          only see and manage their own sites. Changing a user&apos;s role signs that user out.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !users ? (
          <SkeletonRows rows={3} className="px-4 pb-4" />
        ) : !users || users.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Email</TableHead>
                <TableHead className="w-32">Role</TableHead>
                <TableHead className="hidden w-32 sm:table-cell">Created</TableHead>
                <TableHead className="w-24 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const self = u.id === me.id;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="max-w-0 pl-4">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="bidi-isolate truncate" title={u.email}>
                          {displayText(u.email)}
                        </span>
                        {self ? <Badge variant="secondary">You</Badge> : null}
                        {u.emailVerified === false ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            Unverified
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <RoleSelect
                        size="sm"
                        value={u.role}
                        disabled={busyId === u.id || self}
                        label={`Role of ${u.email}`}
                        onChange={(r) => void changeRole(u, r)}
                      />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={self || busyId === u.id}
                        title={self ? 'You cannot delete yourself' : undefined}
                        onClick={() => setDeleting(u)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {actionError ? <FormMessage className="px-4 pt-2">{actionError}</FormMessage> : null}
      </CardContent>
      <AddUserForm onCreated={reload} />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => (o ? undefined : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong className="bidi-isolate break-all text-foreground">{deleting ? displayText(deleting.email) : ''}</strong>?
              They will be logged out immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={!deleting || busyId === deleting.id} onClick={() => deleting && void doDelete(deleting)}>
              Delete user
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function AddUserForm({ onCreated }: { onCreated: () => void }) {
  const { publicConfig } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(publicConfig.signupEnabled ? 'member' : 'viewer');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const emailId = useId();
  const passwordId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateNewPassword(password);
    if (err) return setMessage({ kind: 'error', text: err });
    setBusy(true);
    setMessage(null);
    try {
      const u = await api.createUser({ email: email.trim(), password, role });
      setMessage({ kind: 'ok', text: `Added ${displayText(u.email)}. Share the password with them securely.` });
      setEmail('');
      setPassword('');
      setShow(false);
      onCreated();
    } catch (e2) {
      setMessage({ kind: 'error', text: errorMessage(e2) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 border-t bg-muted/30 p-4">
      <h3 className="text-sm font-medium">Add user</h3>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input id={emailId} type="email" required maxLength={254} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} className="bg-background" />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Role</Label>
          <RoleSelect value={role} onChange={setRole} label="Role of the new user" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={passwordId}>Password</Label>
          <div className="flex gap-2">
            <Input
              id={passwordId}
              type={show ? 'text' : 'password'}
              required
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-background"
            />
            <Button
              type="button"
              variant="outline"
              className="bg-background"
              onClick={() => {
                setPassword(generatePassword());
                setShow(true);
              }}
            >
              Generate
            </Button>
          </div>
          {show && password ? <CopyButton text={password} label="Copy password" className="self-start" /> : null}
        </div>
      </div>
      {message ? <FormMessage kind={message.kind}>{message.text}</FormMessage> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          <UserPlusIcon aria-hidden="true" />
          {busy ? 'Adding…' : 'Add user'}
        </Button>
      </div>
    </form>
  );
}

function DeleteAccount() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmId = useId();
  const ready = password.length > 0 && confirm.trim().toUpperCase() === 'DELETE';

  const close = () => {
    setOpen(false);
    setPassword('');
    setConfirm('');
    setError(null);
  };

  const onDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      setUser(null);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          Permanently deletes your account, all your sites and their analytics data, and cancels your subscription. This cannot be
          undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          <Trash2Icon aria-hidden="true" />
          Delete account
        </Button>
      </CardContent>
      <AlertDialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <AlertDialogContent>
          <form onSubmit={onDelete} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                All sites and data are deleted immediately and your subscription is cancelled. Enter your password to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
            <div className="flex flex-col gap-2">
              <Label htmlFor={confirmId}>
                Type <strong>DELETE</strong> to confirm
              </Label>
              <Input id={confirmId} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={busy || !ready}>
                {busy ? 'Deleting…' : 'Delete account'}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
