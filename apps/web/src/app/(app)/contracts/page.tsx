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
import { Badge, Card, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

import { activateContractAction, createContractAction } from './actions';

interface PartyOption {
  id: string;
  code: string;
  name: string;
}

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

interface ContractRow {
  id: string;
  number: string | null;
  name: string;
  side: string;
  status: string;
  currencyCode: string | null;
  originalSum: number;
  currentSum: number;
  variationValue: number;
  projectCode: string | null;
  counterpartyName: string | null;
  contractCompletionDate: string | null;
  externalReference: string | null;
}

const BASE = '/contracts';

const SIDES = [
  { label: 'All', value: null },
  // Receivable is money in, payable is money out. Both live in one register
  // because the arithmetic is identical in each direction — only the sign of the
  // cash flow differs — but they are almost never looked at together.
  { label: 'Receivable', value: 'receivable' },
  { label: 'Payable', value: 'payable' },
];

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayWrite = can(me.permissions, 'contracts.contract.write') || me.user.isOwner;
  const mayActivate = can(me.permissions, 'contracts.contract.execute') || me.user.isOwner;

  const result = await fetchList<ContractRow>('/contracts', query);

  // Only fetched for the create form below — reading the register never
  // needs the party and project catalogues.
  const [parties, projects] = mayWrite
    ? await Promise.all([
        pageFetch<{ rows: PartyOption[] }>('/master-data/parties?pageSize=200&sort=name&direction=asc'),
        pageFetch<{ rows: ProjectOption[] }>('/projects?pageSize=200&sort=code&direction=asc'),
      ])
    : [null, null];

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader title="Contracts" subtitle="Variations, payment applications and retention." />

      {mayWrite ? (
        <Card className="mb-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Create a contract</summary>
            <ActionForm action={createContractAction} className="mt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="lg:col-span-2">
                  <label htmlFor="name" className="mb-1 block text-xs text-(--color-muted)">
                    Name
                  </label>
                  <input id="name" name="name" dir="auto" className={field} />
                </div>
                <div>
                  <label htmlFor="side" className="mb-1 block text-xs text-(--color-muted)">
                    Side
                  </label>
                  <select id="side" name="side" defaultValue="receivable" className={field}>
                    <option value="receivable">Receivable (client)</option>
                    <option value="payable">Payable (subcontract)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="countryCode" className="mb-1 block text-xs text-(--color-muted)">
                    Country (terms)
                  </label>
                  <input
                    id="countryCode"
                    name="countryCode"
                    defaultValue={me.tenant.countryCode ?? ''}
                    maxLength={2}
                    placeholder="AE"
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="counterpartyId" className="mb-1 block text-xs text-(--color-muted)">
                    Counterparty
                  </label>
                  <select id="counterpartyId" name="counterpartyId" defaultValue="" className={field}>
                    <option value="">—</option>
                    {(parties?.rows ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${p.code} — ${p.name}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="projectId" className="mb-1 block text-xs text-(--color-muted)">
                    Project (optional)
                  </label>
                  <select id="projectId" name="projectId" defaultValue="" className={field}>
                    <option value="">—</option>
                    {(projects?.rows ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${p.code} — ${p.name}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="originalSum" className="mb-1 block text-xs text-(--color-muted)">
                    Original sum
                  </label>
                  <input
                    id="originalSum"
                    name="originalSum"
                    type="number"
                    step="0.01"
                    min={0}
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="externalReference" className="mb-1 block text-xs text-(--color-muted)">
                    Client reference (optional)
                  </label>
                  <input id="externalReference" name="externalReference" className={field} />
                </div>
                <div>
                  <label htmlFor="awardedOn" className="mb-1 block text-xs text-(--color-muted)">
                    Awarded on (optional)
                  </label>
                  <input id="awardedOn" name="awardedOn" type="date" className={field} />
                </div>
              </div>
              <p className="mt-2 text-xs text-(--color-muted)">
                Retention, payment terms and the defects liability period are not typed in — they
                come from the country&apos;s own rules, the same way an activated contract already
                shows them.
              </p>
              <div className="mt-3">
                <SubmitButton pendingLabel="Creating…">Create contract</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Card>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="side" options={SIDES} />
        <SearchBox base={BASE} query={query} placeholder="Number, name or client ref…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['contract', 'contracts']}
            hint="A contract is created when a tender is won, or entered directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="name" current={result.sort} direction={result.direction}>
                  Contract
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="currentSum" current={result.sort} direction={result.direction} numeric>
                  Current sum
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Variations
                </SortTh>
                <SortTh base={BASE} query={query} column="contractCompletionDate" current={result.sort} direction={result.direction}>
                  Completion
                </SortTh>
                {mayActivate ? <Th /> : null}
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link href={`/contracts/${row.id}`} className="numeric text-(--color-accent) hover:underline">
                    {row.number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  {/* Client and job beneath the name rather than in their own
                      columns: on a contract register these identify the row, and
                      three separate columns of names is unreadable at a glance. */}
                  <span className="text-xs text-(--color-muted)">
                    {[row.counterpartyName, row.projectCode].filter(Boolean).join(' · ') || '—'}
                  </span>
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'active'
                        ? 'good'
                        : row.status === 'terminated'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.currentSum}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td numeric>
                  {/* Approved variations only — this is current less original, and
                      only an approved variation moves the current sum. Instructed
                      but unapproved work is exposure, and it lives on the detail
                      screen where there is room to explain the difference. */}
                  {row.variationValue === 0 ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <Money
                      amount={row.variationValue}
                      currency={row.currencyCode ?? me.tenant.currencyCode}
                      tone={toneForVariance(-row.variationValue)}
                    />
                  )}
                </Td>
                <Td>{date(row.contractCompletionDate)}</Td>
                {mayActivate ? (
                  <Td>
                    {row.status === 'draft' ? (
                      <ActionForm action={activateContractAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="contractId" value={row.id} />
                        <SubmitButton pendingLabel="…">Activate</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['contract', 'contracts']} />
      </Card>
    </>
  );
}
