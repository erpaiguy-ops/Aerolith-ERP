import { closeDatabase, createDatabase } from '@aerolith/kernel';

import { buildApp } from './app';
import { syncModules } from './bootstrap';

const port = Number(process.env.API_PORT ?? 3001);
const connectionString = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_APP_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

async function main() {
  // The app connects as the non-owner role so RLS actually applies to it.
  // See docs/02-architecture.md, "Multi-tenancy".
  createDatabase({
    connectionString: connectionString!,
    debug: process.env.NODE_ENV === 'development',
  });

  const synced = await syncModules();
  console.log(`→ modules synced: ${synced.permissions} permissions, ${synced.rules} rules`);

  const app = await buildApp({ logger: true, corsOrigin: process.env.WEB_URL });
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`✓ API listening on :${port}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await closeDatabase();
        process.exit(0);
      })();
    });
  }
}

main().catch((error) => {
  console.error('✗ failed to start:', error);
  process.exit(1);
});
