import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, ProgressBar, Stat } from '@/components/ui';
import { can, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch, pageFetch } from '@/lib/api';
import { date, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

interface WbsNode {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  depth: number;
  ruleOfCredit: 'binary' | 'started_finished' | 'units' | 'milestone' | 'manual';
  unitsPlanned: string | null;
  uomCode: string | null;
  creditMilestones: { key: string; label?: string; weightPercent: number }[];
  budgetValue: string;
  percentComplete: string;
  lastMeasuredOn: string | null;
  rolledUpBudgetValue: number;
  rolledUpPercentComplete: number;
  rolledUpEarnedValue: number;
  containsManualClaims: boolean;
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

/**
 * Records a period's measured progress.
 *
 * Every field is namespaced by node id and only the ones the node's rule of
 * credit accepts are read. Sending a units figure for a milestone node would be
 * ignored by the service anyway — it will not let the wrong evidence bypass the
 * rule — but building the form so it cannot happen means a user never wonders
 * why the number they typed did nothing.
 */
async function record(
  projectId: string,
  nodes: WbsNode[],
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  'use server';

  const periodEnd = String(form.get('periodEnd') ?? '');
  if (!periodEnd) return { status: 'error', error: 'Choose the period this measurement covers.' };

  const measurements: Record<string, unknown>[] = [];

  for (const node of nodes) {
    const field = (suffix: string) => form.get(`${node.id}.${suffix}`);

    switch (node.ruleOfCredit) {
      case 'units': {
        const raw = field('units');
        if (typeof raw !== 'string' || raw.trim() === '') break;
        const unitsComplete = Number(raw);
        if (!Number.isFinite(unitsComplete)) break;
        measurements.push({ wbsCode: node.code, unitsComplete });
        break;
      }
      case 'binary': {
        // An unchecked box is absent from the form data, so it cannot be told
        // apart from "not measured this period" — which is why it is only sent
        // when ticked. Un-finishing a node is a correction, not a measurement.
        if (field('finished') === 'on') measurements.push({ wbsCode: node.code, finished: true });
        break;
      }
      case 'started_finished': {
        const started = field('started') === 'on';
        const finished = field('finished') === 'on';
        if (started || finished) measurements.push({ wbsCode: node.code, started, finished });
        break;
      }
      case 'milestone': {
        const achieved = node.creditMilestones
          .filter((m) => field(`ms.${m.key}`) === 'on')
          .map((m) => m.key);
        if (achieved.length > 0) {
          measurements.push({ wbsCode: node.code, milestonesAchieved: achieved });
        }
        break;
      }
      case 'manual': {
        const raw = field('manual');
        if (typeof raw !== 'string' || raw.trim() === '') break;
        const manualPercent = Number(raw);
        if (!Number.isFinite(manualPercent)) break;
        measurements.push({ wbsCode: node.code, manualPercent });
        break;
      }
    }
  }

  if (measurements.length === 0) {
    return {
      status: 'error',
      error: 'Nothing was measured. Fill in at least one line before recording the period.',
    };
  }

  return runAction(
    () =>
      apiFetch(`/projects/${projectId}/progress`, {
        method: 'POST',
        body: { periodEnd, measurements },
      }),
    {
      revalidate: [
        `/projects/${projectId}/progress`,
        `/projects/${projectId}`,
        // The contract's valuation is measured from this. Leaving it stale would
        // show a payment application priced on last month's progress.
        '/contracts',
      ],
      success: 'Recorded.',
    },
  );
}

const RULE_LABEL: Record<WbsNode['ruleOfCredit'], string> = {
  binary: 'Complete or not',
  started_finished: 'Started / finished',
  units: 'Units',
  milestone: 'Milestones',
  manual: 'Self-assessed',
};

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let wbs: { nodes: WbsNode[] };
  try {
    wbs = await pageFetch<{ nodes: WbsNode[] }>(`/projects/${id}/wbs`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  // Only leaves are measured. A parent's percentage is the value-weighted
  // roll-up of its children, and offering an input for it would let somebody
  // type a number that the next roll-up silently overwrites.
  const parents = new Set(wbs.nodes.map((n) => n.parentId).filter(Boolean));
  const leaves = wbs.nodes.filter((node) => !parents.has(node.id));

  const mayRecord = can(me.permissions, 'projects.progress.record');
  const mayOverride = can(me.permissions, 'projects.progress.override');
  const currency = me.tenant.currencyCode;

  const root = wbs.nodes.find((n) => n.parentId == null);
  const today = new Date().toISOString().slice(0, 10);

  const action = record.bind(null, id, leaves);

  if (!mayRecord) {
    return (
      <>
        <PageHeader title="Progress" subtitle="Measured against the rules of credit." />
        <Card>
          <p className="text-sm text-(--color-muted)">
            You do not have permission to record progress on this job.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Record progress"
        subtitle={`${leaves.length} measurable line${leaves.length === 1 ? '' : 's'} · rules of credit decide what evidence counts`}
      />

      {root ? (
        <Card className="mb-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Complete" value={percent(root.rolledUpPercentComplete)} />
            <Stat
              label="Earned"
              value={<Money amount={root.rolledUpEarnedValue} currency={currency} />}
            />
            <Stat
              label="Budget"
              value={<Money amount={root.rolledUpBudgetValue} currency={currency} />}
            />
            <Stat
              label="Self-assessed"
              value={root.containsManualClaims ? 'in the roll-up' : 'none'}
              tone={root.containsManualClaims ? 'bad' : 'neutral'}
              hint={root.containsManualClaims ? 'some of this figure is an opinion' : undefined}
            />
          </div>
        </Card>
      ) : null}

      <ActionForm action={action}>
        <Card
          title="Measurement"
          footnote="A line left blank is not measured this period — it keeps whatever it was last measured at, rather than dropping to zero."
        >
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="periodEnd" className="mb-1 block text-xs text-(--color-muted)">
                Period ending
              </label>
              <input
                id="periodEnd"
                name="periodEnd"
                type="date"
                required
                defaultValue={today}
                className="rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
              />
            </div>
            <SubmitButton pendingLabel="Recording…">Record period</SubmitButton>
          </div>

          <div className="space-y-3">
            {leaves.map((node) => (
              <div
                key={node.id}
                className="grid gap-3 border-t border-(--color-line) pt-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)]"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="numeric text-xs text-(--color-muted)">{node.code}</span>
                    <span className="text-sm">{node.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone={node.ruleOfCredit === 'manual' ? 'bad' : 'neutral'}>
                      {RULE_LABEL[node.ruleOfCredit]}
                    </Badge>
                    <span className="text-xs text-(--color-muted)">
                      <Money amount={num(node.budgetValue)} currency={currency} />
                    </span>
                  </div>
                </div>

                <div>
                  <ProgressBar
                    value={num(node.percentComplete)}
                    uncertain={node.ruleOfCredit === 'manual'}
                  />
                  <div className="mt-1 text-xs text-(--color-muted)">
                    {node.lastMeasuredOn ? `last ${date(node.lastMeasuredOn)}` : 'never measured'}
                  </div>
                </div>

                <div>
                  <NodeInput node={node} mayOverride={mayOverride} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </ActionForm>
    </>
  );
}

/** The input a node's rule of credit actually accepts, and nothing else. */
function NodeInput({ node, mayOverride }: { node: WbsNode; mayOverride: boolean }) {
  const input =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';
  const check = 'flex items-center gap-2 text-sm';

  switch (node.ruleOfCredit) {
    case 'units':
      return (
        <label className="block">
          <span className="mb-1 block text-xs text-(--color-muted)">
            Units complete{node.unitsPlanned ? ` of ${Number(node.unitsPlanned)}` : ''}
            {node.uomCode ? ` ${node.uomCode}` : ''}
          </span>
          <input
            name={`${node.id}.units`}
            type="number"
            step="any"
            min={0}
            max={node.unitsPlanned ? Number(node.unitsPlanned) : undefined}
            className={input}
          />
        </label>
      );

    case 'binary':
      return (
        <label className={check}>
          <input name={`${node.id}.finished`} type="checkbox" />
          Finished
        </label>
      );

    case 'started_finished':
      return (
        <div className="space-y-1.5">
          <label className={check}>
            <input name={`${node.id}.started`} type="checkbox" />
            Started
          </label>
          <label className={check}>
            <input name={`${node.id}.finished`} type="checkbox" />
            Finished
          </label>
        </div>
      );

    case 'milestone':
      return (
        <div className="space-y-1.5">
          {node.creditMilestones.map((milestone) => (
            <label key={milestone.key} className={check}>
              <input name={`${node.id}.ms.${milestone.key}`} type="checkbox" />
              {milestone.label ?? milestone.key}
              <span className="text-xs text-(--color-muted)">{milestone.weightPercent}%</span>
            </label>
          ))}
        </div>
      );

    case 'manual':
      // A typed percentage is a different act from a measurement, so the API
      // demands its own dangerous permission for it. Offering the field to
      // somebody who lacks that permission would fail the whole period.
      if (!mayOverride) {
        return (
          <p className="text-xs text-(--color-muted)">
            Self-assessed. Needs the progress override permission.
          </p>
        );
      }
      return (
        <label className="block">
          <span className="mb-1 block text-xs text-(--color-muted)">
            Percent complete — capped below 100, only finishing reaches it
          </span>
          <input
            name={`${node.id}.manual`}
            type="number"
            step="any"
            min={0}
            max={95}
            className={input}
          />
        </label>
      );
  }
}
