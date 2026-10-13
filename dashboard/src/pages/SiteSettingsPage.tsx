import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { DomainsInput } from '../components/DomainsInput';
import { CodeBlock, Modal } from '../components/ui';
import { useAuth, useIsAdmin } from '../hooks/auth';
import {
  DECLARATIVE_EXAMPLE,
  IGNORE_SNIPPET,
  QUEUE_SNIPPET,
  QUEUE_TRACK_EXAMPLE,
  TRACK_EXAMPLE,
  installSnippet,
  snippetOrigin,
} from '../lib/snippet';
import { displayText } from '../lib/safety';
import { useSite } from './SiteLayout';

export function SiteSettingsPage() {
  const { site, reloadSites } = useSite();
  const { config } = useAuth();
  const isAdmin = useIsAdmin();
  const origin = snippetOrigin(config?.publicUrl, window.location.origin);

  return (
    <div className="settings">
      <GeneralSettings key={site.id} readOnly={!isAdmin} onSaved={reloadSites} />

      <section className="card section">
        <h2 className="section-title">Install</h2>
        <p>
          Add this line to the <code>&lt;head&gt;</code> of every page you want to track:
        </p>
        <CodeBlock code={installSnippet(origin, site.id)} />
        <p className="muted small">
          Site ID: <code>{site.id}</code>. Page views (including single-page-app navigations) and Speed Insights are
          collected automatically. Visits are only accepted from the domains listed above.
        </p>
      </section>

      <section className="card section">
        <h2 className="section-title">Custom events</h2>
        <p>Track conversions and other interactions from JavaScript:</p>
        <CodeBlock code={TRACK_EXAMPLE} />
        <p>
          To call <code>pa</code> before the script has loaded, add this queue snippet above the script tag — queued
          calls are sent once it loads:
        </p>
        <CodeBlock code={QUEUE_SNIPPET} />
        <CodeBlock code={QUEUE_TRACK_EXAMPLE} />
        <p>
          Or track clicks without JavaScript using data attributes (<code>data-pa-event-*</code> attributes become
          properties):
        </p>
        <CodeBlock code={DECLARATIVE_EXAMPLE} />
      </section>

      <section className="card section">
        <h2 className="section-title">Exclude your own visits</h2>
        <p>
          Open your website, open the browser console (developer tools) and run the following. The script then ignores
          visits from this browser on that site:
        </p>
        <CodeBlock code={IGNORE_SNIPPET} />
        <p className="muted small">
          Use <code>localStorage.removeItem('pa_ignore')</code> to be counted again.
        </p>
      </section>

      {isAdmin ? <DangerZone /> : null}
    </div>
  );
}

function GeneralSettings({ readOnly, onSaved }: { readOnly: boolean; onSaved: () => void }) {
  const { site } = useSite();
  const [name, setName] = useState(site.name);
  const [domains, setDomains] = useState<string[]>(site.domains);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setName(site.name);
    setDomains(site.domains);
  }, [site.name, site.domains]);

  const dirty = name.trim() !== site.name || domains.join('\n') !== site.domains.join('\n');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setMessage({ kind: 'error', text: 'Enter a name.' });
    if (domains.length === 0) return setMessage({ kind: 'error', text: 'Add at least one domain.' });
    setBusy(true);
    setMessage(null);
    try {
      await api.updateSite(site.id, { name: name.trim(), domains });
      setMessage({ kind: 'ok', text: 'Saved.' });
      onSaved();
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card section">
      <h2 className="section-title">General</h2>
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={100}
            required
            readOnly={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <DomainsInput value={domains} onChange={setDomains} disabled={readOnly} />
        {message ? (
          <div className={message.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
            {message.text}
          </div>
        ) : null}
        {readOnly ? (
          <p className="muted small">Only admins can change site settings.</p>
        ) : (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function DangerZone() {
  const { site, reloadSites } = useSite();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  // Accept the name as displayed (control/bidi characters replaced) or the raw name.
  const confirmed = confirm === site.name || confirm === displayText(site.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSite(site.id);
      reloadSites();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <section className="card section danger">
      <h2 className="section-title">Danger zone</h2>
      <div className="danger-row">
        <div>
          <strong>Delete this site</strong>
          <p className="muted small">Permanently deletes the site and all its analytics and Speed Insights data.</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete site
        </button>
      </div>
      {open ? (
        <Modal
          title="Delete site"
          onClose={() => {
            setOpen(false);
            setConfirm('');
          }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={busy || !confirmed} onClick={onDelete}>
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </>
          }
        >
          <p>
            This deletes <strong className="break-all bidi-isolate">{displayText(site.name)}</strong> and all of its data. This cannot be undone.
          </p>
          <label className="field">
            <span className="field-label">
              Type <strong className="break-all bidi-isolate">{displayText(site.name)}</strong> to confirm
            </span>
            <input
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
