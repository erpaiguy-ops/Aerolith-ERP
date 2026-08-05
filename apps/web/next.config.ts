import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate process; the browser never talks to it directly.
  // Every call goes through a server component or a route handler so the
  // session token stays in an httpOnly cookie and never reaches client JS.
  //
  // AEROLITH_API_URL is read directly via `process.env` in lib/api.ts —
  // deliberately NOT declared here. Next's `env` config is a BUILD-TIME
  // substitution (values get baked into the compiled bundle, the same as
  // webpack's DefinePlugin), not a runtime passthrough. A Docker build does
  // not have the container's runtime environment variables available during
  // `docker build` — only once the built image actually starts — so this
  // used to bake in the `?? 'http://localhost:3001'` fallback permanently,
  // no matter what the deployed container's real environment set. Server-only
  // code (this file's own header) needs no Next-specific config to see real
  // runtime env vars; plain Node.js already provides that.
  //
  // A self-contained `.next/standalone` output — only the files a
  // production `node server.js` actually needs, not the whole workspace.
  // Required for the lean multi-stage Docker image; irrelevant to `next dev`.
  output: 'standalone',
};

export default config;
