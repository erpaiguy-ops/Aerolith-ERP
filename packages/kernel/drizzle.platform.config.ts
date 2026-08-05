import { defineConfig } from 'drizzle-kit';

/**
 * The `platform` schema migrates separately from `kernel`.
 *
 * Two configs rather than one with a wider filter, for the same reason each
 * module has its own: drizzle-kit diffs everything it can see against one
 * snapshot, so a single config covering both schemas would let a change to one
 * generate a migration touching the other. Keeping them apart also keeps the
 * realms apart in the migration history, where the separation is easiest to
 * accidentally undo.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/platform.ts',
  out: './drizzle-platform',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aerolith:aerolith@localhost:5432/aerolith',
  },
  schemaFilter: ['platform'],
  verbose: true,
  strict: true,
});
