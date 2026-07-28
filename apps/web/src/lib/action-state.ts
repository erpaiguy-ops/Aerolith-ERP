/**
 * The result shape a server action returns, and the initial value.
 *
 * Deliberately in its own module with no `server-only` marker: the client
 * component that renders the result has to import this type and the idle value,
 * and importing anything from a `server-only` module fails the build. Relying on
 * `import type` erasure instead would work until somebody imported a value, and
 * then break the build with a message that does not explain why.
 *
 * Everything that actually performs a write lives in `actions.ts`, which is
 * server-only and stays that way.
 */

export type ActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; error: string };

export const IDLE: ActionState = { status: 'idle' };
