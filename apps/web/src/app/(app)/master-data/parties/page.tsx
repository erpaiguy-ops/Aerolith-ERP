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
import { getMe } from '@/lib/session';

import { createPartyAction } from './actions';

interface PartyRow {
  id: string;
  code: string;
  type: string;
  name: string;
  countryCode: string | null;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  isSubcontractor: boolean;
  isConsultant: boolean;
  isEmployee: boolean;
  isBlocked: boolean;
}

const BASE = '/master-data/parties';

const ROLES = [
  { label: 'All', value: null },
  { label: 'Customers', value: 'customer' },
  { label: 'Suppliers', value: 'supplier' },
  { label: 'Subcontractors', value: 'subcontractor' },
  { label: 'Consultants', value: 'consultant' },
];

const ROLE_LABEL: Record<string, string> = {
  isCustomer: 'customer',
  isSupplier: 'supplier',
  isSubcontractor: 'subcontractor',
  isConsultant: 'consultant',
  isEmployee: 'employee',
};

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * The register every module was already joining against and nothing could
 * create, list or edit directly — a client, a supplier, a subcontractor, all
 * one table with role flags, because the same company is routinely more than
 * one of those across different jobs.
 */
export default async function PartiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.master_data.manage') || me.user.isOwner;

  const result = await fetchList<PartyRow>('/master-data/parties', query);

  return (
    <>
      <PageHeader
        title="Parties"
        subtitle="Every client, supplier, subcontractor and consultant this workspace deals with."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="role" options={ROLES} />
        <SearchBox base={BASE} query={query} placeholder="Code or name…" />
      </div>

      <Card className="mb-6">
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['party', 'parties']}
            hint="Add the first one below."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="code" current={result.sort} direction={result.direction}>
                  Code
                </SortTh>
                <SortTh base={BASE} query={query} column="name" current={result.sort} direction={result.direction}>
                  Name
                </SortTh>
                <Th>Roles</Th>
                <Th>Contact</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/master-data/parties/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.code}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  {row.countryCode ? (
                    <span className="text-xs text-(--color-muted)">{row.countryCode}</span>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {(Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[])
                      .filter((key) => row[key as keyof PartyRow])
                      .map((key) => (
                        <Badge key={key} tone="neutral">
                          {ROLE_LABEL[key]}
                        </Badge>
                      ))}
                    {row.isBlocked ? <Badge tone="bad">blocked</Badge> : null}
                  </div>
                </Td>
                <Td>
                  <span className="block text-xs text-(--color-muted)">{row.email ?? '—'}</span>
                  <span className="block text-xs text-(--color-muted)">{row.phone ?? ''}</span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['party', 'parties']} />
      </Card>

      {mayManage ? (
        <Card title="Add a party">
          <ActionForm action={createPartyAction} className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="EMAAR" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="Emaar Properties PJSC" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Country</span>
              <input name="countryCode" placeholder="AE" maxLength={2} className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Email</span>
              <input name="email" type="email" className={field} />
            </label>
            <fieldset className="sm:col-span-3">
              <legend className="mb-1 block text-xs text-(--color-muted)">Roles</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                {Object.entries(ROLE_LABEL).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input type="checkbox" name={key} value="true" className="accent-current" />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <SubmitButton pendingLabel="Adding…">Add party</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
