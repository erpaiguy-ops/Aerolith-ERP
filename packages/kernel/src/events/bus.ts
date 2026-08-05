/**
 * Typed event bus over the transactional outbox.
 *
 * `emit()` writes to `kernel.event_outbox` inside the caller's transaction. It
 * does NOT deliver — delivery is the dispatcher's job, after commit. That
 * separation is the whole point: a module cannot publish an event for work that
 * rolled back, and cannot commit work whose event was lost.
 *
 * Handlers must be idempotent. Delivery is at-least-once, and
 * `kernel.event_consumption` turns the second delivery into a no-op.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { type Database, type Transaction } from '../db';
import { eventConsumption, eventOutbox } from '../db/schema';
import { getTenantContext, runAsSystem } from '../tenancy/context';

export interface DomainEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  sourceModule: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  metadata: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt: Date;
}

export type EventHandler<TPayload = Record<string, unknown>> = (
  event: DomainEvent<TPayload>,
) => Promise<void>;

export interface EmitInput<TPayload = Record<string, unknown>> {
  type: string;
  sourceModule: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  version?: number;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  /** Delay delivery — useful for "notify if still unapproved in 24h". */
  availableAt?: Date;
}

/** Writes an event to the outbox in the caller's transaction. */
export async function emit<TPayload extends Record<string, unknown>>(
  tx: Transaction,
  input: EmitInput<TPayload>,
): Promise<string> {
  const context = getTenantContext();
  const tenantId = input.tenantId ?? context?.tenantId;
  if (!tenantId) {
    throw new Error(
      `Cannot emit "${input.type}" without a tenant. Pass tenantId explicitly for ` +
        'platform-level events.',
    );
  }

  const [row] = await tx
    .insert(eventOutbox)
    .values({
      tenantId,
      eventType: input.type,
      eventVersion: input.version ?? 1,
      sourceModule: input.sourceModule,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      metadata: {
        ...input.metadata,
        actorId: context?.userId ?? null,
        actorType: context?.actorType ?? 'system',
        requestId: context?.requestId ?? null,
      },
      correlationId: input.correlationId ?? context?.requestId ?? null,
      causationId: input.causationId ?? null,
      availableAt: input.availableAt ?? new Date(),
    })
    .returning({ id: eventOutbox.id });

  if (!row) throw new Error(`Failed to write "${input.type}" to the outbox.`);
  return row.id;
}

// ---------------------------------------------------------------------------

interface Subscription {
  consumerKey: string;
  moduleKey: string;
  eventType: string;
  handler: EventHandler<never>;
}

export class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  /**
   * `consumerKey` identifies this handler for idempotency and must be stable
   * across restarts — it is the key in `event_consumption`. Renaming it causes
   * every past event to be redelivered.
   */
  subscribe<TPayload extends Record<string, unknown>>(
    eventType: string,
    consumer: { moduleKey: string; consumerKey: string; handler: EventHandler<TPayload> },
  ): this {
    const existing = this.subscriptions.get(eventType) ?? [];
    if (existing.some((s) => s.consumerKey === consumer.consumerKey)) {
      throw new Error(
        `Consumer "${consumer.consumerKey}" is already subscribed to "${eventType}".`,
      );
    }
    existing.push({
      consumerKey: consumer.consumerKey,
      moduleKey: consumer.moduleKey,
      eventType,
      handler: consumer.handler as EventHandler<never>,
    });
    this.subscriptions.set(eventType, existing);
    return this;
  }

  subscribersOf(eventType: string): readonly Subscription[] {
    return this.subscriptions.get(eventType) ?? [];
  }

  /** Every event type with at least one subscriber. */
  subscribedTypes(): string[] {
    return [...this.subscriptions.keys()].sort();
  }
}

// ---------------------------------------------------------------------------

export interface DispatcherOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** Exponential backoff base, in seconds. */
  retryBackoffSeconds?: number;
}

/**
 * Drains the outbox once and returns how many events were handled.
 *
 * Kept as a single explicit pass rather than an internal loop so the caller
 * owns the schedule — a job runner in production, a direct call in tests.
 */
export async function dispatchOutboxBatch(
  db: Database,
  bus: EventBus,
  options: DispatcherOptions = {},
): Promise<{ processed: number; failed: number }> {
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff = options.retryBackoffSeconds ?? 30;

  // SKIP LOCKED lets several dispatcher instances run without fighting over the
  // same rows — needed the moment there is more than one app process.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.status, 'pending'), lte(eventOutbox.availableAt, new Date())))
      .orderBy(asc(eventOutbox.occurredAt))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    await tx
      .update(eventOutbox)
      .set({ status: 'processing' })
      .where(
        sql`${eventOutbox.id} in ${sql.raw(`(${rows.map((r) => `'${r.id}'`).join(',')})`)}`,
      );

    return rows;
  });

  let processed = 0;
  let failed = 0;

  for (const row of claimed) {
    const event: DomainEvent = {
      id: row.id,
      type: row.eventType,
      version: row.eventVersion,
      tenantId: row.tenantId,
      sourceModule: row.sourceModule,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: row.payload,
      metadata: row.metadata,
      correlationId: row.correlationId,
      causationId: row.causationId,
      occurredAt: row.occurredAt,
    };

    const subscribers = bus.subscribersOf(event.type);
    let hadError: unknown = null;

    for (const subscriber of subscribers) {
      try {
        await db.transaction(async (tx) => {
          // Idempotency: claim the (event, consumer) pair first. A duplicate
          // delivery violates the unique constraint and aborts before the
          // handler can run twice.
          const inserted = await tx
            .insert(eventConsumption)
            .values({
              eventId: event.id,
              consumerKey: subscriber.consumerKey,
              tenantId: event.tenantId,
            })
            .onConflictDoNothing()
            .returning({ id: eventConsumption.id });

          if (inserted.length === 0) return; // already handled

          await runAsSystem(event.tenantId, () =>
            (subscriber.handler as EventHandler)(event),
          );
        });
      } catch (error) {
        hadError = error;
      }
    }

    if (hadError) {
      failed += 1;
      const attempts = row.attempts + 1;
      const dead = attempts >= maxAttempts;
      await db
        .update(eventOutbox)
        .set({
          status: dead ? 'dead' : 'pending',
          attempts,
          lastError: hadError instanceof Error ? hadError.message : String(hadError),
          availableAt: new Date(Date.now() + backoff * 1000 * 2 ** (attempts - 1)),
        })
        .where(eq(eventOutbox.id, row.id));
    } else {
      processed += 1;
      await db
        .update(eventOutbox)
        .set({ status: 'delivered', deliveredAt: new Date(), attempts: row.attempts + 1 })
        .where(eq(eventOutbox.id, row.id));
    }
  }

  return { processed, failed };
}
