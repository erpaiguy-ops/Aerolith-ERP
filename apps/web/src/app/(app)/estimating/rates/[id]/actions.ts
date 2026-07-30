'use server';

import { revalidatePath } from 'next/cache';

import { ApiError, apiFetch } from '@/lib/api';

export interface RateComponentInput {
  type: string;
  description: string | null;
  itemId: string | null;
  quantityPerUnit: number;
  unitRate: number;
  wastagePercent: number | null;
}

export interface SaveRateBuildUpInput {
  rateItemId: string;
  overheadPercent: number | null;
  marginPercent: number | null;
  components: RateComponentInput[];
}

export type SaveRateBuildUpResult = { ok: true } | { ok: false; error: string };

/**
 * Persists a whole build-up in one round trip — the save behind the grid.
 *
 * Called directly from the client grid (not through a `<form action>`, since
 * the payload is a live array of rows rather than `FormData`), which is why
 * this returns a plain result object instead of the `ActionState` shape the
 * rest of the app's forms use — there is no `useActionState` here to consume
 * it. The grid calls `router.refresh()` itself once this resolves.
 *
 * Two calls, not one: the header (overhead, margin) is a separate endpoint
 * from the components, because the API keeps "manage the rate" as one
 * permission but the two things a rate has are still logically distinct —
 * the components existed as their own resource before this screen did.
 */
export async function saveRateBuildUp(input: SaveRateBuildUpInput): Promise<SaveRateBuildUpResult> {
  try {
    await apiFetch(`/estimating/rates/${input.rateItemId}`, {
      method: 'PATCH',
      body: {
        overheadPercent: input.overheadPercent,
        marginPercent: input.marginPercent,
      },
    });
    await apiFetch(`/estimating/rates/${input.rateItemId}/components`, {
      method: 'PUT',
      body: { components: input.components },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: error.isUnauthenticated ? 'Your session has expired. Sign in again.' : error.message,
      };
    }
    console.error('rate build-up save failed', error);
    return {
      ok: false,
      error: 'Something went wrong. The failure has been logged.',
    };
  }

  revalidatePath(`/estimating/rates/${input.rateItemId}`);
  revalidatePath('/estimating/rates');
  return { ok: true };
}
