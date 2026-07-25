import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aerolith:aerolith@localhost:5432/aerolith',
  },
  schemaFilter: ['kernel'],
  verbose: true,
  strict: true,
});
