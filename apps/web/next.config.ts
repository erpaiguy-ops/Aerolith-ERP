import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate process; the browser never talks to it directly.
  // Every call goes through a server component or a route handler so the
  // session token stays in an httpOnly cookie and never reaches client JS.
  env: { AEROLITH_API_URL: process.env.AEROLITH_API_URL ?? 'http://localhost:3001' },
  // A self-contained `.next/standalone` output — only the files a
  // production `node server.js` actually needs, not the whole workspace.
  // Required for the lean multi-stage Docker image; irrelevant to `next dev`.
  output: 'standalone',
};

export default config;
