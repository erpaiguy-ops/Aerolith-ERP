/**
 * Document number allocation.
 *
 * Allocation takes a row lock on the series and runs inside the CALLER's
 * transaction. That serialises allocation per series, which is exactly what
 * statutory gapless numbering requires.
 *
 * Do not be tempted to replace this with a Postgres sequence: sequences do not
 * roll back, so a failed insert burns a number and leaves a gap. For a tax
 * invoice series that gap is the thing an auditor asks about.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { numberAllocation, numberSeries } from '../db/schema';
import { requireTenantContext } from '../tenancy/context';
import { formatNumber, periodKey } from './format';

export interface AllocateOptions {
  entityType: string;
  /** Pick a specific series; otherwise the default for the entity type. */
  seriesCode?: string;
  legalEntityId?: string | null;
  /** The document's own date, so backdated documents number by their date. */
  documentDate?: Date;
  entityId?: string;
  entityCode?: string;
  projectCode?: string;
  fiscalYearStartMonth?: number;
}

export interface AllocatedNumber {
  formatted: string;
  value: number;
  seriesId: string;
  seriesCode: string;
  /** Reset period this value belongs to. Needed to void the number later. */
  period: string;
}

export class NoNumberSeriesError extends Error {
  override readonly name = 'NoNumberSeriesError';
  constructor(entityType: string) {
    super(
      `No active number series for "${entityType}". Every module declares its series ` +
        'in its manifest; they are created per tenant when the module is enabled.',
    );
  }
}

export async function allocateNumber(
  tx: Transaction,
  options: AllocateOptions,
): Promise<AllocatedNumber> {
  const { tenantId, userId } = requireTenantContext();
  const documentDate = options.documentDate ?? new Date();

  // FOR UPDATE serialises concurrent allocation on this series. Everything
  // between here and the caller's commit holds that lock, so keep it short.
  const [series] = await tx
    .select()
    .from(numberSeries)
    .where(
      and(
        eq(numberSeries.tenantId, tenantId),
        eq(numberSeries.entityType, options.entityType),
        eq(numberSeries.isActive, true),
        options.seriesCode
          ? eq(numberSeries.code, options.seriesCode)
          : eq(numberSeries.isDefault, true),
        options.legalEntityId
          ? or(
              eq(numberSeries.legalEntityId, options.legalEntityId),
              isNull(numberSeries.legalEntityId),
            )
          : undefined,
      ),
    )
    // An entity-specific series beats the tenant-wide fallback.
    .orderBy(sql`${numberSeries.legalEntityId} nulls last`)
    .limit(1)
    .for('update');

  if (!series) throw new NoNumberSeriesError(options.entityType);

  const currentPeriod = periodKey(
    series.resetFrequency,
    documentDate,
    options.fiscalYearStartMonth ?? 1,
  );

  // Reset when the period rolled over.
  const value =
    series.lastResetPeriod === currentPeriod ? series.nextValue : series.startValue;

  const formatted = formatNumber(series.pattern, {
    sequence: value,
    date: documentDate,
    padding: series.padding,
    prefix: series.prefix,
    suffix: series.suffix,
    entityCode: options.entityCode,
    projectCode: options.projectCode,
    fiscalYearStartMonth: options.fiscalYearStartMonth,
  });

  await tx
    .update(numberSeries)
    .set({
      nextValue: value + series.increment,
      lastResetPeriod: currentPeriod,
      updatedAt: new Date(),
    })
    .where(eq(numberSeries.id, series.id));

  // The allocation log is what proves a gapless series really is gapless.
  await tx.insert(numberAllocation).values({
    tenantId,
    seriesId: series.id,
    period: currentPeriod,
    value,
    formatted,
    entityId: options.entityId,
    allocatedBy: userId,
  });

  return {
    formatted,
    value,
    seriesId: series.id,
    seriesCode: series.code,
    period: currentPeriod,
  };
}

/**
 * Marks an allocated number as void.
 *
 * The number stays consumed on purpose. A cancelled tax invoice is reversed,
 * not erased, and reusing its number would break the very guarantee the gapless
 * series exists to provide.
 */
export async function voidNumber(
  tx: Transaction,
  input: { seriesId: string; period: string; value: number; reason: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  await tx
    .update(numberAllocation)
    .set({ isVoided: true, voidReason: input.reason, updatedAt: new Date() })
    .where(
      and(
        eq(numberAllocation.tenantId, tenantId),
        eq(numberAllocation.seriesId, input.seriesId),
        eq(numberAllocation.period, input.period),
        eq(numberAllocation.value, input.value),
      ),
    );
}

/**
 * Creates the series a module declares in its manifest. Called when a tenant
 * enables the module; idempotent, so re-enabling is safe.
 */
export async function provisionSeries(
  tx: Transaction,
  input: {
    tenantId: string;
    series: { entityType: string; code: string; pattern: string }[];
  },
): Promise<number> {
  let created = 0;
  for (const definition of input.series) {
    const inserted = await tx
      .insert(numberSeries)
      .values({
        tenantId: input.tenantId,
        entityType: definition.entityType,
        code: definition.code,
        name: definition.code,
        pattern: definition.pattern,
        // Tax-relevant documents default to gapless. A tenant can widen this,
        // never narrow it below what their country requires.
        isGapless: /invoice|credit_note|tax/i.test(definition.entityType),
      })
      .onConflictDoNothing({ target: [numberSeries.tenantId, numberSeries.code] })
      .returning({ id: numberSeries.id });

    created += inserted.length;
  }
  return created;
}
