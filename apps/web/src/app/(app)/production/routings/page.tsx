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
import { integer } from '@/lib/format';

interface RoutingRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  operationCount: number;
  plannedMinutes: number | null;
  workCentres: string | null;
  workOrdersUsing: number;
}

const BASE = '/production/routings';

export default async function RoutingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<RoutingRow>('/production/routings', query);

  return (
    <>
      <PageHeader
        title="Routings"
        subtitle="The path a job takes through the factory, and what it is planned to take."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="inactive"
          options={[{ label: 'Include retired', value: 'true' }]}
        />
        <SearchBox base={BASE} query={query} placeholder="Code or name…" />
      </div>

      <Card
        footnote="Editing a routing does not change work orders already on the floor: the rates and times are snapshotted onto the order when it is created, for the same reason an estimate pins its rate library."
      >
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['routing', 'routings']}
            hint="A routing is a sequence of operations, each at a work centre."
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
                <Th>Path</Th>
                <SortTh base={BASE} query={query} column="operationCount" current={result.sort} direction={result.direction} numeric>
                  Operations
                </SortTh>
                <Th numeric>Planned</Th>
                <Th numeric>In use</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric">{row.code}</span>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  {row.description ? (
                    <span className="text-xs text-(--color-muted)">{row.description}</span>
                  ) : null}
                </Td>
                <Td>
                  {/* The stations in sequence. A routing is easier to recognise
                      by its path than by its name — "SAW → EB → CNC → SPRAY" is
                      what a foreman actually pictures. */}
                  <span className="numeric text-xs">{row.workCentres ?? '—'}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(row.operationCount)}</span>
                </Td>
                <Td numeric>
                  {row.plannedMinutes == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <>
                      <span className="numeric">{`${integer(row.plannedMinutes)} min`}</span>
                      <span className="block text-xs text-(--color-muted)">
                        {/* Setup plus run per unit. Not a job duration — the run
                            time scales with quantity and the setup does not. */}
                        setup + run per unit
                      </span>
                    </>
                  )}
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(row.workOrdersUsing)}</span>
                  <span className="mt-0.5 block">
                    {row.isDefault ? <Badge tone="good">default</Badge> : null}
                    {!row.isActive ? <Badge tone="bad">retired</Badge> : null}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['routing', 'routings']} />
      </Card>
    </>
  );
}
