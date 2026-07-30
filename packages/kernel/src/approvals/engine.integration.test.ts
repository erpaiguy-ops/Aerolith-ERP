/**
 * End-to-end approval and numbering, against a real database.
 *
 * Skipped when TEST_DATABASE_URL is unset. See isolation.integration.test.ts.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getDatabase,
  withTenant,
  type Transaction,
} from '../db';
import * as schema from '../db/schema';
import { runWithTenantContext, type TenantContext } from '../tenancy/context';
import { allocateNumber, provisionSeries } from '../numbering/service';
import { decide, recall, requestApproval } from './engine';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = '33333333-3333-4333-8333-333333333333';
const REQUESTER = 'aaaaaaaa-0000-4000-8000-000000000001';
const MANAGER = 'aaaaaaaa-0000-4000-8000-000000000002';
const DIRECTOR = 'aaaaaaaa-0000-4000-8000-000000000003';
const QS = 'aaaaaaaa-0000-4000-8000-000000000004';

suite('approval engine and numbering', () => {
  const context = (userId: string): TenantContext => ({
    tenantId: TENANT,
    userId,
    actorType: 'user',
    locale: 'en',
    timezone: 'Asia/Dubai',
    requestId: '99999999-9999-4999-8999-999999999999',
  });

  const as = <T>(userId: string, fn: () => Promise<T>) =>
    runWithTenantContext(context(userId), fn);

  /** The engine and numbering both take the caller's transaction. */
  const tx = <T>(userId: string, fn: (t: Transaction) => Promise<T>) =>
    as(userId, () => withTenant(fn));

  let managerRoleId: string;
  let directorRoleId: string;

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'approval-test',
      name: 'Approval Test Co',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });

    for (const [id, email, name] of [
      [REQUESTER, 'requester@test.local', 'Requester'],
      [MANAGER, 'manager@test.local', 'Manager'],
      [DIRECTOR, 'director@test.local', 'Director'],
      [QS, 'qs@test.local', 'Quantity Surveyor'],
    ] as const) {
      await db.insert(schema.appUser).values({ id, email, name });
    }

    const [manager] = await db
      .insert(schema.role)
      .values({ tenantId: TENANT, code: 'manager', name: 'Manager', isApprovalTarget: true })
      .returning({ id: schema.role.id });
    const [director] = await db
      .insert(schema.role)
      .values({ tenantId: TENANT, code: 'director', name: 'Director', isApprovalTarget: true })
      .returning({ id: schema.role.id });

    managerRoleId = manager!.id;
    directorRoleId = director!.id;

    await db.insert(schema.userRole).values([
      { tenantId: TENANT, userId: MANAGER, roleId: managerRoleId },
      { tenantId: TENANT, userId: DIRECTOR, roleId: directorRoleId },
      // The requester also holds the manager role — the engine must not let
      // them approve their own document.
      { tenantId: TENANT, userId: REQUESTER, roleId: managerRoleId },
    ]);
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(schema.notification).where(eq(schema.notification.tenantId, TENANT));
    await db.delete(schema.approvalAction).where(eq(schema.approvalAction.tenantId, TENANT));
    await db.delete(schema.approvalTask).where(eq(schema.approvalTask.tenantId, TENANT));
    await db.delete(schema.approvalInstance).where(eq(schema.approvalInstance.tenantId, TENANT));
    await db
      .delete(schema.approvalWorkflowVersion)
      .where(eq(schema.approvalWorkflowVersion.tenantId, TENANT));
    await db.delete(schema.approvalWorkflow).where(eq(schema.approvalWorkflow.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.userRole).where(eq(schema.userRole.tenantId, TENANT));
    await db.delete(schema.role).where(eq(schema.role.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, REQUESTER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, MANAGER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, DIRECTOR));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, QS));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await closeDatabase();
  });

  /** Publishes a workflow and returns its id. */
  async function publishWorkflow(
    code: string,
    definition: schema.WorkflowDefinition,
    priority = 100,
    fallback: 'block' | 'auto_approve' = 'auto_approve',
  ) {
    const db = getDatabase();
    const [workflow] = await db
      .insert(schema.approvalWorkflow)
      .values({
        tenantId: TENANT,
        entityType: definition.entityType,
        code,
        name: code,
        priority,
        fallbackBehaviour: fallback,
      })
      .returning({ id: schema.approvalWorkflow.id });

    await db.insert(schema.approvalWorkflowVersion).values({
      tenantId: TENANT,
      workflowId: workflow!.id,
      version: 1,
      definition,
    });

    return workflow!.id;
  }

  beforeEach(async () => {
    const db = getDatabase();
    await db.delete(schema.notification).where(eq(schema.notification.tenantId, TENANT));
    await db.delete(schema.approvalAction).where(eq(schema.approvalAction.tenantId, TENANT));
    await db.delete(schema.approvalTask).where(eq(schema.approvalTask.tenantId, TENANT));
    await db.delete(schema.approvalInstance).where(eq(schema.approvalInstance.tenantId, TENANT));
    await db
      .delete(schema.approvalWorkflowVersion)
      .where(eq(schema.approvalWorkflowVersion.tenantId, TENANT));
    await db.delete(schema.approvalWorkflow).where(eq(schema.approvalWorkflow.tenantId, TENANT));
  });

  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('runs a two-step sequential approval end to end', async () => {
      await publishWorkflow('po-standard', {
        entityType: 'procurement.purchase_order',
        conditions: [],
        steps: [
          { sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' },
          { sequence: 2, name: 'Director', approverType: 'role', approverRef: 'director' },
        ],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'procurement.purchase_order',
          entityId: '55555555-5555-4555-8555-555555555001',
          moduleKey: 'procurement',
          context: { amount: 25000 },
          amount: 25000,
          currencyCode: 'AED',
        }),
      );

      expect(requested.state).toBe('pending');
      // The requester holds the manager role but must not approve their own PO.
      expect(requested.pendingApprovers).toEqual([MANAGER]);

      // Opening a step notifies its approvers — the manager, not the
      // requester and not the director, who is not up yet.
      const managerNotifications = await getDatabase()
        .select()
        .from(schema.notification)
        .where(eq(schema.notification.recipientId, MANAGER));
      expect(managerNotifications).toHaveLength(1);
      expect(managerNotifications[0]!.typeKey).toBe('kernel.approval.requested');
      expect(managerNotifications[0]!.actionUrl).toBe('/approvals');
      expect(managerNotifications[0]!.entityId).toBe(requested.instanceId);

      const directorNotificationsBefore = await getDatabase()
        .select()
        .from(schema.notification)
        .where(eq(schema.notification.recipientId, DIRECTOR));
      expect(directorNotificationsBefore).toHaveLength(0);

      const tasks = await getDatabase()
        .select()
        .from(schema.approvalTask)
        .where(eq(schema.approvalTask.instanceId, requested.instanceId!));

      const managerTask = tasks.find((t) => t.approverId === MANAGER)!;
      const afterManager = await tx(MANAGER, (t) =>
        decide(t, { taskId: managerTask.id, decision: 'approved' }),
      );

      expect(afterManager.instanceState).toBe('pending');
      expect(afterManager.nextApprovers).toEqual([DIRECTOR]);

      // The second step opening notifies the director in turn.
      const directorNotifications = await getDatabase()
        .select()
        .from(schema.notification)
        .where(eq(schema.notification.recipientId, DIRECTOR));
      expect(directorNotifications).toHaveLength(1);

      const directorTask = (
        await getDatabase()
          .select()
          .from(schema.approvalTask)
          .where(
            and(
              eq(schema.approvalTask.instanceId, requested.instanceId!),
              eq(schema.approvalTask.approverId, DIRECTOR),
            ),
          )
      )[0]!;

      const afterDirector = await tx(DIRECTOR, (t) =>
        decide(t, { taskId: directorTask.id, decision: 'approved' }),
      );

      expect(afterDirector.instanceState).toBe('approved');
    });

    it('adds a step only above its amount threshold', async () => {
      await publishWorkflow('po-threshold', {
        entityType: 'procurement.purchase_order',
        conditions: [],
        steps: [
          { sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' },
          {
            sequence: 2,
            name: 'Director',
            approverType: 'role',
            approverRef: 'director',
            conditions: [{ field: 'amount', operator: 'gt', value: 100000 }],
          },
        ],
      });

      const small = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'procurement.purchase_order',
          entityId: '55555555-5555-4555-8555-555555555002',
          moduleKey: 'procurement',
          context: { amount: 5000 },
        }),
      );

      const managerTask = (
        await getDatabase()
          .select()
          .from(schema.approvalTask)
          .where(eq(schema.approvalTask.instanceId, small.instanceId!))
      )[0]!;

      // Below the threshold, the manager's approval completes it.
      const result = await tx(MANAGER, (t) =>
        decide(t, { taskId: managerTask.id, decision: 'approved' }),
      );
      expect(result.instanceState).toBe('approved');
    });

    it('auto-approves when no workflow is configured', async () => {
      const result = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'inventory.stock_transfer',
          entityId: '55555555-5555-4555-8555-555555555003',
          moduleKey: 'inventory',
          context: {},
        }),
      );

      expect(result.state).toBe('approved');
      expect(result.instanceId).toBeNull();
      expect(result.autoApprovedReason).toBeTruthy();
    });

    it('blocks instead of auto-approving when the tenant says so', async () => {
      await publishWorkflow(
        'po-strict',
        {
          entityType: 'contracts.variation',
          conditions: [{ field: 'amount', operator: 'gt', value: 1_000_000 }],
          steps: [{ sequence: 1, name: 'Director', approverType: 'role', approverRef: 'director' }],
        },
        100,
        'block',
      );

      await expect(
        tx(REQUESTER, (t) =>
          requestApproval(t, {
            entityType: 'contracts.variation',
            entityId: '55555555-5555-4555-8555-555555555004',
            moduleKey: 'contracts',
            context: { amount: 500 },
          }),
        ),
      ).rejects.toThrow(/No approval workflow matches/);
    });
  });

  describe('parallel steps and quorum', () => {
    it('waits for every approver when the quorum is "all"', async () => {
      await getDatabase()
        .insert(schema.userRole)
        .values({ tenantId: TENANT, userId: QS, roleId: directorRoleId });

      await publishWorkflow('ipc-parallel', {
        entityType: 'contracts.payment_certificate',
        conditions: [],
        steps: [
          {
            sequence: 1,
            name: 'Commercial',
            approverType: 'role',
            approverRef: 'director',
            quorum: 'all',
          },
        ],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'contracts.payment_certificate',
          entityId: '55555555-5555-4555-8555-555555555005',
          moduleKey: 'contracts',
          context: {},
        }),
      );

      expect(requested.pendingApprovers.sort()).toEqual([DIRECTOR, QS].sort());

      const tasks = await getDatabase()
        .select()
        .from(schema.approvalTask)
        .where(eq(schema.approvalTask.instanceId, requested.instanceId!));

      const first = await tx(DIRECTOR, (t) =>
        decide(t, { taskId: tasks.find((t2) => t2.approverId === DIRECTOR)!.id, decision: 'approved' }),
      );
      expect(first.instanceState).toBe('pending');

      const second = await tx(QS, (t) =>
        decide(t, { taskId: tasks.find((t2) => t2.approverId === QS)!.id, decision: 'approved' }),
      );
      expect(second.instanceState).toBe('approved');

      await getDatabase()
        .delete(schema.userRole)
        .where(and(eq(schema.userRole.tenantId, TENANT), eq(schema.userRole.userId, QS)));
    });

    it('completes on the first approval when the quorum is "any", and skips the rest', async () => {
      await getDatabase()
        .insert(schema.userRole)
        .values({ tenantId: TENANT, userId: QS, roleId: directorRoleId });

      await publishWorkflow('any-quorum', {
        entityType: 'projects.rfi',
        conditions: [],
        steps: [
          { sequence: 1, name: 'Any Director', approverType: 'role', approverRef: 'director', quorum: 'any' },
        ],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'projects.rfi',
          entityId: '55555555-5555-4555-8555-555555555006',
          moduleKey: 'projects',
          context: {},
        }),
      );

      const tasks = await getDatabase()
        .select()
        .from(schema.approvalTask)
        .where(eq(schema.approvalTask.instanceId, requested.instanceId!));

      const result = await tx(DIRECTOR, (t) =>
        decide(t, { taskId: tasks.find((t2) => t2.approverId === DIRECTOR)!.id, decision: 'approved' }),
      );
      expect(result.instanceState).toBe('approved');

      const after = await getDatabase()
        .select()
        .from(schema.approvalTask)
        .where(eq(schema.approvalTask.instanceId, requested.instanceId!));

      // The other approver no longer has anything in their inbox.
      expect(after.find((t2) => t2.approverId === QS)?.state).toBe('skipped');

      await getDatabase()
        .delete(schema.userRole)
        .where(and(eq(schema.userRole.tenantId, TENANT), eq(schema.userRole.userId, QS)));
    });
  });

  describe('rejection, recall and guards', () => {
    async function openSimpleRequest(entityId: string) {
      await publishWorkflow('simple', {
        entityType: 'procurement.purchase_order',
        conditions: [],
        steps: [
          { sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' },
          { sequence: 2, name: 'Director', approverType: 'role', approverRef: 'director' },
        ],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'procurement.purchase_order',
          entityId,
          moduleKey: 'procurement',
          context: { amount: 1000 },
        }),
      );

      const tasks = await getDatabase()
        .select()
        .from(schema.approvalTask)
        .where(eq(schema.approvalTask.instanceId, requested.instanceId!));

      return { requested, tasks };
    }

    it('a rejection stops the whole request', async () => {
      const { requested, tasks } = await openSimpleRequest('55555555-5555-4555-8555-555555555007');

      const result = await tx(MANAGER, (t) =>
        decide(t, { taskId: tasks[0]!.id, decision: 'rejected', comment: 'Budget exceeded' }),
      );

      expect(result.instanceState).toBe('rejected');

      const [instance] = await getDatabase()
        .select()
        .from(schema.approvalInstance)
        .where(eq(schema.approvalInstance.id, requested.instanceId!));
      expect(instance?.state).toBe('rejected');
      expect(instance?.completedAt).not.toBeNull();
    });

    it('refuses a decision from somebody the task is not assigned to', async () => {
      const { tasks } = await openSimpleRequest('55555555-5555-4555-8555-555555555008');

      await expect(
        tx(DIRECTOR, (t) => decide(t, { taskId: tasks[0]!.id, decision: 'approved' })),
      ).rejects.toThrow(/assigned to somebody else/);
    });

    it('refuses to decide the same task twice', async () => {
      const { tasks } = await openSimpleRequest('55555555-5555-4555-8555-555555555009');

      await tx(MANAGER, (t) => decide(t, { taskId: tasks[0]!.id, decision: 'approved' }));
      await expect(
        tx(MANAGER, (t) => decide(t, { taskId: tasks[0]!.id, decision: 'rejected' })),
      ).rejects.toThrow(/already been/);
    });

    it('enforces a required comment', async () => {
      await publishWorkflow('comment-required', {
        entityType: 'inventory.stock_write_off',
        conditions: [],
        steps: [
          {
            sequence: 1,
            name: 'Manager',
            approverType: 'role',
            approverRef: 'manager',
            requireComment: true,
          },
        ],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'inventory.stock_write_off',
          entityId: '55555555-5555-4555-8555-555555555010',
          moduleKey: 'inventory',
          context: {},
        }),
      );

      const task = (
        await getDatabase()
          .select()
          .from(schema.approvalTask)
          .where(eq(schema.approvalTask.instanceId, requested.instanceId!))
      )[0]!;

      await expect(
        tx(MANAGER, (t) => decide(t, { taskId: task.id, decision: 'approved' })),
      ).rejects.toThrow(/requires a comment/);

      const ok = await tx(MANAGER, (t) =>
        decide(t, { taskId: task.id, decision: 'approved', comment: 'Damaged in transit' }),
      );
      expect(ok.instanceState).toBe('approved');
    });

    it('lets the requester recall, but nobody else', async () => {
      const { requested } = await openSimpleRequest('55555555-5555-4555-8555-555555555011');

      await expect(
        tx(MANAGER, (t) => recall(t, { instanceId: requested.instanceId! })),
      ).rejects.toThrow(/Only the requester/);

      await tx(REQUESTER, (t) =>
        recall(t, { instanceId: requested.instanceId!, reason: 'Wrong supplier' }),
      );

      const [instance] = await getDatabase()
        .select()
        .from(schema.approvalInstance)
        .where(eq(schema.approvalInstance.id, requested.instanceId!));
      expect(instance?.state).toBe('recalled');
    });
  });

  describe('workflow version pinning', () => {
    it('keeps an in-flight approval on the rules it started under', async () => {
      // Editing the matrix mid-flight must not change what is already running.
      const workflowId = await publishWorkflow('pinned', {
        entityType: 'contracts.variation',
        conditions: [],
        steps: [{ sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' }],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'contracts.variation',
          entityId: '55555555-5555-4555-8555-555555555012',
          moduleKey: 'contracts',
          context: { amount: 10000 },
        }),
      );

      // Publish v2, adding a director step.
      const db = getDatabase();
      await db
        .update(schema.approvalWorkflowVersion)
        .set({ isCurrent: false })
        .where(eq(schema.approvalWorkflowVersion.workflowId, workflowId));
      await db.insert(schema.approvalWorkflowVersion).values({
        tenantId: TENANT,
        workflowId,
        version: 2,
        definition: {
          entityType: 'contracts.variation',
          conditions: [],
          steps: [
            { sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' },
            { sequence: 2, name: 'Director', approverType: 'role', approverRef: 'director' },
          ],
        },
      });

      const task = (
        await db
          .select()
          .from(schema.approvalTask)
          .where(eq(schema.approvalTask.instanceId, requested.instanceId!))
      )[0]!;

      const result = await tx(MANAGER, (t) =>
        decide(t, { taskId: task.id, decision: 'approved' }),
      );

      // v1 had one step, so the manager's approval completes it.
      expect(result.instanceState).toBe('approved');
      expect(result.nextApprovers).toEqual([]);
    });
  });

  describe('events', () => {
    it('writes outbox rows in the same transaction as the approval', async () => {
      await publishWorkflow('evented', {
        entityType: 'procurement.purchase_order',
        conditions: [],
        steps: [{ sequence: 1, name: 'Manager', approverType: 'role', approverRef: 'manager' }],
      });

      const requested = await tx(REQUESTER, (t) =>
        requestApproval(t, {
          entityType: 'procurement.purchase_order',
          entityId: '55555555-5555-4555-8555-555555555013',
          moduleKey: 'procurement',
          context: { amount: 1 },
        }),
      );

      const task = (
        await getDatabase()
          .select()
          .from(schema.approvalTask)
          .where(eq(schema.approvalTask.instanceId, requested.instanceId!))
      )[0]!;

      await tx(MANAGER, (t) => decide(t, { taskId: task.id, decision: 'approved' }));

      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.aggregateId, requested.instanceId!));

      expect(events.map((e) => e.type).sort()).toEqual([
        'kernel.approval.approved',
        'kernel.approval.requested',
      ]);
    });
  });

  // -------------------------------------------------------------------------

  describe('number allocation', () => {
    beforeAll(async () => {
      await tx(REQUESTER, (t) =>
        provisionSeries(t, {
          tenantId: TENANT,
          series: [
            { entityType: 'test.invoice', code: 'TESTINV', pattern: 'INV-{YYYY}-{SEQ}' },
            { entityType: 'test.grn', code: 'TESTGRN', pattern: 'GRN-{PROJECT}-{SEQ}' },
          ],
        }),
      );
    });

    it('allocates consecutive numbers', async () => {
      const first = await tx(REQUESTER, (t) =>
        allocateNumber(t, { entityType: 'test.invoice', documentDate: new Date('2026-03-01') }),
      );
      const second = await tx(REQUESTER, (t) =>
        allocateNumber(t, { entityType: 'test.invoice', documentDate: new Date('2026-03-02') }),
      );

      expect(first.formatted).toBe('INV-2026-00001');
      expect(second.formatted).toBe('INV-2026-00002');
    });

    it('resets the sequence when the year rolls over', async () => {
      const next = await tx(REQUESTER, (t) =>
        allocateNumber(t, { entityType: 'test.invoice', documentDate: new Date('2027-01-05') }),
      );
      expect(next.formatted).toBe('INV-2027-00001');
    });

    it('serialises concurrent allocation without issuing a duplicate', async () => {
      // The row lock is the whole point: ten parallel requests, ten distinct
      // numbers, no gaps.
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          tx(REQUESTER, (t) =>
            allocateNumber(t, { entityType: 'test.grn', projectCode: 'P001' }),
          ),
        ),
      );

      const values = results.map((r) => r.value).sort((a, b) => a - b);
      expect(new Set(values).size).toBe(10);
      expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('logs every allocation so a gapless series is provable', async () => {
      const rows = await getDatabase()
        .select()
        .from(schema.numberAllocation)
        .where(eq(schema.numberAllocation.tenantId, TENANT));

      expect(rows.length).toBeGreaterThanOrEqual(13);
      expect(rows.every((r) => r.formatted.length > 0)).toBe(true);
    });

    it('marks tax-relevant series gapless by default', async () => {
      const [series] = await getDatabase()
        .select()
        .from(schema.numberSeries)
        .where(
          and(eq(schema.numberSeries.tenantId, TENANT), eq(schema.numberSeries.code, 'TESTINV')),
        );

      expect(series?.isGapless).toBe(true);
    });

    it('reports a missing series clearly rather than failing obscurely', async () => {
      await expect(
        tx(REQUESTER, (t) => allocateNumber(t, { entityType: 'nothing.here' })),
      ).rejects.toThrow(/No active number series/);
    });
  });
});
