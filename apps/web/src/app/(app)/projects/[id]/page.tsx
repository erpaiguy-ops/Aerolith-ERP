import { notFound } from 'next/navigation';

import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, ProgressBar, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, apiFetchOptional, pageFetch } from '@/lib/api';
import { date, money, percent, toneForIndex, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

import { saveCustomFieldsAction } from './actions';

interface CustomFieldOption {
  value: string;
  label: string;
}

interface CustomFieldDefinition {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  isRequired: boolean;
  options: CustomFieldOption[];
}

interface ProjectDetail {
  project: {
    id: string;
    code: string;
    name: string;
    status: string;
    currencyCode: string | null;
    contractValue: string | null;
    startDate: string | null;
    endDate: string | null;
    customFields: Record<string, unknown>;
  };
  clientName: string | null;
  projectManagerName: string | null;
  quantitySurveyorName: string | null;
  healthStatus: string | null;
  practicalCompletionDate: string | null;
  defectsLiabilityEndsOn: string | null;
}

const HEALTH_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  green: 'good',
  amber: 'neutral',
  red: 'bad',
};

const fieldClass =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1.5 text-sm outline-none focus:border-(--color-accent)';

/** One editable cell for a custom field, shaped by its declared type. */
function CustomFieldInput({ def, value }: { def: CustomFieldDefinition; value: unknown }) {
  if (def.type === 'boolean') {
    return (
      <select name={def.key} defaultValue={value === true ? 'true' : 'false'} className={fieldClass}>
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>
    );
  }
  if (def.type === 'select') {
    return (
      <select name={def.key} defaultValue={typeof value === 'string' ? value : ''} className={fieldClass}>
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'textarea') {
    return (
      <textarea
        name={def.key}
        dir="auto"
        defaultValue={typeof value === 'string' ? value : ''}
        className={fieldClass}
        rows={2}
      />
    );
  }
  if (def.type === 'number' || def.type === 'decimal') {
    return (
      <input
        type="number"
        name={def.key}
        defaultValue={typeof value === 'number' || typeof value === 'string' ? value : ''}
        className={`${fieldClass} numeric`}
      />
    );
  }
  if (def.type === 'date' || def.type === 'datetime') {
    return (
      <input
        type={def.type === 'date' ? 'date' : 'datetime-local'}
        name={def.key}
        defaultValue={typeof value === 'string' ? value : ''}
        className={fieldClass}
      />
    );
  }
  if (def.type === 'multiselect') {
    return (
      <input
        name={def.key}
        dir="auto"
        placeholder="Comma-separated"
        defaultValue={Array.isArray(value) ? value.join(', ') : ''}
        className={fieldClass}
      />
    );
  }
  // 'text', 'url', and the relational types (user/party/item/project/document)
  // — no picker built yet for those, so a plain id goes in a text box.
  return (
    <input
      name={def.key}
      dir="auto"
      defaultValue={typeof value === 'string' ? value : ''}
      className={fieldClass}
    />
  );
}

interface WbsNode {
  id: string;
  code: string;
  name: string;
  path: string;
  depth: number;
  ruleOfCredit: string;
  budgetValue: string;
  budgetCost: string;
  percentComplete: string;
  rolledUpBudgetValue: number;
  rolledUpPercentComplete: number;
  containsManualClaims: boolean;
}

interface Position {
  summary: {
    budgetAtCompletion: number;
    actualCost: number;
    accruedCost: number;
    openCommitments: number;
    earnedValue: number;
    earnedCost: number;
    percentComplete: number;
    byCategory: { category: string; budget: number; actual: number; variance: number }[];
  };
  metrics: {
    costPerformanceIndex: number | null;
    schedulePerformanceIndex: number | null;
    costVariance: number;
    percentComplete: number;
    percentSpent: number;
  };
  forecast: {
    estimateAtCompletion: number;
    estimateToComplete: number;
    varianceAtCompletion: number;
    commitmentBound: boolean;
    toCompletePerformanceIndex: number | null;
  };
  forecastMargin?: number;
  forecastMarginPercent?: number;
  marginErosion?: number;
  marginHidden?: boolean;
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const currency = me.tenant.currencyCode;

  let detail: ProjectDetail;
  try {
    detail = await pageFetch<ProjectDetail>(`/projects/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const wbs = await pageFetch<{ nodes: WbsNode[] }>(`/projects/${id}/wbs`);

  // Optional: a user with `projects.project.read` but not `projects.cost.read`
  // sees the work breakdown and no money, rather than an error page.
  const position = await apiFetchOptional<Position>(`/projects/${id}/position`);

  // Open to anyone signed in — a field CATALOGUE is not the record itself.
  const customFieldDefs = await pageFetch<CustomFieldDefinition[]>(
    '/admin/custom-fields?entityType=project',
  );

  const roots = wbs.nodes.filter((n) => n.depth === 0);
  const overall = roots.reduce(
    (acc, n) => ({
      budget: acc.budget + n.rolledUpBudgetValue,
      earned: acc.earned + (n.rolledUpBudgetValue * n.rolledUpPercentComplete) / 100,
    }),
    { budget: 0, earned: 0 },
  );

  const { project } = detail;
  const mayEdit = can(me.permissions, 'projects.project.write') || me.user.isOwner;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={`${project.code} — ${project.name}`}
          subtitle={[
            detail.clientName,
            `${wbs.nodes.length} work breakdown nodes`,
            `${percent(overall.budget > 0 ? (overall.earned / overall.budget) * 100 : 0)} complete`,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        {/* Every figure on this page is downstream of a measurement, and until
            now there was no way to make one. */}
        {can(me.permissions, 'projects.progress.record') ? (
          <Link
            href={`/projects/${id}/progress`}
            className="rounded-md border border-(--color-line) px-3 py-1.5 text-sm hover:bg-(--color-canvas)"
          >
            Record progress
          </Link>
        ) : null}
      </div>

      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Status" value={<Badge tone="neutral">{project.status.replace(/_/g, ' ')}</Badge>} />
          {detail.healthStatus ? (
            <Stat
              label="Health"
              value={<Badge tone={HEALTH_TONE[detail.healthStatus] ?? 'neutral'}>{detail.healthStatus}</Badge>}
            />
          ) : null}
          <Stat label="Contract value" value={<Money amount={project.contractValue} currency={currency} />} />
          <Stat label="Dates" value={`${date(project.startDate)} – ${date(project.endDate)}`} />
          {detail.projectManagerName ? (
            <Stat label="Project manager" value={detail.projectManagerName} />
          ) : null}
          {detail.quantitySurveyorName ? (
            <Stat label="Quantity surveyor" value={detail.quantitySurveyorName} />
          ) : null}
          {detail.practicalCompletionDate ? (
            <Stat label="Practical completion" value={date(detail.practicalCompletionDate)} />
          ) : null}
          {detail.defectsLiabilityEndsOn ? (
            <Stat label="DLP ends" value={date(detail.defectsLiabilityEndsOn)} />
          ) : null}
        </div>
      </Card>

      {customFieldDefs.length > 0 ? (
        <Card title="Custom fields" className="mb-6">
          <ActionForm action={saveCustomFieldsAction} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              {customFieldDefs.map((def) => (
                <label key={def.key} className="block">
                  <span className="mb-1 block text-xs text-(--color-muted)">
                    {def.label}
                    {def.isRequired ? ' *' : ''}
                  </span>
                  {mayEdit ? (
                    <CustomFieldInput def={def} value={project.customFields[def.key]} />
                  ) : (
                    <p className="text-sm">
                      {project.customFields[def.key] == null || project.customFields[def.key] === ''
                        ? '—'
                        : String(project.customFields[def.key])}
                    </p>
                  )}
                  {def.helpText ? (
                    <span className="mt-1 block text-xs text-(--color-muted)">{def.helpText}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {mayEdit ? <SubmitButton pendingLabel="Saving…">Save</SubmitButton> : null}
          </ActionForm>
        </Card>
      ) : null}

      {position ? (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <Card title="Cost performance">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat
                label="Budget at completion"
                value={money(position.summary.budgetAtCompletion, currency)}
              />
              <Stat
                label="Actual cost"
                value={money(position.summary.actualCost, currency)}
                hint={
                  position.summary.accruedCost > 0
                    ? `incl. ${money(position.summary.accruedCost, currency)} accrued`
                    : undefined
                }
              />
              <Stat
                label="Earned (cost basis)"
                value={money(position.summary.earnedCost, currency)}
                hint="BCWP — not the revenue figure"
              />
              <Stat
                label="CPI"
                value={
                  position.metrics.costPerformanceIndex == null
                    ? 'not yet'
                    : position.metrics.costPerformanceIndex.toFixed(2)
                }
                tone={toneForIndex(position.metrics.costPerformanceIndex)}
                hint="earned cost ÷ actual cost"
              />
              <Stat label="Complete" value={percent(position.metrics.percentComplete)} />
              <Stat label="Spent" value={percent(position.metrics.percentSpent)} />
            </div>
          </Card>

          <Card
            title="Forecast"
            footnote={
              position.forecast.commitmentBound
                ? 'Remaining cost is set by open commitments, not by productivity — money already promised.'
                : undefined
            }
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat
                label="Forecast final cost"
                value={money(position.forecast.estimateAtCompletion, currency)}
              />
              <Stat
                label="Variance at completion"
                value={money(position.forecast.varianceAtCompletion, currency)}
                tone={toneForVariance(position.forecast.varianceAtCompletion)}
                hint={position.forecast.varianceAtCompletion >= 0 ? 'under budget' : 'overrun'}
              />
              <Stat
                label="Open commitments"
                value={money(position.summary.openCommitments, currency)}
              />

              {position.marginHidden ? (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-xs text-(--color-muted)">
                    Forecast margin is hidden — it needs <code>projects.margin.view</code>. The cost
                    position above is complete.
                  </p>
                </div>
              ) : (
                <>
                  <Stat
                    label="Forecast margin"
                    value={money(position.forecastMargin, currency)}
                    tone={toneForVariance(position.forecastMargin)}
                  />
                  <Stat
                    label="Margin %"
                    value={percent(position.forecastMarginPercent)}
                    tone={toneForVariance(position.forecastMarginPercent)}
                  />
                  <Stat
                    label="Erosion vs budget"
                    value={money(position.marginErosion, currency)}
                    tone={toneForVariance(position.marginErosion)}
                  />
                </>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      <Card title="Work breakdown">
        {wbs.nodes.length === 0 ? (
          <Empty title="No work breakdown yet" detail="Create one to start measuring progress." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Description</Th>
                <Th>Rule of credit</Th>
                <Th numeric>Budget</Th>
                <Th>Progress</Th>
              </tr>
            }
          >
            {wbs.nodes.map((node) => (
              <tr key={node.id}>
                <Td>
                  <span className="numeric text-(--color-muted)">{node.code}</span>
                </Td>
                <Td>
                  <span style={{ paddingInlineStart: `${node.depth * 0.75}rem` }}>{node.name}</span>
                </Td>
                <Td>
                  <span className="text-xs text-(--color-muted)">
                    {node.ruleOfCredit.replace(/_/g, ' ')}
                  </span>
                </Td>
                <Td numeric>
                  <Money amount={node.rolledUpBudgetValue} currency={currency} />
                </Td>
                <Td>
                  {/* Hatched when anything beneath it was self-assessed rather
                      than counted. A solid bar for a typed percentage is the UI
                      telling the same lie the rules of credit exist to stop. */}
                  <ProgressBar
                    value={node.rolledUpPercentComplete}
                    uncertain={node.containsManualClaims}
                  />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
