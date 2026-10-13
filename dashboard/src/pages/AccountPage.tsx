import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import type { Role, User } from '../api/types';
import { CopyButton, EmptyState, ErrorState, Modal, SkeletonRows } from '../components/ui';
import { useAuth } from '../hooks/auth';
import { useApi } from '../hooks/useApi';
import { formatDate } from '../lib/format';
import { MAX_PASSWORD, MIN_PASSWORD, generatePassword, validateNewPassword } from '../lib/password';
import { displayText } from '../lib/safety';

export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="page settings">
      <div className="page-header">
        <div>
          <h1 className="page-title">Account</h1>
          <p className="muted">
            {user.email} · {user.role === 'admin' ? 'Admin' : 'Viewer'}
          </p>
        </div>
      </div>
      <ChangePassword />
      {user.role === 'admin' ? <UsersSection me={user} /> : null}
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
      setMessage({ kind: 'ok', text: 'Password changed. Other sessions were logged out.' });
    } catch (e2) {
      setMessage({ kind: 'error', text: errorMessage(e2) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card section">
      <h2 className="section-title">Change password</h2>
      <form className="form form-narrow" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            maxLength={MAX_PASSWORD}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            maxLength={MAX_PASSWORD}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <span className="field-help muted">At least {MIN_PASSWORD} characters.</span>
        </label>
        <label className="field">
          <span className="field-label">Confirm new password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            maxLength={MAX_PASSWORD}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {message ? (
          <div className={message.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
            {message.text}
          </div>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}

function UsersSection({ me }: { me: User }) {
  const { data: users, error, loading, reload } = useApi((signal) => api.listUsers(signal), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const changeRole = async (u: User, role: Role) => {
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
    <section className="card section">
      <h2 className="section-title">Users</h2>
      <p className="muted small">Admins can manage sites and users. Viewers can see all sites and statistics.</p>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !users ? (
        <SkeletonRows rows={3} />
      ) : !users || users.length === 0 ? (
        <EmptyState title="No users" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col" className="hide-sm">
                  Created
                </th>
                <th scope="col" className="num">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id}>
                    <td className="cell-email">
                      <span className="cell-email-inner">
                        <span className="truncate bidi-isolate" title={u.email}>
                          {displayText(u.email)}
                        </span>
                        {self ? <span className="badge badge-none">You</span> : null}
                      </span>
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`role-${u.id}`}>
                        Role of {u.email}
                      </label>
                      <select
                        id={`role-${u.id}`}
                        className="select select-sm"
                        value={u.role}
                        disabled={busyId === u.id || self}
                        title={self ? 'You cannot change your own role' : undefined}
                        onChange={(e) => void changeRole(u, e.target.value as Role)}
                      >
                        <option value="admin">Admin</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="nowrap hide-sm">{formatDate(u.createdAt)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-ghost"
                        disabled={self || busyId === u.id}
                        title={self ? 'You cannot delete yourself' : undefined}
                        onClick={() => setDeleting(u)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {actionError ? (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      ) : null}

      <AddUserForm onCreated={reload} />

      {deleting ? (
        <Modal
          title="Delete user"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busyId === deleting.id}
                onClick={() => void doDelete(deleting)}
              >
                Delete user
              </button>
            </>
          }
        >
          <p>
            Delete <strong className="break-all">{deleting.email}</strong>? They will be logged out immediately.
          </p>
        </Modal>
      ) : null}
    </section>
  );
}

function AddUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateNewPassword(password);
    if (err) return setMessage({ kind: 'error', text: err });
    setBusy(true);
    setMessage(null);
    try {
      const u = await api.createUser({ email: email.trim(), password, role });
      setMessage({ kind: 'ok', text: `Added ${u.email}. Share the password with them securely.` });
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
    <form className="form add-user" onSubmit={onSubmit}>
      <h3 className="subsection-title">Add user</h3>
      <div className="add-user-grid">
        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div className="field">
          <label className="field-label" htmlFor="new-user-password">
            Password
          </label>
          <div className="input-group">
            <input
              id="new-user-password"
              className="input"
              type={show ? 'text' : 'password'}
              required
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPassword(generatePassword());
                setShow(true);
              }}
            >
              Generate
            </button>
            {show && password ? <CopyButton text={password} /> : null}
          </div>
        </div>
      </div>
      {message ? (
        <div className={message.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
          {message.text}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add user'}
        </button>
      </div>
    </form>
  );
}
