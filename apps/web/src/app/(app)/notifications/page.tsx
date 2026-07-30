import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
import { EmptyList, FilterChips, Pager, fetchList, listQuery } from '@/components/List';
import { Card, PageHeader } from '@/components/ui';
import { datetime } from '@/lib/format';

import { markAllReadAction, markReadAction } from './actions';

interface NotificationRow {
  id: string;
  typeKey: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  actionUrl: string | null;
  priority: number;
  readAt: string | null;
  createdAt: string;
}

const BASE = '/notifications';

/**
 * The in-app inbox — the one channel of the notification centre that is
 * actually wired up. The schema also carries email, Telegram, WhatsApp and SMS
 * delivery, none of which sends yet; this screen is what a recipient sees for
 * whichever situation put something here, currently just an approval task
 * opening.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const result = await fetchList<NotificationRow>('/notifications', query);
  const hasUnread = result.rows.some((row) => !row.readAt);

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="What has been sent to you specifically, across every module."
        actions={
          hasUnread ? (
            <ActionForm action={markAllReadAction}>
              <SubmitButton pendingLabel="Marking…">Mark all read</SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />

      <div className="mb-4">
        <FilterChips
          base={BASE}
          query={query}
          param="unread"
          options={[
            { label: 'All', value: null },
            { label: 'Unread only', value: 'true' },
          ]}
        />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['notification', 'notifications']}
            hint="Notifications appear here when something needs your attention — an approval opening is the first thing that sends one."
          />
        ) : (
          <div className="divide-y divide-(--color-line)">
            {result.rows.map((row) => {
              const unread = !row.readAt;
              return (
                <div key={row.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {unread ? (
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-(--color-accent)"
                          aria-hidden="true"
                        />
                      ) : null}
                      {row.actionUrl ? (
                        <Link
                          href={row.actionUrl}
                          className={`text-(--color-accent) hover:underline ${unread ? 'font-medium' : ''}`}
                        >
                          {row.title}
                        </Link>
                      ) : (
                        <span className={unread ? 'font-medium' : ''}>{row.title}</span>
                      )}
                    </div>
                    {row.body ? (
                      <p className="mt-1 text-sm text-(--color-muted)">{row.body}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-(--color-muted)">{datetime(row.createdAt)}</p>
                  </div>

                  {unread ? (
                    <ActionForm action={markReadAction}>
                      <input type="hidden" name="notificationId" value={row.id} />
                      <SubmitButton pendingLabel="Marking…">Mark read</SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <Pager base={BASE} query={query} result={result} noun={['notification', 'notifications']} />
      </Card>
    </>
  );
}
