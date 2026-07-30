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
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { appUser, auditLog, type auditAction } from '../db/schema';
import { listResult, searchPattern, type ListParams, type ListResult } from '../db/list';
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

export const AUDIT_LOG_SORTS = ['occurredAt'] as const;
export type AuditLogSort = (typeof AUDIT_LOG_SORTS)[number];

export interface AuditLogRow {
  id: string;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorType: string;
  moduleKey: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  action: AuditAction;
  changes: Record<string, FieldChange> | null;
  redactedFields: string[] | null;
  reason: string | null;
}

export interface AuditLogFilters {
  entityType?: string;
  action?: AuditAction;
  actorId?: string;
}

/**
 * The audit trail as a whole — filtered, searched and paged. This is the query
 * an investigation actually starts from: "what happened in this workspace
 * recently", not "what happened to this one record" (`entityHistory`) or "what
 * did this one person do" (`actorActivity`), both of which need a specific ID
 * in hand before they are useful.
 *
 * `changes` is returned as written: redaction already happened in
 * `recordAudit`, so there is nothing sensitive left to filter out here.
 */
export async function listAuditEvents(
  tx: Transaction,
  params: ListParams<AuditLogSort>,
  filters: AuditLogFilters = {},
): Promise<ListResult<AuditLogRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(auditLog.tenantId, tenantId)];
  if (filters.entityType) conditions.push(eq(auditLog.entityType, filters.entityType));
  if (filters.action) conditions.push(eq(auditLog.action, filters.action));
  if (filters.actorId) conditions.push(eq(auditLog.actorId, filters.actorId));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(auditLog.entityLabel, pattern),
        ilike(appUser.name, pattern),
        ilike(appUser.email, pattern),
        ilike(auditLog.reason, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const rows = await tx
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      actorId: auditLog.actorId,
      actorName: appUser.name,
      actorEmail: appUser.email,
      actorType: auditLog.actorType,
      moduleKey: auditLog.moduleKey,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityLabel: auditLog.entityLabel,
      action: auditLog.action,
      changes: auditLog.changes,
      redactedFields: auditLog.redactedFields,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .leftJoin(appUser, eq(appUser.id, auditLog.actorId))
    .where(where)
    .orderBy(
      params.direction === 'asc' ? asc(auditLog.occurredAt) : desc(auditLog.occurredAt),
      asc(auditLog.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLog)
    .leftJoin(appUser, eq(appUser.id, auditLog.actorId))
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/**
 * Every entity type this tenant's audit trail actually contains, over the
 * WHOLE trail rather than the current filter — the same reason the
 * localisation rules screen computes its domain list unfiltered: a filter's
 * own options must not disappear once it is applied.
 */
export async function listAuditEntityTypes(tx: Transaction): Promise<string[]> {
  const { tenantId } = requireTenantContext();

  const rows = await tx
    .selectDistinct({ entityType: auditLog.entityType })
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantId))
    .orderBy(asc(auditLog.entityType));

  return rows.map((row) => row.entityType);
}

/**
 * Every action actually recorded, for the same reason: `audit_action` has
 * fourteen values, and a tenant whose modules only ever create/update/delete
 * should not be offered ten dead filter chips for actions nothing has done.
 */
export async function listAuditActions(tx: Transaction): Promise<AuditAction[]> {
  const { tenantId } = requireTenantContext();

  const rows = await tx
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantId))
    .orderBy(asc(auditLog.action));

  return rows.map((row) => row.action);
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
