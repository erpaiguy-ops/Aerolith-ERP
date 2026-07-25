/**
 * Audit trail.
 *
 * Append-only, and enforced as such in the database (see src/db/rls.ts) — the
 * app role has no UPDATE or DELETE on `audit_log`.
 *
 * Field-level redaction is applied before writing. Salary, passport and bank
 * details must not be reconstructable from the audit trail, which would
 * otherwise become the easiest way around field-level permissions.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { auditLog, type auditAction } from '../db/schema';
import { getTenantContext, requireTenantContext } from '../tenancy/context';

export type AuditAction = (typeof auditAction.enumValues)[number];

/**
 * Field names whose values are replaced with a marker. Matched
 * case-insensitively against the whole field path, so `employee.basicSalary`
 * and `basicSalary` both hit.
 */
export const DEFAULT_REDACTED_FIELDS = [
  'password',
  'passwordhash',
  'salary',
  'basicsalary',
  'grosssalary',
  'netpay',
  'bankaccount',
  'iban',
  'accountnumber',
  'passportnumber',
  'nationalid',
  'emiratesid',
  'totpsecret',
  'recoverycodes',
  'apikey',
  'token',
  'secret',
];

const REDACTED = '[redacted]';

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface RecordAuditInput {
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  action: AuditAction;
  moduleKey?: string;
  changes?: Record<string, FieldChange>;
  reason?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Extra fields to redact beyond the defaults. */
  redactFields?: string[];
}

export async function recordAudit(tx: Transaction, input: RecordAuditInput): Promise<void> {
  const context = requireTenantContext();
  const { changes, redacted } = redactChanges(input.changes, input.redactFields);

  await tx.insert(auditLog).values({
    tenantId: context.tenantId,
    actorId: context.userId,
    actorType: context.actorType,
    moduleKey: input.moduleKey,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? null,
    action: input.action,
    changes,
    redactedFields: redacted.length > 0 ? redacted : null,
    requestId: context.requestId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    reason: input.reason,
    metadata: input.metadata ?? {},
  });
}

/**
 * Builds a change set from before/after snapshots, keeping only what actually
 * changed. Storing whole rows makes the audit table larger than the data it
 * audits and buries the one field somebody needs to find.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: { ignore?: string[] } = {},
): Record<string, FieldChange> {
  const ignore = new Set([
    'updatedAt',
    'createdAt',
    'updatedBy',
    'createdBy',
    ...(options.ignore ?? []),
  ]);

  const changes: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const key of keys) {
    if (ignore.has(key)) continue;
    const from = before?.[key];
    const to = after?.[key];
    if (!isEqual(from, to)) changes[key] = { from, to };
  }

  return changes;
}

export function redactChanges(
  changes: Record<string, FieldChange> | undefined,
  extra: string[] = [],
): { changes: Record<string, FieldChange> | null; redacted: string[] } {
  if (!changes || Object.keys(changes).length === 0) {
    return { changes: null, redacted: [] };
  }

  const sensitive = new Set(
    [...DEFAULT_REDACTED_FIELDS, ...extra].map((f) => f.toLowerCase().replace(/[_-]/g, '')),
  );

  const result: Record<string, FieldChange> = {};
  const redacted: string[] = [];

  for (const [field, change] of Object.entries(changes)) {
    const normalised = field.toLowerCase().replace(/[_-]/g, '');
    const isSensitive = [...sensitive].some((s) => normalised.includes(s));

    if (isSensitive) {
      // Record THAT it changed, never what it changed to.
      result[field] = { from: REDACTED, to: REDACTED };
      redacted.push(field);
    } else {
      result[field] = change;
    }
  }

  return { changes: result, redacted };
}

/** The history of one entity, newest first. */
export async function entityHistory(
  tx: Transaction,
  input: { entityType: string; entityId: string; limit?: number },
) {
  const { tenantId } = requireTenantContext();

  return tx
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.entityType, input.entityType),
        eq(auditLog.entityId, input.entityId),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(input.limit ?? 100);
}

/**
 * Everything one actor did in a window — the query an investigation actually
 * starts from.
 */
export async function actorActivity(
  tx: Transaction,
  input: { actorId: string; from: Date; to: Date; limit?: number },
) {
  const { tenantId } = requireTenantContext();

  return tx
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.actorId, input.actorId),
        sql`${auditLog.occurredAt} between ${input.from} and ${input.to}`,
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(input.limit ?? 500);
}

/** Best-effort audit that never breaks the operation it is recording. */
export async function tryRecordAudit(tx: Transaction, input: RecordAuditInput): Promise<void> {
  try {
    if (!getTenantContext()) return;
    await recordAudit(tx, input);
  } catch {
    // Deliberately swallowed. Losing an audit row is bad; failing a goods
    // receipt because the audit row failed is worse. Real failures surface
    // through the error rate on this path, not by breaking the caller.
  }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
