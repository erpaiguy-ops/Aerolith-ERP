'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

interface StepInput {
  sequence: number;
  name: string;
  approverType: string;
  approverRef?: string;
  quorum?: string;
  quorumCount?: number;
}

/**
 * Reads the repeated step rows out of a plain form.
 *
 * Steps are `step.0.name`, `step.1.name` and so on rather than a JSON blob in a
 * hidden field, so the form still works as a form — no client component holds
 * the list in state, and a submitted page reflects exactly what was on screen.
 * Rows left entirely blank are dropped rather than validated, because an empty
 * row is somebody deciding they wanted three steps and not four.
 */
function readSteps(form: FormData): StepInput[] {
  const steps: StepInput[] = [];

  for (let index = 0; index < 10; index += 1) {
    const name = form.get(`step.${index}.name`);
    const approverType = form.get(`step.${index}.approverType`);
    if (typeof name !== 'string' || name.trim() === '') continue;

    const quorum = form.get(`step.${index}.quorum`);
    const quorumCount = form.get(`step.${index}.quorumCount`);
    const approverRef = form.get(`step.${index}.approverRef`);

    steps.push({
      sequence: steps.length + 1,
      name: name.trim(),
      approverType: typeof approverType === 'string' ? approverType : 'role',
      approverRef:
        typeof approverRef === 'string' && approverRef.trim() !== ''
          ? approverRef.trim()
          : undefined,
      quorum: typeof quorum === 'string' && quorum !== '' ? quorum : undefined,
      quorumCount:
        typeof quorumCount === 'string' && quorumCount.trim() !== ''
          ? Number(quorumCount)
          : undefined,
    });
  }

  return steps;
}

export async function createWorkflowAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const entityType = requiredText(form, 'entityType');
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  const steps = readSteps(form);

  if (!entityType) return { status: 'error', error: 'Choose what this approves.' };
  if (!code) return { status: 'error', error: 'Give the workflow a code.' };
  if (!name) return { status: 'error', error: 'Give the workflow a name.' };
  if (steps.length === 0) {
    return { status: 'error', error: 'Add at least one step, or nothing is being approved.' };
  }

  return runAction(
    () =>
      apiFetch('/approvals/workflows', {
        method: 'POST',
        body: {
          entityType,
          code,
          name,
          description: requiredText(form, 'description'),
          steps,
        },
      }),
    { revalidate: ['/settings/workflows'], success: `${name} created.` },
  );
}

export async function publishVersionAction(
  workflowId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const steps = readSteps(form);
  if (steps.length === 0) {
    return { status: 'error', error: 'A workflow needs at least one step.' };
  }

  return runAction(
    () =>
      apiFetch(`/approvals/workflows/${workflowId}/versions`, {
        method: 'POST',
        body: { steps },
      }),
    {
      revalidate: ['/settings/workflows'],
      // Said explicitly: the safety property is the reason this is a publish
      // and not a save, and it is the thing an admin is most likely to worry
      // about when clicking it.
      success: 'New version published. Approvals already running keep the version they started on.',
    },
  );
}

export async function setWorkflowActiveAction(
  workflowId: string,
  isActive: boolean,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch(`/approvals/workflows/${workflowId}`, { method: 'PATCH', body: { isActive } }),
    {
      revalidate: ['/settings/workflows'],
      success: isActive ? 'Workflow activated.' : 'Workflow deactivated.',
    },
  );
}
