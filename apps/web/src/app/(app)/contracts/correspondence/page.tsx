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

import { closeCorrespondenceAction, createCorrespondenceAction, respondCorrespondenceAction } from './actions';

interface CorrespondenceRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  type: string;
  reference: string;
  subject: string;
  direction: string;
  issuedOn: string;
  responseDueOn: string | null;
  respondedOn: string | null;
  status: string;
  isContractual: boolean;
  variationId: string | null;
  variationNumber: string | null;
  daysToResponse: number | null;
  isAtRisk: boolean;
}

interface ContractOption {
  id: string;
  number: string | null;
  name: string;
}

const BASE = '/contracts/correspondence';

const TYPES = [
  { label: 'All', value: null },
  { label: 'RFI', value: 'rfi' },
  { label: 'Notice', value: 'notice' },
  { label: 'EOT claim', value: 'eot_claim' },
  { label: 'NCR', value: 'ncr' },
  { label: 'Instruction', value: 'instruction' },
];

const RAISABLE_TYPES = TYPES.slice(1);

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

export default async function CorrespondencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'contracts.correspondence.manage') || me.user.isOwner;

  const result = await fetchList<CorrespondenceRow>('/contracts/correspondence', query);
  const atRisk = result.rows.filter((row) => row.isAtRisk).length;

  // Only fetched for the raise-an-item form below — reading the register
  // never needs the contract catalogue.
  const contracts = mayManage
    ? (await pageFetch<{ rows: ContractOption[] }>('/contracts?pageSize=200&sort=number&direction=asc'))
        .rows
    : [];

  return (
    <>
      <PageHeader
        title="Notice register"
        subtitle="Everything issued and everything still waiting on an answer, across every contract."
      />

      {atRisk > 0 ? (
        // Above the table, because it is the only thing on this page with a
        // deadline attached — the same reasoning as the time-bar warning on the
        // contract screen.
        <p className="mb-3 rounded-md border border-(--color-bad)/40 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)">
          {`${integer(atRisk)} contractual item${atRisk === 1 ? '' : 's'} on this page ${atRisk === 1 ? 'is' : 'are'} past the response deadline with no reply. Entitlement depends on these.`}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="type" options={TYPES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Awaiting a reply', value: 'true' }]}
          />
          {/* The distinction that matters. An unanswered RFI is an irritation;
              an unanswered notice on which an extension of time depends is a
              claim being lost while nobody watches. */}
          <FilterChips
            base={BASE}
            query={query}
            param="contractual"
            options={[{ label: 'Contractual only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Reference, subject or contract…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['item', 'items']}
            hint="Notices, RFIs and instructions are recorded against a contract as they are issued."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="reference" current={result.sort} direction={result.direction}>
                  Reference
                </SortTh>
                <SortTh base={BASE} query={query} column="type" current={result.sort} direction={result.direction}>
                  Type
                </SortTh>
                <Th>Subject</Th>
                <SortTh base={BASE} query={query} column="issuedOn" current={result.sort} direction={result.direction}>
                  Issued
                </SortTh>
                <SortTh base={BASE} query={query} column="responseDueOn" current={result.sort} direction={result.direction}>
                  Response due
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {result.rows.map((row) => {
              const waiting = row.respondedOn == null;
              const days = row.daysToResponse;
              const soon = waiting && days != null && days >= 0 && days <= 7;
              const isClosed = row.status === 'closed';

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric block">{row.reference}</span>
                    <Link
                      href={`/contracts/${row.contractId}`}
                      className="numeric text-xs text-(--color-accent) hover:underline"
                    >
                      {row.contractNumber ?? row.contractName}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={row.isAtRisk ? 'bad' : 'neutral'}>
                      {row.type.replace(/_/g, ' ')}
                    </Badge>
                    {row.isContractual ? (
                      <span className="block text-xs text-(--color-muted)">contractual</span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="block">{row.subject}</span>
                    <span className="text-xs text-(--color-muted)">
                      {row.direction}
                      {row.variationNumber ? ` · became ${row.variationNumber}` : ''}
                    </span>
                  </Td>
                  <Td>{date(row.issuedOn)}</Td>
                  <Td>
                    {row.responseDueOn == null ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <>
                        <span
                          className={
                            row.isAtRisk
                              ? 'text-(--color-bad)'
                              : soon
                                ? 'text-(--color-warn)'
                                : ''
                          }
                        >
                          {date(row.responseDueOn)}
                        </span>
                        {waiting && days != null ? (
                          <span
                            className={`block text-xs ${row.isAtRisk ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                          >
                            {days < 0
                              ? `${integer(Math.abs(days))} days overdue`
                              : `${integer(days)} days left`}
                          </span>
                        ) : null}
                      </>
                    )}
                  </Td>
                  <Td>
                    {row.respondedOn ? (
                      <>
                        <Badge tone="good">answered</Badge>
                        <span className="block text-xs text-(--color-muted)">
                          {date(row.respondedOn)}
                        </span>
                      </>
                    ) : (
                      <Badge tone={row.isAtRisk ? 'bad' : 'neutral'}>{row.status}</Badge>
                    )}
                  </Td>
                  {mayManage ? (
                    <Td>
                      {waiting && !isClosed ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ActionForm action={respondCorrespondenceAction} className="flex items-center gap-1">
                            <input type="hidden" name="correspondenceId" value={row.id} />
                            <input
                              type="date"
                              name="respondedOn"
                              defaultValue={new Date().toISOString().slice(0, 10)}
                              className="w-36 rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-xs outline-none focus:border-(--color-accent)"
                            />
                            <SubmitButton pendingLabel="…">Respond</SubmitButton>
                          </ActionForm>
                          <ActionForm action={closeCorrespondenceAction}>
                            <input type="hidden" name="correspondenceId" value={row.id} />
                            <SubmitButton pendingLabel="…">Close</SubmitButton>
                          </ActionForm>
                        </div>
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['item', 'items']} />

        {mayManage ? (
          <ActionForm
            action={createCorrespondenceAction}
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
              <select name="type" defaultValue="rfi" className={field}>
                {RAISABLE_TYPES.map((t) => (
                  <option key={t.value} value={t.value ?? undefined}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Reference</span>
              <input name="reference" placeholder="RFI-042" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Issued on</span>
              <input
                type="date"
                name="issuedOn"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className={field}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Subject</span>
              <input name="subject" dir="auto" placeholder="Confirm veneer grain direction" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Response due (optional)</span>
              <input type="date" name="responseDueOn" className={field} />
            </label>
            <label className="flex items-end gap-2 pb-1.5 text-sm">
              <input type="checkbox" name="isContractual" className="h-4 w-4" />
              Contractual — missing the deadline loses an entitlement
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Raising…">Raise item</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}
