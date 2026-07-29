import { Empty, PageHeader } from '@/components/ui';

/**
 * Not found, rendered INSIDE the shell.
 *
 * The boundary placement is the point: a `notFound()` thrown anywhere in the
 * `(app)` group renders here with the navigation still beside it, so somebody
 * who mistyped an address or followed a stale link can go somewhere useful
 * instead of landing on a bare 404 with no way back.
 *
 * It names both readings, because they are indistinguishable from the address
 * bar and have different fixes. A screen you have no permission for answers the
 * same way as one that does not exist — deliberately, and for the same reason
 * the API answers 404 rather than 403 for a module a tenant has not bought: a
 * screen you cannot reach must not confirm it exists. Saying so here is what
 * stops that being mysterious rather than merely quiet.
 */
export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <Empty
        title="There is nothing at this address"
        detail="Either the address is wrong, or your account has no role that reaches this screen. If you expected to see something here, an administrator can check your roles on the People page."
      />
    </>
  );
}
