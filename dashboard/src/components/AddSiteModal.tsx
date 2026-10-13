import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { Site } from '../api/types';
import { useAuth } from '../hooks/auth';
import { displayText } from '../lib/safety';
import { installSnippet, snippetOrigin } from '../lib/snippet';
import { DomainsInput } from './DomainsInput';
import { CodeBlock, Modal } from './ui';

export function AddSiteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (site: Site) => void }) {
  const { config } = useAuth();
  const [name, setName] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Site | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name.');
    if (domains.length === 0) return setError('Add at least one domain.');
    setBusy(true);
    setError(null);
    try {
      const site = await api.createSite({ name: name.trim(), domains });
      setCreated(site);
      onCreated(site);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const origin = snippetOrigin(config?.publicUrl, window.location.origin);
    return (
      <Modal
        title="Site added"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <Link to={`/sites/${encodeURIComponent(created.id)}`} className="btn btn-primary" onClick={onClose}>
              Open dashboard
            </Link>
          </>
        }
      >
        <p>
          Add this snippet to the <code>&lt;head&gt;</code> of every page of <strong className="bidi-isolate">{displayText(created.name)}</strong>:
        </p>
        <CodeBlock code={installSnippet(origin, created.id)} />
        <p className="muted">Data appears within seconds after the first visit.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add site"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-site-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add site'}
          </button>
        </>
      }
    >
      <form id="add-site-form" onSubmit={onSubmit} className="form">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={100}
            required
            placeholder="My website"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <DomainsInput value={domains} onChange={setDomains} />
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
