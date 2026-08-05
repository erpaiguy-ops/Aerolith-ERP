/**
 * Notification centre — the in-app inbox.
 *
 * The schema (`db/schema/notifications.ts`) also carries a template/channel/
 * delivery/preference model for email, Telegram, WhatsApp and SMS, none of
 * which is wired up here. This file is the one slice of it that is real: a
 * notification is created, it appears in the recipient's inbox, and they can
 * mark it read. Multi-channel delivery, template rendering and quiet hours
 * are a real project on top of this, not an afternoon's addition — building
 * them against an inbox nobody could see yet would be building blind.
 *
 * `notify`/`notifyMany` never throw into the caller's transaction over a
 * notification failure in spirit — see `tryNotify` — for the same reason
 * `tryRecordAudit` exists: an approval request must not fail because the
 * message telling someone about it could not be written.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { notification } from '../db/schema';
import { listResult, type ListParams, type ListResult } from '../db/list';
import { requireTenantContext } from '../tenancy/context';

export interface NotifyInput {
  recipientId: string;
  /** Which notifiable situation this is — `kernel.approval.requested`, etc. */
  typeKey: string;
  title: string;
  body?: string | null;
  /** Deep link into the entity that caused it. */
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
  /** Higher sorts first. Left at the default for routine notices. */
  priority?: number;
  data?: Record<string, unknown>;
}

export async function notify(tx: Transaction, input: NotifyInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .insert(notification)
    .values({
      tenantId,
      recipientId: input.recipientId,
      typeKey: input.typeKey,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      actionUrl: input.actionUrl,
      priority: input.priority ?? 0,
      data: input.data ?? {},
    })
    .returning({ id: notification.id });

  return { id: row!.id };
}

/** The same notification, fanned out to several recipients — one step opening for five approvers. */
export async function notifyMany(
  tx: Transaction,
  input: { recipientIds: string[] } & Omit<NotifyInput, 'recipientId'>,
): Promise<void> {
  if (input.recipientIds.length === 0) return;
  const { tenantId } = requireTenantContext();

  await tx.insert(notification).values(
    input.recipientIds.map((recipientId) => ({
      tenantId,
      recipientId,
      typeKey: input.typeKey,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      actionUrl: input.actionUrl,
      priority: input.priority ?? 0,
      data: input.data ?? {},
    })),
  );
}

/**
 * Best-effort notification that never breaks the operation it is about.
 *
 * Losing a notification is bad; failing an approval request because the
 * notification insert failed is worse — exactly `tryRecordAudit`'s reasoning,
 * applied to the other kernel side-effect every module gets for free.
 */
export async function tryNotifyMany(
  tx: Transaction,
  input: { recipientIds: string[] } & Omit<NotifyInput, 'recipientId'>,
): Promise<void> {
  try {
    await notifyMany(tx, input);
  } catch {
    // Deliberately swallowed.
  }
}

export interface NotificationRow {
  id: string;
  typeKey: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  actionUrl: string | null;
  priority: number;
  readAt: Date | null;
  createdAt: Date;
}

export const NOTIFICATION_SORTS = ['createdAt'] as const;
export type NotificationSort = (typeof NOTIFICATION_SORTS)[number];

/** One recipient's inbox — unarchived notifications, newest first. */
export async function listNotifications(
  tx: Transaction,
  params: ListParams<NotificationSort>,
  filters: { recipientId: string; unreadOnly?: boolean },
): Promise<ListResult<NotificationRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [
    eq(notification.tenantId, tenantId),
    eq(notification.recipientId, filters.recipientId),
    isNull(notification.archivedAt),
  ];
  if (filters.unreadOnly) conditions.push(isNull(notification.readAt));

  const where = and(...conditions);

  const rows = await tx
    .select({
      id: notification.id,
      typeKey: notification.typeKey,
      title: notification.title,
      body: notification.body,
      entityType: notification.entityType,
      entityId: notification.entityId,
      actionUrl: notification.actionUrl,
      priority: notification.priority,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .where(where)
    .orderBy(desc(notification.priority), desc(notification.createdAt))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(notification)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/** For a bell badge — cheap enough to call on every page load. */
export async function unreadNotificationCount(
  tx: Transaction,
  input: { recipientId: string },
): Promise<number> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(notification)
    .where(
      and(
        eq(notification.tenantId, tenantId),
        eq(notification.recipientId, input.recipientId),
        isNull(notification.readAt),
        isNull(notification.archivedAt),
      ),
    );

  return row?.total ?? 0;
}

export class NotificationError extends Error {
  override readonly name = 'NotificationError';
}

/**
 * Marks one notification read. Scoped to the recipient, not just the tenant —
 * a notification is addressed to a person, and nothing lets a colleague clear
 * another's inbox by guessing an id.
 */
export async function markNotificationRead(
  tx: Transaction,
  input: { notificationId: string; recipientId: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .update(notification)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(notification.tenantId, tenantId),
        eq(notification.id, input.notificationId),
        eq(notification.recipientId, input.recipientId),
      ),
    )
    .returning({ id: notification.id });

  if (!row) throw new NotificationError('Notification not found.');
}

export async function markAllNotificationsRead(
  tx: Transaction,
  input: { recipientId: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  await tx
    .update(notification)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(notification.tenantId, tenantId),
        eq(notification.recipientId, input.recipientId),
        isNull(notification.readAt),
      ),
    );
}
