/**
 * Create, suspend, resume or delete a customer.
 *
 * Stage 2 of docs/07-platform-operations.md. A command rather than a web page
 * for the same reason the estate report is: the operator web surface is Stage 4
 * and needs its own identity realm, and until that exists a terminal is a more
 * honest door than a route bolted onto the tenant application.
 *
 *   DATABASE_APP_URL=… pnpm provision create \
 *     --slug acme --name "Acme Joinery" \
 *     --country AE --currency AED --timezone Asia/Dubai \
 *     --owner-email owner@acme.test --owner-name "A. Owner" \
 *     --modules projects,contracts,inventory [--trial-days 30] [--password …]
 *
 *   DATABASE_APP_URL=… pnpm provision suspend --tenant <uuid>
 *   DATABASE_APP_URL=… pnpm provision resume  --tenant <uuid>
 *   DATABASE_APP_URL=… pnpm provision delete  --tenant <uuid>
 *
 * Reads DATABASE_APP_URL, not DATABASE_PLATFORM_URL: this writes, and the
 * platform role is SELECT-only by construction. Falls back to DATABASE_URL so
 * a local checkout works without extra setup — but on a deployment where the
 * owner role is subject to RLS, the app URL is the one that works.
 */
import { closeDatabase, createDatabase } from '@aerolith/kernel';
import { randomBytes } from 'node:crypto';

import { syncModules } from '../src/bootstrap';
import {
  ProvisioningError,
  provisionTenant,
  setTenantLifecycle,
  type TenantLifecycleAction,
} from '../src/provisioning';

const url = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_APP_URL (or DATABASE_URL) must be set.');
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

/**
 * A password nobody has to invent.
 *
 * There is no mail transport in this deployment, which `addMember` already
 * states plainly — so an invitation link would be a link nobody receives, and
 * the initial credential is handed over directly instead. Generating it beats
 * letting an operator choose, because the one they choose is memorable, reused
 * across customers, and occasionally still in place a year later.
 *
 * base64url of 18 bytes: 24 characters, no ambiguous punctuation to garble
 * when it is pasted into a chat window or read down a phone.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function create(): Promise<void> {
  const password = flag('password') ?? generatePassword();
  const generated = flag('password') === undefined;
  const trialDaysRaw = flag('trial-days');

  // `syncModules` first: `enableModule` looks the module up in the registry and
  // writes `tenant_module` rows that reference permissions the registry
  // declares. On a database where the module tables have never been synced,
  // provisioning would otherwise create entitlements to modules the deployment
  // has no record of.
  await syncModules();

  const result = await provisionTenant({
    slug: required('slug'),
    name: required('name'),
    countryCode: required('country').toUpperCase(),
    currencyCode: required('currency').toUpperCase(),
    timezone: flag('timezone'),
    trialDays: trialDaysRaw === undefined ? undefined : Number(trialDaysRaw),
    ownerEmail: required('owner-email'),
    ownerName: required('owner-name'),
    ownerPassword: password,
    moduleKeys: required('modules')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  });

  console.log(`\n✓ ${result.slug} provisioned`);
  console.log(`  tenant id       ${result.tenantId}`);
  console.log(`  modules         ${result.modulesEnabled.join(', ')}`);
  console.log(`  number series   ${result.seriesCreated}`);
  console.log(`  requirements    ${result.requirementsAdopted} adopted from the country pack`);
  if (result.trialEndsAt) console.log(`  trial ends      ${result.trialEndsAt.slice(0, 10)}`);

  console.log(`\n  Owner: ${flag('owner-email')}`);
  if (result.ownerAccountCreated) {
    if (generated) {
      // Printed once, and only when this run created the account. Saying it out
      // loud is the delivery mechanism; pretending otherwise would leave an
      // operator hunting for an email that is never sent.
      console.log(`  Password: ${password}`);
      console.log('  Give this to them directly. It is not stored anywhere in readable form,');
      console.log('  and it is not shown again.');
    } else {
      console.log('  Password: as supplied on the command line.');
    }
  } else {
    // The important case to be explicit about: an existing account keeps its
    // existing password, and an operator who assumed otherwise would hand the
    // customer a credential that does not work.
    console.log('  This email already had an account — it keeps its existing password,');
    console.log('  and has been added to the new workspace as owner.');
  }
  console.log('');
}

async function lifecycle(action: TenantLifecycleAction): Promise<void> {
  const result = await setTenantLifecycle({ tenantId: required('tenant'), action });
  const past = { suspend: 'suspended', resume: 'resumed', delete: 'deleted' }[action];
  console.log(`✓ ${result.slug} ${past} (status: ${result.status})`);
  if (action === 'suspend' || action === 'delete') {
    console.log('  Nobody can sign in to it now — loadMemberships refuses a non-active tenant.');
  }
  if (action === 'delete') {
    console.log('  Soft delete: the data is still there. Purging is a separate operation.');
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  createDatabase({ connectionString: url!, maxConnections: 4 });

  try {
    switch (command) {
      case 'create':
        return await create();
      case 'suspend':
      case 'resume':
      case 'delete':
        return await lifecycle(command);
      default:
        console.error('Usage: provision <create|suspend|resume|delete> [options]');
        console.error('See the header of apps/api/scripts/provision.ts for the flags.');
        process.exit(1);
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  // A ProvisioningError is a message written for the person reading it —
  // a taken slug, an unusable email — so it prints as one. Anything else is a
  // bug or an environment problem and keeps its stack.
  if (error instanceof ProvisioningError) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  console.error('✗ provisioning failed:', error);
  process.exit(1);
});
