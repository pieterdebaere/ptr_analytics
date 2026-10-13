import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { isApiPath, pathOf } from '../security.js';

const NO_DASHBOARD_MESSAGE =
  'PTR Analytics server is running, but the dashboard has not been built.\n' +
  'Run `npm run build` in the repository root (or set DASHBOARD_DIR).\n';

function loadTracker(ctx: AppContext): { body: Buffer; etag: string } | null {
  try {
    const body = fs.readFileSync(ctx.config.trackerFile);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    return { body, etag };
  } catch {
    ctx.log.warn(
      `Tracker script not found at ${ctx.config.trackerFile}; GET /script.js will return 404. ` +
        'Build it with `npm run build -w tracker` (or set TRACKER_FILE).',
    );
    return null;
  }
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

/** /script.js, /healthz, dashboard SPA (static files + index.html fallback) and 404 handling. */
export async function staticRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;

  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  const tracker = loadTracker(ctx);
  app.get('/script.js', async (request, reply) => {
    if (!tracker) return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .header('Access-Control-Allow-Origin', '*')
      .header('ETag', tracker.etag);
    if (request.headers['if-none-match'] === tracker.etag) return reply.code(304).send();
    return reply.send(tracker.body);
  });

  const root = path.resolve(ctx.config.dashboardDir);
  const indexFile = path.join(root, 'index.html');
  const hasDashboard = fs.existsSync(indexFile);
  if (!hasDashboard) {
    ctx.log.warn(`Dashboard build not found at ${root}; serving a placeholder page. Run \`npm run build\`.`);
  }

  const sendIndex = async (reply: FastifyReply): Promise<FastifyReply> => {
    if (!hasDashboard) {
      return reply.code(200).type('text/plain; charset=utf-8').header('Cache-Control', 'no-cache').send(NO_DASHBOARD_MESSAGE);
    }
    const html = await fsp.readFile(indexFile);
    return reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
  };

  app.get('/', async (_request, reply) => sendIndex(reply));

  if (hasDashboard) {
    const assetsDir = path.join(root, 'assets') + path.sep;
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      wildcard: true,
      index: false,
      list: false,
      redirect: false,
      dotfiles: 'deny',
      serveDotFiles: false,
      decorateReply: false,
      cacheControl: false,
      etag: true,
      lastModified: true,
      allowedPath: (pathName) => !isApiPath(pathName),
      setHeaders: (reply, filePath) => {
        const resolved = path.resolve(filePath);
        reply.header(
          'Cache-Control',
          resolved.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const p = pathOf(request.url);
    if (isApiPath(p)) return reply.code(404).send({ error: 'not found' });
    if ((request.method === 'GET' || request.method === 'HEAD') && acceptsHtml(request)) return sendIndex(reply);
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
  });
}
