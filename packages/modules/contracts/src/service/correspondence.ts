/**
 * The notice register's write path.
 *
 * `contracts.correspondence.manage` already gated the nav entry — labelled,
 * in the manifest, "Manage the notice register" — while the register itself
 * was read-only: a list route and nothing that could create or update a row.
 * An RFI, a notice, an EOT claim only ends up in the register somebody
 * remembers to type it in after the fact, which for a response deadline that
 * creates a contractual right is exactly the entitlement this register
 * exists to stop losing.
 */
import {
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';

import { contract, correspondence, variation } from '../db/schema';

const MODULE_KEY = 'contracts';

export class CorrespondenceError extends Error {
  override readonly name = 'CorrespondenceError';
}

const VALID_TYPES = ['rfi', 'notice', 'eot_claim', 'ncr', 'instruction', 'letter'];
const VALID_DIRECTIONS = ['incoming', 'outgoing'];
const VALID_STATUSES = ['open', 'responded', 'closed', 'overdue'];

export interface CreateCorrespondenceInput {
  contractId: string;
  type: string;
  reference: string;
  subject: string;
  direction?: string;
  issuedOn: string;
  responseDueOn?: string | null;
  isContractual?: boolean;
  documentId?: string | null;
}

/**
 * Raises a correspondence item. `reference` is chosen by whoever raises it,
 * not allocated — an RFI or a notice is usually numbered against whichever
 * party issued it (the consultant's "RFI-042", not the contractor's own
 * sequence), the same reasoning as a back charge's reference.
 */
export async function createCorrespondence(
  tx: Transaction,
  input: CreateCorrespondenceInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  if (!VALID_TYPES.includes(input.type)) {
    throw new CorrespondenceError(`"${input.type}" is not a correspondence type.`);
  }
  const direction = input.direction ?? 'outgoing';
  if (!VALID_DIRECTIONS.includes(direction)) {
    throw new CorrespondenceError(`"${direction}" is not a direction.`);
  }

  const [head] = await tx
    .select({ id: contract.id, number: contract.number })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));
  if (!head) throw new CorrespondenceError('Contract not found.');

  const [row] = await tx
    .insert(correspondence)
    .values({
      tenantId,
      contractId: input.contractId,
      type: input.type,
      reference: input.reference,
      subject: input.subject,
      direction,
      issuedOn: input.issuedOn,
      responseDueOn: input.responseDueOn,
      isContractual: input.isContractual ?? false,
      documentId: input.documentId,
    })
    .onConflictDoNothing({ target: [correspondence.contractId, correspondence.type, correspondence.reference] })
    .returning({ id: correspondence.id });

  if (!row) {
    throw new CorrespondenceError(
      `"${input.reference}" is already in use for this type on this contract.`,
    );
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.correspondence',
    entityId: row.id,
    entityLabel: `${input.reference} — ${head.number ?? head.id}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateCorrespondenceInput {
  respondedOn?: string | null;
  status?: string;
  responseDueOn?: string | null;
  variationId?: string | null;
  documentId?: string | null;
}

/**
 * Records a response, closes an item, or links it to the variation it
 * became — the `variationId` the register has always displayed
 * ("became VO-2026-00003") but nothing ever set.
 */
export async function updateCorrespondence(
  tx: Transaction,
  input: { correspondenceId: string } & UpdateCorrespondenceInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(correspondence)
    .where(and(eq(correspondence.tenantId, tenantId), eq(correspondence.id, input.correspondenceId)));
  if (!existing) throw new CorrespondenceError('Correspondence item not found.');

  if (input.status && !VALID_STATUSES.includes(input.status)) {
    throw new CorrespondenceError(`"${input.status}" is not a status.`);
  }

  if (input.variationId !== undefined && input.variationId !== null) {
    const [linkedVariation] = await tx
      .select({ id: variation.id })
      .from(variation)
      .where(
        and(
          eq(variation.tenantId, tenantId),
          eq(variation.id, input.variationId),
          eq(variation.contractId, existing.contractId),
        ),
      );
    if (!linkedVariation) {
      throw new CorrespondenceError('That variation does not belong to the same contract.');
    }
  }

  // Recording a response without ever picking a status would leave an
  // answered item still filtered by `openOnly` — `respondedOn` and `status`
  // are set together so the register's "awaiting a reply" filter stays true.
  const status =
    input.status ?? (input.respondedOn !== undefined && input.respondedOn !== null
      ? 'responded'
      : existing.status);

  await tx
    .update(correspondence)
    .set({
      respondedOn: input.respondedOn !== undefined ? input.respondedOn : existing.respondedOn,
      status,
      responseDueOn: input.responseDueOn !== undefined ? input.responseDueOn : existing.responseDueOn,
      variationId: input.variationId !== undefined ? input.variationId : existing.variationId,
      documentId: input.documentId !== undefined ? input.documentId : existing.documentId,
      updatedAt: new Date(),
    })
    .where(eq(correspondence.id, input.correspondenceId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.correspondence',
    entityId: input.correspondenceId,
    entityLabel: existing.reference,
    action: 'update',
  });
}
