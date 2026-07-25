import { type SQL, sql } from 'drizzle-orm';

/**
 * Coerces a value for a NOT NULL jsonb column.
 *
 * JavaScript `null` handed to a jsonb column becomes SQL NULL, not JSON `null`
 * — so a legitimate value like "this rule has no cap" is rejected by the NOT
 * NULL constraint instead of being stored. Rule and setting values need to
 * distinguish "no row" from "a row whose value is null", so the JSON literal is
 * what we want here.
 */
export function jsonValue(value: unknown): unknown | SQL {
  return value === null || value === undefined ? sql`'null'::jsonb` : value;
}
