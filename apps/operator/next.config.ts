import type { NextConfig } from 'next';

/**
 * No `env` block, for the same reason apps/web has none: Next's `env` config is
 * a BUILD-TIME substitution, so a Docker build would bake in whatever the
 * fallback was and ignore the container's real environment. DATABASE_PLATFORM_URL
 * is read through `process.env` in server-only code, which needs no Next config.
 */
const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // The kernel is a workspace package compiled from TypeScript source rather
  // than shipped as build output, so Next has to transpile it like its own code.
  transpilePackages: ['@aerolith/kernel'],
  // `pg` and the kernel's crypto reach for Node built-ins. Nothing here runs in
  // the browser — every page is a server component — but Next needs telling
  // that the kernel must not be bundled for the client.
  serverExternalPackages: ['pg'],
};

export default config;
