import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createWorkflowAction, publishVersionAction, setWorkflowActiveAction } from './actions';

interface Step {
  sequence: number;
  name: string;
  approverType: string;
  approverRef?: string;
  quorum?: string;
  quorumCount?: number;
}

interface WorkflowRow {
  id: string;
  entityType: string;
  code: string;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  fallbackBehaviour: string;
  currentVersion: number | null;
  steps: Step[];
  inFlight: number;
}

const APPROVER_TYPES = [
  { value: 'role', label: 'A role' },
  { value: 'user', label: 'A named person' },
  { value: 'manager_of_requester', label: "The requester's manager" },
  { value: 'department_head', label: 'Department head' },
  { value: 'project_manager', label: 'Project manager' },
  { value: 'legal_entity_owner', label: 'Legal entity owner' },
  { value: 'cost_centre_owner', label: 'Cost centre owner' },
];

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

function StepRows({ index, step }: { index: number; step?: Step }) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-xs text-(--color-muted)">{`Step ${index + 1}`}</span>
        <input
          name={`step.${index}.name`}
          defaultValue={step?.name ?? ''}
          placeholder="Commercial manager"
          dir="auto"
          className={field}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-(--color-muted)">Approved by</span>
        <select
          name={`step.${index}.approverType`}
          defaultValue={step?.approverType ?? 'role'}
          className={field}
        >
          {APPROVER_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-(--color-muted)">Role code or user id</span>
        <input
          name={`step.${index}.approverRef`}
          defaultValue={step?.approverRef ?? ''}
          placeholder="commercial-manager"
          className={field}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-(--color-muted)">Quorum</span>
        <select name={`step.${index}.quorum`} defaultValue={step?.quorum ?? ''} className={field}>
          <option value="">Any one</option>
          <option value="all">All of them</option>
          <option value="majority">A majority</option>
        </select>
      </label>
    </div>
  );
}

/**
 * Approval workflows — who signs off what, and at which value.
 *
 * `kernel.approval_workflow.manage` was declared from the start and gated
 * nothing. The engine could route an approval, resolve approvers, hold a quorum
 * and pin a running instance to the version it started under; nothing could
 * create the workflow it routes by, so every workflow came from a seed script.
 *
 * Editing publishes a NEW version rather than rewriting the current one —
 * `approval_instance` points at the exact version it started under, so a
 * half-finished approval keeps being judged by the rules it began with. The
 * in-flight count is shown next to the publish button because that is where
 * somebody needs to know it is safe.
 */
export default async function WorkflowsPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.approval_workflow.manage') || me.user.isOwner;

  const { workflows, approvableEntityTypes } = await pageFetch<{
    workflows: WorkflowRow[];
    approvableEntityTypes: string[];
  }>('/approvals/workflows');

  return (
    <>
      <PageHeader
        title="Approval workflows"
        subtitle="Who signs off what. Editing publishes a new version; approvals already running keep the one they started on."
      />

      {workflows.length === 0 ? (
        <Card>
          <Empty
            title="No approval workflows yet"
            detail="Until one exists, anything submitted for approval falls back to the module's own default."
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {workflows.map((workflow) => (
            <Card key={workflow.id}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="numeric font-medium">{workflow.code}</span>
                  <span className="ml-2 text-sm">{workflow.name}</span>
                  <span className="numeric ml-2 text-xs text-(--color-muted)">
                    {workflow.entityType}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {workflow.currentVersion ? (
                    <Badge tone="neutral">{`v${workflow.currentVersion}`}</Badge>
                  ) : null}
                  <Badge tone={workflow.isActive ? 'good' : 'bad'}>
                    {workflow.isActive ? 'active' : 'inactive'}
                  </Badge>
                </div>
              </div>

              <Table
                head={
                  <tr>
                    <Th>Order</Th>
                    <Th>Step</Th>
                    <Th>Approved by</Th>
                    <Th>Quorum</Th>
                  </tr>
                }
              >
                {workflow.steps.map((step, index) => (
                  <tr key={`${step.sequence}-${index}`}>
                    <Td numeric>{step.sequence}</Td>
                    <Td>{step.name}</Td>
                    <Td>
                      {step.approverType.replace(/_/g, ' ')}
                      {step.approverRef ? (
                        <span className="numeric block text-xs text-(--color-muted)">
                          {step.approverRef}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{step.quorum ?? 'any one'}</Td>
                  </tr>
                ))}
              </Table>

              {mayManage ? (
                <div className="mt-4 border-t border-(--color-line) pt-4">
                  {workflow.inFlight > 0 ? (
                    <p className="mb-3 text-xs text-(--color-muted)">
                      {`${integer(workflow.inFlight)} approval${workflow.inFlight === 1 ? '' : 's'} running under this
                        workflow. Publishing a new version does not disturb ${workflow.inFlight === 1 ? 'it' : 'them'} —
                        each one keeps the version it started on.`}
                    </p>
                  ) : null}

                  <ActionForm
                    action={publishVersionAction.bind(null, workflow.id)}
                    className="grid gap-3"
                  >
                    {[0, 1, 2, 3].map((index) => (
                      <StepRows key={index} index={index} step={workflow.steps[index]} />
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <SubmitButton pendingLabel="Publishing…">Publish new version</SubmitButton>
                    </div>
                  </ActionForm>

                  <div className="mt-3">
                    <ActionForm
                      action={setWorkflowActiveAction.bind(null, workflow.id, !workflow.isActive)}
                    >
                      <SubmitButton pendingLabel="…">
                        {workflow.isActive ? 'Deactivate' : 'Activate'}
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      {mayManage ? (
        <Card title="New workflow" className="mt-4">
          <ActionForm action={createWorkflowAction} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Approves</span>
                <select name="entityType" defaultValue="" className={field}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {approvableEntityTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
                <input name="code" placeholder="PO-STANDARD" className={field} />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                <input
                  name="name"
                  dir="auto"
                  placeholder="Purchase orders over 10,000"
                  className={field}
                />
              </label>
            </div>

            {[0, 1, 2, 3].map((index) => (
              <StepRows key={index} index={index} />
            ))}

            <p className="text-xs text-(--color-muted)">
              A step approved by a role or a named person must say which — the engine resolves it to
              nobody otherwise, and the approval would stall with nothing to say why. Blank rows are
              ignored.
            </p>

            <div>
              <SubmitButton pendingLabel="Creating…">Create workflow</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
