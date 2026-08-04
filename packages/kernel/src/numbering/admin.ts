/**
 * Number series administration.
 *
 * `kernel.number_series.manage` was declared from the start and enforced
 * nowhere, because nothing could edit a series: `provisionSeries` creates them
 * from each module's manifest and `allocateNumber` consumes them, and between
 * those two there was no way to change a pattern, correct a name, or retire a
 * series a tenant does not use.
 *
 * **The rule this file exists to enforce is that `nextValue` may not go
 * backwards.** `number_allocation` is uniquely keyed on
 * (seriesId, period, value), so rewinding the counter does not fail here — it
 * fails on the NEXT document somebody creates, as a unique-constraint error
 * thrown from deep inside `allocateNumber`, at a keystroke unrelated to the
 * edit that caused it. Refusing it at the point of edit costs one query and
 * turns an incident into a sentence.
 *
 * Everything else is deliberately permissive. A pattern, prefix or padding may
 * change mid-series: the numbers already issued keep the shape they were
 * issued with, which is correct — they are what is printed on documents a
 * client already has.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { numberAllocation, numberSeries } from '../db/schema';
import { recordAudit, type FieldChange } from '../audit/service';
import { requireTenantContext } from '../tenancy/context';
import { periodKey } from './format';

const MODULE_KEY = 'kernel';

export class NumberSeriesError extends Error {
  override readonly name = 'NumberSeriesError';
}

export interface NumberSeriesRow {
  id: string;
  entityType: string;
  code: string;
  name: string;
  pattern: string;
  prefix: string | null;
  suffix: string | null;
  padding: number;
  startValue: number;
  increment: number;
  nextValue: number;
  resetFrequency: string;
  lastResetPeriod: string | null;
  isGapless: boolean;
  isDefault: boolean;
  isActive: boolean;
  /** How many numbers this series has issued, ever. */
  allocatedCount: number;
  /** The most recent number issued, as it was formatted at the time. */
  lastFormatted: string | null;
}

/**
 * Every series for the tenant, with what it has actually issued.
 *
 * The allocation count is the number that makes this screen worth opening: a
 * series showing 0 issued can be renamed or repatterned freely, and one
 * showing 400 cannot without the next document looking unlike the last.
 */
export async function listNumberSeries(tx: Transaction): Promise<NumberSeriesRow[]> {
  const { tenantId } = requireTenantContext();

  const counts = tx
    .select({
      seriesId: numberAllocation.seriesId,
      allocatedCount: sql<number>`count(*)::int`.as('allocated_count'),
      lastValue: sql<number>`max(${numberAllocation.value})`.as('last_value'),
    })
    .from(numberAllocation)
    .where(eq(numberAllocation.tenantId, tenantId))
    .groupBy(numberAllocation.seriesId)
    .as('counts');

  const rows = await tx
    .select({
      id: numberSeries.id,
      entityType: numberSeries.entityType,
      code: numberSeries.code,
      name: numberSeries.name,
      pattern: numberSeries.pattern,
      prefix: numberSeries.prefix,
      suffix: numberSeries.suffix,
      padding: numberSeries.padding,
      startValue: numberSeries.startValue,
      increment: numberSeries.increment,
      nextValue: numberSeries.nextValue,
      resetFrequency: numberSeries.resetFrequency,
      lastResetPeriod: numberSeries.lastResetPeriod,
      isGapless: numberSeries.isGapless,
      isDefault: numberSeries.isDefault,
      isActive: numberSeries.isActive,
      allocatedCount: sql<number>`coalesce(${counts.allocatedCount}, 0)`,
    })
    .from(numberSeries)
    .leftJoin(counts, eq(counts.seriesId, numberSeries.id))
    .where(eq(numberSeries.tenantId, tenantId))
    .orderBy(asc(numberSeries.entityType), asc(numberSeries.code));

  // The last formatted number per series, fetched separately: it is the string
  // an admin recognises ("PO-2026-00042"), and reconstructing it from the
  // pattern would show today's shape rather than the one actually issued.
  const lastByCode = new Map<string, string>();
  for (const row of rows) {
    if (row.allocatedCount === 0) continue;
    const [latest] = await tx
      .select({ formatted: numberAllocation.formatted })
      .from(numberAllocation)
      .where(
        and(eq(numberAllocation.tenantId, tenantId), eq(numberAllocation.seriesId, row.id)),
      )
      .orderBy(desc(numberAllocation.createdAt))
      .limit(1);
    if (latest) lastByCode.set(row.id, latest.formatted);
  }

  return rows.map((row) => ({ ...row, lastFormatted: lastByCode.get(row.id) ?? null }));
}

