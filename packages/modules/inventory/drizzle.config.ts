import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aerolith:aerolith@localhost:5432/aerolith',
  },
  // Only this module's schema. Without the filter drizzle-kit would see the
  // kernel's tables as "to be dropped" and generate a catastrophic migration.
  schemaFilter: ['inventory'],
  verbose: true,
  strict: true,
});
