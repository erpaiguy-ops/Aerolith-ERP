import { defineConfig } from 'vitest/config';

/**
 * Test configuration for the web app.
 *
 * The only thing here is the `react-server` resolve condition, and it is not
 * optional. `server-only` — the marker that keeps the session, the API client
 * and the request locale out of the browser bundle — is a package whose default
 * export THROWS on import. Next resolves it under the `react-server` condition,
 * where it resolves to an empty module instead; a plain Node resolver does not,
 * so every test that transitively imports a server module fails to collect.
 *
 * That transitive reach is easy to underestimate: `format.ts` is a file of pure
 * functions, but it reads the request locale, so it pulls in `server-only` and
 * its tests stopped collecting the moment it did. Setting the condition here
 * tests these modules the same way Next loads them, rather than deleting the
 * marker to make the tests pass — which would silently permit a client
 * component to import the session.
 */
export default defineConfig({
  // Both pipelines: Vitest transforms test modules through the SSR resolver, so
  // setting only `resolve.conditions` — which applies to the client one — looks
  // correct and changes nothing.
  resolve: {
    conditions: ['react-server'],
  },
  ssr: {
    resolve: {
      conditions: ['react-server'],
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
