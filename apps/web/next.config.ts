import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate process; the browser never talks to it directly.
  // Every call goes through a server component or a route handler so the
  // session token stays in an httpOnly cookie and never reaches client JS.
  env: { AEROLITH_API_URL: process.env.AEROLITH_API_URL ?? 'http://localhost:3001' },
};

export default config;
