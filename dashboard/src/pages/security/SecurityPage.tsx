import { useState } from 'react';
import type { MfaStatus } from '@/api/security';
import { PageHeader } from '@/components/common';
import { ApiKeysCard } from '@/components/security/ApiKeysCard';
import { MfaCard } from '@/components/security/MfaCard';

/** /settings/security — two-factor authentication and API keys. */
export function SecurityPage() {
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  // Under REQUIRE_MFA_FOR_ADMINS every other endpoint answers 403 until enrolment is done.
  const enrolmentPending = mfa?.required === true && !mfa.enabled;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Security" description="Two-factor authentication and API keys for your account." />
      <MfaCard onStatus={setMfa} />
      {enrolmentPending ? null : <ApiKeysCard />}
    </div>
  );
}
