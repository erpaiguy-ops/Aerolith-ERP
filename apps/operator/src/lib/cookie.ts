/**
 * The session cookie's name, and deliberately nothing else.
 *
 * Its own module because `middleware.ts` needs it and middleware runs on the
 * EDGE runtime, which has no Node built-ins. Importing it from `lib/session`
 * pulled that module's `@aerolith/kernel` import into the edge bundle, which
 * pulls in `pg` and `node:url`, and the build failed with a module-not-found on
 * `node:url` several layers deep — a stack trace that names the kernel's
 * localisation loader and gives no hint that middleware is the reason.
 *
 * A different name from the tenant application's `aerolith_session`, on
 * purpose: if both surfaces ever share a parent domain, one cookie name would
 * mean one overwrites the other and a tenant session could be presented here.
 */
export const OPERATOR_SESSION_COOKIE = 'aerolith_operator_session';
