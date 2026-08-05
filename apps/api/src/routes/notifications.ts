/**
 * The notification inbox.
 *
 * Kernel-level and ungated by module, same as approvals: whatever put a
 * notification in front of a user, the user must be able to read and clear
 * it regardless of which module's entitlement produced it.
 */
import {
  NOTIFICATION_SORTS,
  NotificationError,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  parseListParams,
  unreadNotificationCount,
  withTenant,
} from '@aerolith/kernel';
import type { FastifyInstance } from 'fastify';

import { authenticate, withPrincipal } from '../context';

interface NotificationQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  unread?: string;
}

export async function notificationRoutes(app: FastifyInstance) {
  app.get<{ Querystring: NotificationQuery }>('/notifications', async (request) => {
    const principal = await authenticate(request);

    const params = parseListParams(request.query, {
      sortable: NOTIFICATION_SORTS,
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listNotifications(tx, params, {
          recipientId: principal.userId,
          unreadOnly: request.query.unread === 'true',
        }),
      ),
    );
  });

  /** For a bell badge — its own endpoint so the shell does not pay for the whole inbox on every page. */
  app.get('/notifications/unread-count', async (request) => {
    const principal = await authenticate(request);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({
        count: await unreadNotificationCount(tx, { recipientId: principal.userId }),
      })),
    );
  });

  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (request, reply) => {
    const principal = await authenticate(request);

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          markNotificationRead(tx, { notificationId: request.params.id, recipientId: principal.userId }),
        ),
      );
    } catch (error) {
      if (error instanceof NotificationError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }

    return { read: true };
  });

  app.post('/notifications/read-all', async (request) => {
    const principal = await authenticate(request);

    await withPrincipal(principal, () =>
      withTenant((tx) => markAllNotificationsRead(tx, { recipientId: principal.userId })),
    );

    return { read: true };
  });
}
