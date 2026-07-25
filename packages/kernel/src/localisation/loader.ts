/**
 * Loads country packs from disk and validates them.
 *
 * Run in CI so a malformed pack fails the build rather than a customer's
 * onboarding.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CountryPack, parseCountryPack } from './pack';
import { KERNEL_RULE_DEFINITIONS } from './definitions';

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs');

export async function loadCountryPack(code: string, packsDir = PACKS_DIR): Promise<CountryPack> {
  const path = join(packsDir, `${code.toUpperCase()}.json`);
  const raw = await readFile(path, 'utf8');
  return parseCountryPack(JSON.parse(raw), path);
}

export async function loadAllCountryPacks(packsDir = PACKS_DIR): Promise<CountryPack[]> {
  const files = (await readdir(packsDir)).filter((f) => f.endsWith('.json')).sort();
  const packs: CountryPack[] = [];
  for (const file of files) {
    const raw = await readFile(join(packsDir, file), 'utf8');
    packs.push(parseCountryPack(JSON.parse(raw), file));
  }
  return packs;
}

export interface PackValidationIssue {
  pack: string;
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Cross-checks a pack against the declared rule catalogue.
 *
 * An unknown rule key is an ERROR: it would be silently ignored at adoption,
 * which is the worst possible failure mode for a payroll setting — everything
 * looks fine until payday. A missing rule is only a WARNING, because the global
 * default may legitimately apply.
 */
export function validatePackAgainstDefinitions(
  pack: CountryPack,
  knownKeys: ReadonlySet<string> = new Set(KERNEL_RULE_DEFINITIONS.map((d) => d.key)),
): PackValidationIssue[] {
  const issues: PackValidationIssue[] = [];

  for (const key of Object.keys(pack.rules)) {
    if (!knownKeys.has(key)) {
      issues.push({
        pack: pack.code,
        severity: 'error',
        message:
          `Rule "${key}" is not declared in any rule catalogue. It would be ignored at ` +
          'adoption. Declare it in the kernel or in a module manifest.',
      });
    }
  }

  for (const key of knownKeys) {
    if (!(key in pack.rules)) {
      issues.push({
        pack: pack.code,
        severity: 'warning',
        message: `Rule "${key}" has no country value; the global default will apply.`,
      });
    }
  }

  for (const source of Object.keys(pack.ruleSources)) {
    if (!(source in pack.rules)) {
      issues.push({
        pack: pack.code,
        severity: 'warning',
        message: `ruleSources cites "${source}", which the pack does not set.`,
      });
    }
  }

  const defaultsByRegime = new Map<string, number>();
  for (const regime of pack.taxRegimes) {
    const defaults = regime.taxCodes.filter((c) => c.isDefault).length;
    defaultsByRegime.set(regime.code, defaults);
    if (defaults > 1) {
      issues.push({
        pack: pack.code,
        severity: 'error',
        message: `Tax regime "${regime.code}" has ${defaults} default tax codes; expected at most one.`,
      });
    }
    if (defaults === 0 && regime.taxCodes.length > 0) {
      issues.push({
        pack: pack.code,
        severity: 'warning',
        message: `Tax regime "${regime.code}" has no default tax code.`,
      });
    }
  }

  const divisionCodes = new Set(pack.adminDivisions.map((d) => d.code));
  for (const field of pack.addressFormat) {
    if (field.source === 'admin_division' && divisionCodes.size === 0) {
      issues.push({
        pack: pack.code,
        severity: 'error',
        message:
          `Address field "${field.key}" sources from admin divisions, but the pack defines none.`,
      });
    }
  }

  return issues;
}
