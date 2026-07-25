import { redirect } from 'next/navigation';

import { landingPath } from '@/lib/navigation';
import { getMe } from '@/lib/session';

/**
 * The root sends the user to the first screen they can actually open.
 *
 * There is no dashboard, and inventing one now would be guessing at what matters
 * before any user has said. A tenant entitled only to Estimating has no use for
 * a cross-module dashboard anyway.
 */
export default async function Home() {
  const me = await getMe();
  redirect(landingPath(me.navigation));
}
