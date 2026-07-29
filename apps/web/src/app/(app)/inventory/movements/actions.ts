'use server';

import { runAction, requiredText, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

import { MOVEMENT_SHAPES, isMovementType } from './types';

/**
 * Posts a single-line stock movement.
 *
 * One line, not many. A hand-keyed movement is a receipt off a van, a issue to a
 * job, a transfer between the factory and a site, or a correction after a count —
 * all of which are one item at a time. Multi-line movements come from the
 * documents that generate them: a goods receipt against a purchase order, a
 * production output against a work order. Building a repeating line editor here
 * would mean client-side JavaScript for a case the modules that need it already
 * handle better.
 *
 * The API validates all of this again and its messages are the ones the user
 * sees when they get through. The checks below exist only so the common mistakes
 * do not cost a round trip.
 */
export async function recordMovementAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const type = form.get('type');
  if (typeof type !== 'string' || !isMovementType(type)) {
    return { status: 'error', error: 'Choose what kind of movement this is.' };
  }
  const shape = MOVEMENT_SHAPES[type];

  const itemId = requiredText(form, 'itemId');
  if (!itemId) return { status: 'error', error: 'Choose an item.' };

  const quantity = Number(form.get('quantity'));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { status: 'error', error: 'Enter a quantity greater than zero.' };
  }

  const fromWarehouseId = requiredText(form, 'fromWarehouseId');
  const toWarehouseId = requiredText(form, 'toWarehouseId');

  if (shape.from && !fromWarehouseId) {
    return { status: 'error', error: `A ${type} needs a warehouse to take stock from.` };
  }
  if (shape.to && !toWarehouseId) {
    return { status: 'error', error: `A ${type} needs a warehouse to put stock into.` };
  }
  if (type === 'transfer' && fromWarehouseId === toWarehouseId) {
    return { status: 'error', error: 'Source and destination are the same warehouse.' };
  }

  // A receipt is where cost enters the system: it is the only movement whose
  // value is not derived from stock already held, so it cannot be posted without
  // one. Everything else is valued at the cost the stock is carrying.
  const rawCost = requiredText(form, 'unitCost');
  const unitCost = rawCost === null ? null : Number(rawCost);
  if (shape.cost && (unitCost === null || !Number.isFinite(unitCost) || unitCost < 0)) {
    return { status: 'error', error: 'A receipt needs a unit cost — this is what values the stock.' };
  }

  return runAction(
    () =>
      apiFetch('/inventory/movements', {
        method: 'POST',
        body: {
          type,
          movementDate: requiredText(form, 'movementDate') ?? undefined,
          reference: requiredText(form, 'reference'),
          notes: requiredText(form, 'notes'),
          lines: [
            {
              itemId,
              quantity,
              fromWarehouseId: shape.from ? fromWarehouseId : null,
              toWarehouseId: shape.to ? toWarehouseId : null,
              unitCost: shape.cost ? unitCost : null,
            },
          ],
        },
      }),
    {
      // The stock register is the screen this movement was posted to change, so
      // it is refreshed too — a user who records a receipt and then finds the
      // old figure on `/inventory/stock` has been told the system did nothing.
      revalidate: ['/inventory/movements', '/inventory/stock', '/inventory/items'],
      success:
        type === 'adjustment'
          ? 'Adjusted. Stock now reads the counted quantity.'
          : 'Posted. Stock has moved.',
    },
  );
}
