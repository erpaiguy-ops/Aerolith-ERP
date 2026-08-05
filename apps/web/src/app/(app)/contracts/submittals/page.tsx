import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
import {
  EmptyList,
  FilterChips,
  Pager,
  SearchBox,
  SortTh,
  fetchList,
  listQuery,
} from '@/components/List';
import { Badge, Card, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date, integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createSubmittalAction } from './actions';

interface SubmittalRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  number: string | null;
  title: string;
  submittalType: string;
  status: string;
  ballInCourt: string;
  currentRevision: number;
  dueOn: string | null;
  daysToDue: number | null;
  isOverdue: boolean;
}

interface ContractOption {
  id: string;
  number: string | null;
  name: string;
}

const BASE = '/contracts/submittals';

const TYPES = [
  { label: 'All', value: null },
  { label: 'Shop drawing', value: 'shop_drawing' },
  { label: 'Material sample', value: 'material_sample' },
  { label: 'Method statement', value: 'method_statement' },
  { label: 'Product data', value: 'product_data' },
  { label: 'Mock-up', value: 'mock_up' },
];

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  draft: 'neutral',
  under_review: 'neutral',
  approved: 'good',
  approved_as_noted: 'good',
  revise_resubmit: 'bad',
  rejected: 'bad',
};

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * The fit-out approval clock: every shop drawing, sample and method
 * statement, across every contract, and whose desk it is sitting on right
 * now. Cross-contract for the same reason the notice register is — "what is
 * waiting on the consultant" is a question about the business, not one job.
 */
export default async function SubmittalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'contracts.submittal.manage') || me.user.isOwner;

  const result = await fetchList<SubmittalRow>('/contracts/submittals', query);
  const overdue = result.rows.filter((row) => row.isOverdue).length;

  // Only fetched for the raise form below — reading the register never needs
  // the contract catalogue.
  const contracts = mayManage
    ? (await pageFetch<{ rows: ContractOption[] }>('/contracts?pageSize=200&sort=number&direction=asc'))
        .rows
    : [];

  return (
    <>
      <PageHeader
        title="Submittal register"
        subtitle="Shop drawings, samples and method statements, and whose desk each one is on."
      />

      {overdue > 0 ? (
        <p className="mb-3 rounded-md border border-(--color-bad)/40 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)">
          {`${integer(overdue)} submittal${overdue === 1 ? '' : 's'} on this page ${overdue === 1 ? 'is' : 'are'} with the consultant past the due date, with no decision recorded.`}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="submittalType" options={TYPES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Still going through the cycle', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Number, title or contract…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['submittal', 'submittals']}
            hint="A shop drawing or sample is raised against a contract, then submitted for review."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <Th>Title</Th>
                <SortTh base={BASE} query={query} column="submittalType" current={result.sort} direction={result.direction}>
                  Type
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <Th>Ball in court</Th>
                <SortTh base={BASE} query={query} column="dueOn" current={result.sort} direction={result.direction}>
                  Due
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const days = row.daysToDue;
              const soon = row.ballInCourt === 'consultant' && days != null && days >= 0 && days <= 7;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <Link
                      href={`/contracts/submittals/${row.id}`}
                      className="numeric text-(--color-accent) hover:underline"
                    >
                      {row.number ?? '—'}
                    </Link>
                    <Link
                      href={`/contracts/${row.contractId}`}
                      className="numeric block text-xs text-(--color-accent) hover:underline"
                    >
                      {row.contractNumber ?? row.contractName}
                    </Link>
                  </Td>
                  <Td>
                    <span className="block">{row.title}</span>
                    {row.currentRevision > 0 ? (
                      <span className="text-xs text-(--color-muted)">
                        {`revision ${row.currentRevision}`}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone="neutral">{row.submittalType.replace(/_/g, ' ')}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td>{row.ballInCourt === 'consultant' ? 'Consultant' : 'Contractor'}</Td>
                  <Td>
                    {row.dueOn == null ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <>
                        <span
                          className={
                            row.isOverdue ? 'text-(--color-bad)' : soon ? 'text-(--color-warn)' : ''
                          }
                        >
                          {date(row.dueOn)}
                        </span>
                        {row.ballInCourt === 'consultant' && days != null ? (
                          <span
                            className={`block text-xs ${row.isOverdue ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                          >
                            {days < 0
                              ? `${integer(Math.abs(days))} days overdue`
                              : `${integer(days)} days left`}
                          </span>
                        ) : null}
                      </>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['submittal', 'submittals']} />

        {mayManage ? (
          <ActionForm
            action={createSubmittalAction}
            className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-4"
          >
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Contract</span>
              <select name="contractId" defaultValue="" className={field}>
                <option value="" disabled>
                  Choose a contract…
                </option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number ?? c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Type</span>
              <select name="submittalType" defaultValue="shop_drawing" className={field}>
                {TYPES.slice(1).map((t) => (
                  <option key={t.value} value={t.value ?? undefined}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Title</span>
              <input name="title" dir="auto" placeholder="Reception desk — shop drawing" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Spec section (optional)</span>
              <input name="specSection" placeholder="06 41 00" className={field} />
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Raising…">Raise submittal</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}
