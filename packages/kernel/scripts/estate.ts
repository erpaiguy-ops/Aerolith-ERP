/**
 * The estate report.
 *
 * Stage 1 of docs/07-platform-operations.md, and deliberately a command rather
 * than a web page. The isolation model is the part worth getting right first —
 * a separate role, SELECT-only policies, a credential the tenant API never
 * holds — and a CLI proves all of it without also standing up an operator
 * identity realm, a second session mechanism and a login form, each of which is
 * somewhere a cross-tenant surface can go wrong. Those come with Stage 4.
 *
 * It also replaces the thing it is competing with. Without this, answering
 * "how many customers do we have, on what" means hand-written SQL against
 * production — and the obvious query returns zero rows with no error, because
 * `tenant_module` is RLS-forced and the naive connection matches no policy.
 * Silently empty is the worst possible answer to a commercial question.
 *
 *   DATABASE_PLATFORM_URL=... pnpm --filter @aerolith/kernel estate
 *   DATABASE_PLATFORM_URL=... pnpm --filter @aerolith/kernel estate --json
 */
import {
  assertPlatformRole,
  closeDatabase,
  createDatabase,
  getDatabase,
  listEstate,
  summariseEstate,
  type EstateTenantRow,
} from '../src/index';

// Not DATABASE_URL, and not DATABASE_APP_URL. Naming its own variable is what
// keeps the operator credential out of the tenant API's environment: a
// deployment that never sets this cannot read across tenants even by accident.
const url = process.env.DATABASE_PLATFORM_URL;
if (!url) {
  console.error('DATABASE_PLATFORM_URL is not set.');
  console.error('It must point at the SELECT-only platform role — see docs/07-platform-operations.md.');
  process.exit(1);
}

const asJson = process.argv.includes('--json');

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function renderTenants(rows: EstateTenantRow[]): void {
  if (rows.length === 0) {
    console.log('No tenants.');
    return;
  }

  console.log(
    `${pad('SLUG', 18)}${pad('NAME', 28)}${pad('STATUS', 10)}${pad('USERS', 7)}${pad('MODULES', 9)}TRIAL ENDS`,
  );
  console.log('─'.repeat(96));

  for (const row of rows) {
    const enabled = row.modules.filter((m) => m.status === 'enabled').length;
    const trialling = row.modules.filter((m) => m.status === 'trial').length;
    const modules = trialling > 0 ? `${enabled}+${trialling}t` : String(enabled);
    console.log(
      pad(row.slug, 18) +
        pad(row.name, 28) +
        pad(row.status, 10) +
        pad(String(row.activeUsers), 7) +
        pad(modules, 9) +
        (row.trialEndsAt ? String(row.trialEndsAt).slice(0, 10) : '—'),
    );
  }
}

async function main() {
  createDatabase({ connectionString: url!, maxConnections: 2 });

  try {
    const database = getDatabase();

    // Before anything is read, not after. If this connection can write, the
    // report is being produced by a credential that should not have been
    // handed to it, and printing the numbers first would imply otherwise.
    await database.transaction(assertPlatformRole);

    const [rows, summary] = await database.transaction(async (tx) => [
      await listEstate(tx),
      await summariseEstate(tx),
    ]);

    if (asJson) {
      console.log(JSON.stringify({ summary, tenants: rows }, null, 2));
      return;
    }

    const statuses = Object.entries(summary.byStatus)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, n]) => `${n} ${status}`)
      .join(', ');

    console.log(`\n${summary.tenants} tenant${summary.tenants === 1 ? '' : 's'}${statuses ? ` — ${statuses}` : ''}\n`);
    renderTenants(rows);

    if (summary.moduleTakeUp.length > 0) {
      console.log('\nModule take-up');
      console.log('─'.repeat(96));
      for (const module of summary.moduleTakeUp) {
        const trialling = module.trialling > 0 ? `, ${module.trialling} trialling` : '';
        console.log(`${pad(module.moduleKey, 24)}${module.enabled} enabled${trialling}`);
      }
    }

    if (summary.trialsExpiring.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      console.log('\nTrials ending or ended');
      console.log('─'.repeat(96));
      for (const trial of summary.trialsExpiring) {
        const ends = String(trial.trialEndsAt).slice(0, 10);
        console.log(`${pad(trial.slug, 18)}${pad(trial.name, 28)}${ends}${ends < today ? '  (lapsed)' : ''}`);
      }
    }

    console.log('');
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('✗ estate report failed:', error);
  process.exit(1);
});
