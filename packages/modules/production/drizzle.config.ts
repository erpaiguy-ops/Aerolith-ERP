import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aerolith:aerolith@localhost:5432/aerolith',
  },
  // Only this module's schema — without the filter drizzle-kit would treat every
  // other schema's tables as "to be dropped".
  schemaFilter: ['production'],
  verbose: true,
  strict: true,
});
