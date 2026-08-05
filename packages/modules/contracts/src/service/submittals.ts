/**
 * The submittal register's write path — the fit-out approval clock.
 *
 * A shop drawing, sample or method statement is raised, submitted for review,
 * and either approved, approved with a note, sent back for revision, or
 * rejected. A revision that comes back "revise and resubmit" starts a new
 * cycle rather than editing the old one in place, so the register can show
 * how many rounds a drawing actually took — the fact a folder of PDFs on a
 * shared drive cannot answer.
 */
import {
  allocateNumber,
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, desc, eq } from 'drizzle-orm';

import { contract, submittal, submittalRevision } from '../db/schema';

const MODULE_KEY = 'contracts';

export class SubmittalError extends Error {
  override readonly name = 'SubmittalError';
}

const VALID_TYPES = [
  'shop_drawing',
  'material_sample',
  'method_statement',
  'product_data',
  'mock_up',
  'other',
];

const VALID_DECISIONS = ['approved', 'approved_as_noted', 'revise_resubmit', 'rejected'];

/** Terminal — nothing further is expected of the contractor on this drawing. */
const CLOSED_STATUSES = new Set(['approved', 'approved_as_noted']);

export interface CreateSubmittalInput {
  contractId: string;
  title: string;
  submittalType: string;
  specSection?: string | null;
}

export async function createSubmittal(
  tx: Transaction,
  input: CreateSubmittalInput,
): Promise<{ id: string; number: string }> {
  const { tenantId } = requireTenantContext();

  if (!VALID_TYPES.includes(input.submittalType)) {
    throw new SubmittalError(`"${input.submittalType}" is not a submittal type.`);
  }

  const [head] = await tx
    .select({ id: contract.id })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));
  if (!head) throw new SubmittalError('Contract not found.');

  const allocated = await allocateNumber(tx, { entityType: 'contracts.submittal' });

  const [row] = await tx
    .insert(submittal)
    .values({
      tenantId,
      contractId: input.contractId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      title: input.title,
      submittalType: input.submittalType,
      specSection: input.specSection,
    })
    .returning({ id: submittal.id });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.submittal',
    entityId: row!.id,
    entityLabel: allocated.formatted,
    action: 'create',
  });

  return { id: row!.id, number: allocated.formatted };
}

export interface SubmitRevisionInput {
  submittalId: string;
  documentId?: string | null;
  submittedOn: string;
  dueOn?: string | null;
}

/**
 * Starts a new review cycle. The revision number is always the register's
 * own count plus one — nothing about a resubmission is optional or supplied
 * by the caller, the same reasoning `createBudgetVersion` and `addDocumentVersion`
 * already apply to their own histories.
 */
export async function submitRevision(
  tx: Transaction,
  input: SubmitRevisionInput,
): Promise<{ revisionId: string; revision: number }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(submittal)
    .where(and(eq(submittal.tenantId, tenantId), eq(submittal.id, input.submittalId)));
  if (!existing) throw new SubmittalError('Submittal not found.');

  if (CLOSED_STATUSES.has(existing.status)) {
    throw new SubmittalError('This submittal is already approved and needs no further revision.');
  }

  const revision = existing.currentRevision + 1;

  const [row] = await tx
    .insert(submittalRevision)
    .values({
      tenantId,
      submittalId: input.submittalId,
      revision,
      documentId: input.documentId,
      submittedOn: input.submittedOn,
      dueOn: input.dueOn,
    })
    .returning({ id: submittalRevision.id });

  await tx
    .update(submittal)
    .set({
      status: 'under_review',
      ballInCourt: 'consultant',
      currentRevision: revision,
      updatedAt: new Date(),
    })
    .where(eq(submittal.id, input.submittalId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.submittal',
    entityId: input.submittalId,
    entityLabel: existing.number ?? existing.id,
    action: 'update',
    reason: `Revision ${revision} submitted for review.`,
  });

  return { revisionId: row!.id, revision };
}

export interface RecordReviewInput {
  submittalId: string;
  decision: string;
  reviewedOn: string;
  reviewComments?: string | null;
}

