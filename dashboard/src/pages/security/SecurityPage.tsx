import { PageHeader } from '@/components/common';
import { ApiKeysCard } from '@/components/security/ApiKeysCard';
import { MfaCard } from '@/components/security/MfaCard';

/** /settings/security — two-factor authentication and API keys. */
export function SecurityPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Security" description="Two-factor authentication and API keys for your account." />
      <MfaCard />
      <ApiKeysCard />
    </div>
  );
}
