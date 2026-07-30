'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

export async function awardRfqAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const rfqId = form.get('rfqId');
  const quoteId = form.get('quoteId');
  if (typeof rfqId !== 'string' || typeof quoteId !== 'string' || !quoteId) {
    return { status: 'error', error: 'Choose which quote won.' };
  }

  const rationale = form.get('rationale');

  return runAction(
    () =>
      apiFetch(`/procurement/rfqs/${rfqId}/award`, {
        method: 'POST',
        body: {
          quoteId,
          rationale: typeof rationale === 'string' && rationale.trim() !== '' ? rationale : undefined,
        },
      }),
    {
      revalidate: [`/procurement/rfqs/${rfqId}`, '/procurement/rfqs'],
      success: 'Awarded.',
    },
  );
}