/**
 * Records the consultant's decision on the CURRENT revision — never an
 * arbitrary one, because reviewing an old revision after a newer one was
 * already submitted answers a question nobody is asking any more.
 */
export async function recordReview(tx: Transaction, input: RecordReviewInput): Promise<void> {
  const { tenantId } = requireTenantContext();

  if (!VALID_DECISIONS.includes(input.decision)) {
    throw new SubmittalError(`"${input.decision}" is not a review decision.`);
  }

  const [existing] = await tx
    .select()
    .from(submittal)
    .where(and(eq(submittal.tenantId, tenantId), eq(submittal.id, input.submittalId)));
  if (!existing) throw new SubmittalError('Submittal not found.');

  if (existing.currentRevision === 0) {
    throw new SubmittalError('Nothing has been submitted for review yet.');
  }

  const [currentRevisionRow] = await tx
    .select()
    .from(submittalRevision)
    .where(
      and(
        eq(submittalRevision.tenantId, tenantId),
        eq(submittalRevision.submittalId, input.submittalId),
        eq(submittalRevision.revision, existing.currentRevision),
      ),
    );
  if (!currentRevisionRow) throw new SubmittalError('The current revision could not be found.');
  if (currentRevisionRow.decision) {
    throw new SubmittalError('This revision has already been reviewed.');
  }

  await tx
    .update(submittalRevision)
    .set({
      decision: input.decision,
      reviewedOn: input.reviewedOn,
      reviewComments: input.reviewComments,
      updatedAt: new Date(),
    })
    .where(eq(submittalRevision.id, currentRevisionRow.id));

  // Reviewed, either way, puts the ball back on the contractor: to proceed
  // once approved, or to raise the next revision once it is not.
  await tx
    .update(submittal)
    .set({ status: input.decision, ballInCourt: 'contractor', updatedAt: new Date() })
    .where(eq(submittal.id, input.submittalId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.submittal',
    entityId: input.submittalId,
    entityLabel: existing.number ?? existing.id,
    action: 'update',
    reason: `Revision ${existing.currentRevision} reviewed: ${input.decision.replace(/_/g, ' ')}.`,
  });
}

export interface SubmittalRevisionRow {
  id: string;
  revision: number;
  documentId: string | null;
  submittedOn: string;
  dueOn: string | null;
  reviewedOn: string | null;
  decision: string | null;
  reviewComments: string | null;
}

export interface SubmittalDetail {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  number: string | null;
  title: string;
  submittalType: string;
  specSection: string | null;
  status: string;
  ballInCourt: string;
  currentRevision: number;
  revisions: SubmittalRevisionRow[];
}

export async function getSubmittalDetail(
  tx: Transaction,
  submittalId: string,
): Promise<SubmittalDetail | null> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({
      id: submittal.id,
      contractId: submittal.contractId,
      contractNumber: contract.number,
      contractName: contract.name,
      number: submittal.number,
      title: submittal.title,
      submittalType: submittal.submittalType,
      specSection: submittal.specSection,
      status: submittal.status,
      ballInCourt: submittal.ballInCourt,
      currentRevision: submittal.currentRevision,
    })
    .from(submittal)
    .innerJoin(contract, eq(contract.id, submittal.contractId))
    .where(and(eq(submittal.tenantId, tenantId), eq(submittal.id, submittalId)));
  if (!head) return null;

  const revisions = await tx
    .select({
      id: submittalRevision.id,
      revision: submittalRevision.revision,
      documentId: submittalRevision.documentId,
      submittedOn: submittalRevision.submittedOn,
      dueOn: submittalRevision.dueOn,
      reviewedOn: submittalRevision.reviewedOn,
      decision: submittalRevision.decision,
      reviewComments: submittalRevision.reviewComments,
    })
    .from(submittalRevision)
    .where(
      and(eq(submittalRevision.tenantId, tenantId), eq(submittalRevision.submittalId, submittalId)),
    )
    .orderBy(desc(submittalRevision.revision));

  return { ...head, revisions };
}
