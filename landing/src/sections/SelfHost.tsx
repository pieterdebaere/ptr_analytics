import { ArrowUpRight, Check } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CLONE_URL, LINKS, REPO_DIR } from '~/config';
import { CodeBlock } from '~/components/CodeBlock';
import { GitHubIcon } from '~/components/GitHubIcon';
import { LinkButton } from '~/components/LinkButton';
import { Container, Section, SectionHeading } from '~/components/Section';

const CADDY = `analytics.example.com {
    reverse_proxy 127.0.0.1:3000
}`;

const NGINX = `server {
    listen 443 ssl;
    http2 on;
    server_name analytics.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;

const REQUIREMENTS = [
  'One container, SQLite included — no external database',
  'Hardened container: read-only, no capabilities, 512 MB limit',
  'Optional automatic GeoIP downloads (DB-IP Lite)',
  'Back up with a single command, restore by copying one file',
  'Same code as the hosted service — switch any time',
] as const;

const STEPS = [
  {
    title: 'Clone the repository',
    text: 'You need a server with Docker (any small VPS will do) and a domain name for the dashboard.',
    block: { title: 'bash', prompt: true, code: `git clone ${CLONE_URL}\ncd ${REPO_DIR}\ncp .env.example .env` },
  },
  {
    title: 'Configure',
    text: 'Set the public URL and the first admin account. Remove the two ADMIN_ lines again after the first start.',
    block: {
      title: '.env',
      prompt: false,
      code: 'PUBLIC_URL=https://analytics.example.com\nADMIN_EMAIL=you@example.com\n# e.g. openssl rand -base64 24\nADMIN_PASSWORD=a-long-random-password',
    },
  },
  {
    title: 'Start it',
    text: 'One command builds and starts the container. All data lives in a Docker volume.',
    block: { title: 'bash', prompt: true, code: 'docker compose up -d --build' },
  },
] as const;

export function SelfHost() {
  return (
    <Section id="self-host" labelledBy="selfhost-title" className="border-t bg-surface/40">
      <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="flex flex-col gap-8 lg:sticky lg:top-24 lg:self-start">
          <SectionHeading
            id="selfhost-title"
            align="left"
            eyebrow="Self-host"
            title="Up and running in three commands"
            description="Free forever, no licence keys, no feature gates. Everything runs in a single Docker container with SQLite — no external database to manage."
          />
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row">
            <LinkButton href={LINKS.repo} external size="lg">
              <GitHubIcon />
              Get it on GitHub
            </LinkButton>
            <LinkButton href={LINKS.readme} external variant="outline" size="lg">
              Full documentation
              <ArrowUpRight />
            </LinkButton>
          </div>
          <ul className="grid grid-cols-1 gap-2.5 border-t pt-6 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-1">
            {REQUIREMENTS.map((r) => (
              <li key={r} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                {r}
              </li>
            ))}
          </ul>
        </div>

        <ol className="flex flex-col gap-10">
          {STEPS.map((step, i) => (
            <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-x-4 gap-y-3">
              <span
                className="flex size-8 items-center justify-center rounded-full border bg-background font-mono text-sm font-medium"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1 pt-1">
                <h3 className="font-semibold">
                  <span className="sr-only">Step {i + 1}: </span>
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p>
              </div>
              <CodeBlock className="col-span-2 sm:col-start-2 sm:col-end-3" code={step.block.code} title={step.block.title} prompt={step.block.prompt} />
            </li>
          ))}
          <li className="grid grid-cols-[2rem_1fr] gap-x-4 gap-y-3">
            <span className="flex size-8 items-center justify-center rounded-full border bg-background font-mono text-sm font-medium" aria-hidden="true">
              4
            </span>
            <div className="flex min-w-0 flex-col gap-1 pt-1">
              <h3 className="font-semibold">
                <span className="sr-only">Step 4: </span>Add HTTPS
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                The server listens on 127.0.0.1:3000. Put a TLS-terminating reverse proxy in front of it, open your domain and log in.
              </p>
            </div>
            <Tabs defaultValue="caddy" className="col-span-2 min-w-0 sm:col-start-2 sm:col-end-3">
              <TabsList>
                <TabsTrigger value="caddy" className="px-3">
                  Caddy
                </TabsTrigger>
                <TabsTrigger value="nginx" className="px-3">
                  nginx
                </TabsTrigger>
              </TabsList>
              <TabsContent value="caddy">
                <CodeBlock code={CADDY} title="Caddyfile" />
              </TabsContent>
              <TabsContent value="nginx">
                <CodeBlock code={NGINX} title="nginx.conf" />
              </TabsContent>
            </Tabs>
          </li>
        </ol>
      </Container>
    </Section>
  );
}
