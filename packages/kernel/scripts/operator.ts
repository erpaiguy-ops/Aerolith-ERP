/**
 * Create and manage vendor operator accounts.
 *
 * Runs as the OWNER (`DATABASE_URL`), not the platform role — deliberately, and
 * it is the reason `aerolith_platform` has no write access to `platform.operator`.
 * A compromised operator session can read the estate; it cannot create a second
 * operator, reset a password, or enrol a new authenticator. Doing any of those
 * requires a credential that lives with whoever administers the database rather
 * than in a running web process.
 *
 *   DATABASE_URL=… pnpm --filter @aerolith/kernel operator create \
 *     --email ops@vendor.test --name "Ops Person"
 *   DATABASE_URL=… pnpm --filter @aerolith/kernel operator confirm \
 *     --email ops@vendor.test --code 123456
 *   DATABASE_URL=… pnpm --filter @aerolith/kernel operator list
 *   DATABASE_URL=… pnpm --filter @aerolith/kernel operator disable --email …
 */
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import { assertPasswordAcceptable, hashPassword } from '../src/auth/password';
import { closeDatabase, createDatabase, getDatabase } from '../src/db';
import { operator } from '../src/db/schema/platform';
import { generateTotpSecret, totpUri, verifyTotp } from '../src/platform/totp';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. This runs as the schema owner, not the platform role.');
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`--${name} is required.`);
    process.exit(1);
  }
  return value;
}

async function create(): Promise<void> {
  const email = required('email').trim().toLowerCase();
  const name = required('name');
  // Generated, not chosen. An operator password an operator picked is the one
  // they use elsewhere, and this account is worth more than any of those.
  const password = flag('password') ?? randomBytes(18).toString('base64url');
  assertPasswordAcceptable(password);

  const secret = generateTotpSecret();

  await getDatabase().insert(operator).values({
    email,
    name,
    passwordHash: await hashPassword(password),
    totpSecret: secret,
    // Null: they must prove they can generate a code before the account works.
    // Otherwise a mistyped secret produces an account with a second factor
    // nobody holds, discovered at the worst possible moment.
    totpConfirmedAt: null,
  });

  console.log(`\n✓ operator ${email} created — NOT yet usable\n`);
  console.log(`  Password: ${password}`);
  console.log(`  TOTP secret: ${secret}`);
  console.log(`\n  Enrol it in an authenticator app, either by scanning this URI`);
  console.log(`  or entering the secret by hand:\n`);
  console.log(`  ${totpUri(secret, email)}\n`);
  console.log(`  Then confirm, which is what makes the account usable:\n`);
  console.log(`    pnpm --filter @aerolith/kernel operator confirm --email ${email} --code <6 digits>\n`);
}

async function confirm(): Promise<void> {
  const email = required('email').trim().toLowerCase();
  const code = required('code');

  const database = getDatabase();
  const [found] = await database.select().from(operator).where(eq(operator.email, email)).limit(1);
  if (!found) {
    console.error(`✗ no operator with email ${email}.`);
    process.exit(1);
  }
  if (found.totpConfirmedAt) {
    console.log(`✓ ${email} was already confirmed at ${found.totpConfirmedAt.toISOString()}.`);
    return;
  }
  if (!verifyTotp(found.totpSecret, code)) {
    console.error('✗ that code is not valid for this account. Check the clock on the device.');
    process.exit(1);
  }

  await database
    .update(operator)
    .set({ totpConfirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(operator.id, found.id));

  console.log(`✓ ${email} confirmed. The account can now sign in.`);
}

async function list(): Promise<void> {
  const rows = await getDatabase()
    .select({
      email: operator.email,
      name: operator.name,
      isActive: operator.isActive,
      confirmed: operator.totpConfirmedAt,
      lastLoginAt: operator.lastLoginAt,
      lockedUntil: operator.lockedUntil,
    })
    .from(operator)
    .orderBy(operator.email);

  if (rows.length === 0) {
    console.log('No operators. Nobody can sign in to the platform surface.');
    return;
  }

  for (const row of rows) {
    const state = !row.isActive
      ? 'disabled'
      : !row.confirmed
        ? 'UNCONFIRMED'
        : row.lockedUntil && row.lockedUntil > new Date()
          ? 'locked'
          : 'active';
    const seen = row.lastLoginAt ? row.lastLoginAt.toISOString().slice(0, 16) : 'never';
    console.log(`${row.email.padEnd(32)}${state.padEnd(14)}last seen ${seen}  ${row.name}`);
  }
}

async function setActive(isActive: boolean): Promise<void> {
  const email = required('email').trim().toLowerCase();
  const updated = await getDatabase()
    .update(operator)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(operator.email, email))
    .returning({ id: operator.id });

  if (updated.length === 0) {
    console.error(`✗ no operator with email ${email}.`);
    process.exit(1);
  }
  console.log(`✓ ${email} ${isActive ? 'enabled' : 'disabled'}.`);
  if (!isActive) {
    // Worth saying: sessions are not deleted, they stop resolving. The join in
    // `authenticateOperator` checks `is_active` on every request.
    console.log('  Existing sessions stop working on their next request.');
  }
}

async function main(): Promise<void> {
  createDatabase({ connectionString: url!, maxConnections: 2 });
  try {
    switch (process.argv[2]) {
      case 'create':
        return await create();
      case 'confirm':
        return await confirm();
      case 'list':
        return await list();
      case 'disable':
        return await setActive(false);
      case 'enable':
        return await setActive(true);
      default:
        console.error('Usage: operator <create|confirm|list|enable|disable> [options]');
        process.exit(1);
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('✗ operator command failed:', error);
  process.exit(1);
});
