import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { ForbiddenError, UnauthorizedError } from './context';
import { approvalRoutes } from './routes/approvals';
import { authRoutes } from './routes/auth';
import { contractRoutes } from './routes/contracts';
import { cutlistRoutes } from './routes/cutlist';
import { estimationRoutes } from './routes/estimation';
import { productionRoutes } from './routes/production';
import { inventoryRoutes } from './routes/inventory';
import { localisationRoutes } from './routes/localisation';
import { moduleRoutes } from './routes/modules';
import { procurementRoutes } from './routes/procurement';
import { projectRoutes } from './routes/projects';

/**
 * Narrows an error thrown inside Fastify to a 4xx worth reporting verbatim.
 *
 * The handler's `error` is typed `unknown`, so this cannot simply read
 * `.statusCode` — and it should not, because anything can be thrown. Returns
 * null for 5xx and for anything unrecognisable, which the caller turns into a
 * generic 500 rather than leaking an internal message.
 */
function clientError(error: unknown): { statusCode: number; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;

  const { statusCode, message } = error as { statusCode?: unknown; message?: unknown };
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return null;

  return {
    statusCode,
    message: typeof message === 'string' && message ? message : 'Bad request.',
  };
}

export interface BuildOptions {
  logger?: boolean;
  corsOrigin?: string;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Trust the proxy so client IPs in the audit log are real. The deployment
    // sits behind Cloudflare; see docs/04-infrastructure.md.
    trustProxy: true,
  });

  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    credentials: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({ error: error.message });
    }
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: error.message });
    }

    // Fastify raises its own 4xx for malformed requests — an empty body against
    // a JSON content-type, a payload over the limit, bad JSON. Those are the
    // caller's fault and must not be reported as 500: a client that sees a
    // server error retries, and a monitor that sees one pages somebody.
    const client = clientError(error);
    if (client) {
      request.log.info({ err: error }, 'client error');
      return reply.code(client.statusCode).send({ error: client.message });
    }

    request.log.error({ err: error }, 'unhandled request error');
    // Never leak internals to the client; the detail is in the log.
    return reply.code(500).send({ error: 'Internal server error.' });
  });

  app.get('/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(moduleRoutes, { prefix: '/api/v1' });
  await app.register(localisationRoutes, { prefix: '/api/v1' });
  await app.register(approvalRoutes, { prefix: '/api/v1' });
  await app.register(inventoryRoutes, { prefix: '/api/v1' });
  await app.register(cutlistRoutes, { prefix: '/api/v1' });
  await app.register(procurementRoutes, { prefix: '/api/v1' });
  await app.register(productionRoutes, { prefix: '/api/v1' });
  await app.register(estimationRoutes, { prefix: '/api/v1' });
  await app.register(projectRoutes, { prefix: '/api/v1' });
  await app.register(contractRoutes, { prefix: '/api/v1' });

  return app;
}
