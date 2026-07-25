import { notFound } from 'next/navigation';

import { Empty, PageHeader } from '@/components/ui';
import { flattenNav } from '@/lib/navigation';
import { getMe } from '@/lib/session';

/**
 * A nav destination the API offers but the web app has not built yet.
 *
 * The modules ship more screens than this app implements — Inventory,
 * Production and Estimating all have working APIs and no UI. Letting those
 * links 404 outside the shell would make the app look broken; a placeholder
 * INSIDE the shell keeps navigation working and makes the gap explicit rather
 * than mysterious.
 *
 * A genuinely wrong URL still gets a real 404 from `notFound()` below, so this
 * does not turn every typo into a friendly page.
 */
export default async function NotBuiltPage({ params }: { params: Promise<{ rest: string[] }> }) {
  const { rest } = await params;
  const path = `/${(rest ?? []).join('/')}`;

  const me = await getMe();
  const item = flattenNav(me.navigation).find((nav) => nav.path === path);

  // `notFound()` throws, but TypeScript only knows that from the `never`
  // return, which a dynamic import loses.
  if (!item) notFound();

  return (
    <>
      <PageHeader title={item.label} />
      <Empty
        title="This screen is not built yet"
        detail={`The API behind ${path} works and is covered by tests — the interface is what is missing. Projects and Contracts are the two built so far.`}
      />
    </>
  );
}
