'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

export async function submitEstimateAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const estimateId = form.get('estimateId');
  if (typeof estimateId !== 'string') {
    return { status: 'error', error: 'That estimate could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/estimating/estimates/${estimateId}/submit`, { method: 'POST' }),
    {
      revalidate: [
        `/estimating/estimates/${estimateId}`,
        '/estimating/estimates',
        '/estimating/tenders',
      ],
      success: "Submitted as the tender's bid.",
    },
  );
}

/**
 * Raises a work order from the estimate's measured lines.
 *
 * No routing or project picker: this converts with the tender's own project and
 * whatever routing (if any) the resulting order needs assigned afterwards on the
 * work order screen. Keeping the fields required here would ask a commercial
 * user, mid-conversion, a production-planning question they are not the person
 * to answer.
 */
export async function convertToWorkOrderAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const estimateId = form.get('estimateId');
  if (typeof estimateId !== 'string') {
    return { status: 'error', error: 'That estimate could not be read. Reload and try again.' };
  }

  let created: { number: string; linesConverted: number; linesSkipped: number } | undefined;

  const state = await runAction(
    async () => {
      created = await apiFetch(`/estimating/estimates/${estimateId}/convert-to-work-order`, {
        method: 'POST',
        body: {},
      });
    },
    {
      revalidate: [`/estimating/estimates/${estimateId}`, '/production/orders'],
      success: 'Work order raised.',
    },
  );

  if (state.status === 'success' && created) {
    return {
      status: 'success',
      message:
        created.linesSkipped > 0
          ? `Work order ${created.number} raised from ${created.linesConverted} line(s); ${created.linesSkipped} skipped (no material linked).`
          : `Work order ${created.number} raised from ${created.linesConverted} line(s).`,
    };
  }

  return state;
}
