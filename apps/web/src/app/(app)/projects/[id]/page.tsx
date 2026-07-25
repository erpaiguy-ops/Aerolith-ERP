import { notFound } from 'next/navigation';

import { Card, Empty, Money, PageHeader, ProgressBar, Stat, Table, Td, Th } from '@/components/ui';
import { apiFetch, apiFetchOptional, ApiError } from '@/lib/api';
import { money, percent, toneForIndex, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

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

  let wbs: { nodes: WbsNode[] };
  try {
    wbs = await apiFetch<{ nodes: WbsNode[] }>(`/projects/${id}/wbs`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  // Optional: a user with `projects.project.read` but not `projects.cost.read`
  // sees the work breakdown and no money, rather than an error page.
  const position = await apiFetchOptional<Position>(`/projects/${id}/position`);

  const roots = wbs.nodes.filter((n) => n.depth === 0);
  const overall = roots.reduce(
    (acc, n) => ({
      budget: acc.budget + n.rolledUpBudgetValue,
      earned: acc.earned + (n.rolledUpBudgetValue * n.rolledUpPercentComplete) / 100,
    }),
    { budget: 0, earned: 0 },
  );

  return (
    <>
      <PageHeader
        title="Project"
        subtitle={`${wbs.nodes.length} work breakdown nodes · ${percent(
          overall.budget > 0 ? (overall.earned / overall.budget) * 100 : 0,
        )} complete`}
      />

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
