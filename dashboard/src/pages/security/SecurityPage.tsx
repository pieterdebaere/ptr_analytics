import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from 'lucide-react';
import type { MfaStatus } from '@/api/security';
import { PageHeader } from '@/components/common';
import { ApiKeysCard } from '@/components/security/ApiKeysCard';
import { MfaCard } from '@/components/security/MfaCard';

/** /settings/security — two-factor authentication and API keys. */
export function SecurityPage() {
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const last = useRef<MfaStatus | null>(null);
  // Turning 2FA on or off revokes every API key: reload the list then.
  const [keysRev, setKeysRev] = useState(0);
  const onStatus = (s: MfaStatus) => {
    if (last.current && last.current.enabled !== s.enabled) setKeysRev((r) => r + 1);
    last.current = s;
    setMfa(s);
  };
  // Under REQUIRE_MFA_FOR_ADMINS every other endpoint answers 403 until enrolment is done.
  const enrolmentPending = mfa?.required === true && !mfa.enabled;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Account
        </Link>
        <PageHeader title="Security" description="Two-factor authentication and API keys for your account." />
      </div>
      <MfaCard onStatus={onStatus} />
      {enrolmentPending ? null : <ApiKeysCard mfaEnabled={mfa?.enabled ?? false} reloadKey={keysRev} />}
    </div>
  );
}
