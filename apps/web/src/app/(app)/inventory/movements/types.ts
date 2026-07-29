/**
 * Which movement types the hand-keying form offers, and what each one needs.
 *
 * A separate module from `actions.ts` because a `'use server'` file may only
 * export async functions — every export becomes a callable server endpoint, so a
 * constant or a type guard living there fails the build. Keeping the table here
 * also means the page can render the type list without pulling in the action.
 *
 * `production_output` is deliberately absent. It exists to book finished goods
 * out of a work order, and the production module posts it with the work order id
 * attached; recording one by hand would create stock that traces back to nothing.
 * The gap is the control. It still appears in the filter chips, because the
 * ledger must show movements this screen cannot create.
 */
export const MOVEMENT_SHAPES = {
  receipt: { from: false, to: true, cost: true },
  issue: { from: true, to: false, cost: false },
  transfer: { from: true, to: true, cost: false },
  adjustment: { from: false, to: true, cost: false },
  return: { from: false, to: true, cost: false },
  scrap: { from: true, to: false, cost: false },
} as const;

export type MovementType = keyof typeof MOVEMENT_SHAPES;

export const MOVEMENT_TYPES = Object.keys(MOVEMENT_SHAPES) as MovementType[];

export function isMovementType(value: string): value is MovementType {
  return value in MOVEMENT_SHAPES;
}
