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
import { projectRoutes } from './routes/projects';

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
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      request.log.info({ err: error }, 'client error');
      return reply.code(status).send({ error: error.message });
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
  await app.register(productionRoutes, { prefix: '/api/v1' });
  await app.register(estimationRoutes, { prefix: '/api/v1' });
  await app.register(projectRoutes, { prefix: '/api/v1' });
  await app.register(contractRoutes, { prefix: '/api/v1' });

  return app;
}