export interface UpdateNumberSeriesInput {
  seriesId: string;
  name?: string;
  pattern?: string;
  prefix?: string | null;
  suffix?: string | null;
  padding?: number;
  increment?: number;
  nextValue?: number;
  isGapless?: boolean;
  isActive?: boolean;
}

export async function updateNumberSeries(
  tx: Transaction,
  input: UpdateNumberSeriesInput,
  options: { fiscalYearStartMonth?: number } = {},
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(numberSeries)
    .where(and(eq(numberSeries.tenantId, tenantId), eq(numberSeries.id, input.seriesId)));
  if (!existing) throw new NumberSeriesError('Number series not found.');

  if (input.pattern !== undefined && !input.pattern.includes('{SEQ}')) {
    // Without a sequence token every document in the series formats to the
    // same string, which is not a numbering scheme.
    throw new NumberSeriesError('A pattern must contain {SEQ}.');
  }

  if (input.padding !== undefined && (input.padding < 1 || input.padding > 12)) {
    throw new NumberSeriesError('Padding must be between 1 and 12.');
  }

  if (input.increment !== undefined && input.increment < 1) {
    throw new NumberSeriesError('Increment must be at least 1.');
  }

  /*
   * Gapless may be switched on, never off — the same "widen, never narrow"
   * rule `provisionSeries` applies when it defaults tax documents to gapless.
   * A tenant whose country requires unbroken invoice numbering cannot be
   * allowed to relax that from a settings screen, and a series that HAS been
   * gapless has an audit history asserting it.
   */
  if (input.isGapless === false && existing.isGapless) {
    throw new NumberSeriesError(
      'A gapless series cannot be made non-gapless. Statutory numbering has to stay unbroken ' +
        'once it has been relied on.',
    );
  }

  if (input.nextValue !== undefined) {
    if (input.nextValue < 1) throw new NumberSeriesError('The next value must be at least 1.');

    /*
     * The check this module exists for. Only the CURRENT period matters: the
     * allocation log is keyed per period, so a yearly series may reissue 1
     * next January without colliding with last January's 1.
     */
    const currentPeriod = periodKey(
      existing.resetFrequency,
      new Date(),
      options.fiscalYearStartMonth ?? 1,
    );

    const [peak] = await tx
      .select({ highest: sql<number | null>`max(${numberAllocation.value})` })
      .from(numberAllocation)
      .where(
        and(
          eq(numberAllocation.tenantId, tenantId),
          eq(numberAllocation.seriesId, input.seriesId),
          eq(numberAllocation.period, currentPeriod),
        ),
      );

    const highest = peak?.highest ?? null;
    if (highest !== null && input.nextValue <= highest) {
      throw new NumberSeriesError(
        `This series has already issued ${highest} in the current period, so the next value ` +
          `must be above ${highest}. Setting it to ${input.nextValue} would reissue a number ` +
          'that is already on a document.',
      );
    }
  }

  const changes: Record<string, FieldChange> = {};
  const set = (field: string, value: unknown, previous: unknown) => {
    if (value === undefined || value === previous) return;
    changes[field] = { from: previous, to: value };
  };

  set('name', input.name, existing.name);
  set('pattern', input.pattern, existing.pattern);
  set('prefix', input.prefix, existing.prefix);
  set('suffix', input.suffix, existing.suffix);
  set('padding', input.padding, existing.padding);
  set('increment', input.increment, existing.increment);
  set('nextValue', input.nextValue, existing.nextValue);
  set('isGapless', input.isGapless, existing.isGapless);
  set('isActive', input.isActive, existing.isActive);

  if (Object.keys(changes).length === 0) return;

  await tx
    .update(numberSeries)
    .set({
      name: input.name ?? existing.name,
      pattern: input.pattern ?? existing.pattern,
      prefix: input.prefix !== undefined ? input.prefix : existing.prefix,
      suffix: input.suffix !== undefined ? input.suffix : existing.suffix,
      padding: input.padding ?? existing.padding,
      increment: input.increment ?? existing.increment,
      nextValue: input.nextValue ?? existing.nextValue,
      isGapless: input.isGapless ?? existing.isGapless,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(numberSeries.id, input.seriesId));

  // Audited because the permission's own description says so — changing a
  // gapless series is the kind of act somebody later has to account for.
  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.number_series',
    entityId: input.seriesId,
    entityLabel: existing.code,
    action: 'update',
    changes,
  });
}
