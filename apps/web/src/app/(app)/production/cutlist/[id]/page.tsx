import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { ApiError, pageFetch } from '@/lib/api';
import { date, dimensions, integer, percent, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface Placement {
  partId: string;
  label?: string;
  xMm: number;
  yMm: number;
  lengthMm: number;
  widthMm: number;
  rotated: boolean;
}

interface Remnant {
  lengthMm: number;
  widthMm: number;
  areaSqm: number;
  usable: boolean;
}

interface BoardPlan {
  stockId: string;
  source: 'sheet' | 'offcut';
  materialId: string;
  lengthMm: number;
  widthMm: number;
  placements: Placement[];
  remnants: Remnant[];
  yieldPercent: number;
  usedAreaSqm: number;
  wasteAreaSqm: number;
  cost?: number;
}

interface PlanDetail {
  id: string;
  workOrderId: string;
  workOrderNumber: string | null;
  workOrderDescription: string;
  workOrderStatus: string;
  projectCode: string | null;
  projectName: string | null;
  version: number;
  sheetsUsed: number;
  offcutsUsed: number;
  grossYieldPercent: string | null;
  netYieldPercent: string | null;
  materialCost: string | null;
  isCommitted: boolean;
  committedAt: string | null;
  createdAt: string;
  generatedByName: string | null;
  options: Record<string, unknown>;
  materials: { id: string; code: string; name: string; thicknessMm: string | null }[];
  offcutsConsumed: {
    id: string;
    itemCode: string | null;
    lengthMm: string;
    widthMm: string;
    status: string;
  }[];
  plan: {
    boards?: BoardPlan[];
    unplaced?: { partId: string; label?: string; quantity: number; reason: string }[];
    edgeBanding?: { tapeId: string; metres: number }[];
    summary?: {
      boardsUsed: number;
      sheetsUsed: number;
      offcutsUsed: number;
      partsPlaced: number;
      partsRequested: number;
      totalYieldPercent: number;
      netYieldPercent: number;
      totalAreaSqm: number;
      usedAreaSqm: number;
      wasteAreaSqm: number;
      reusableOffcuts: number;
      reusableAreaSqm: number;
      materialCost?: number;
    };
  };
  cuttingList: {
    board: number;
    source: string;
    partId: string;
    label: string;
    lengthMm: number;
    widthMm: number;
    rotated: boolean;
  }[];
  drawings?: string[];
}

/**
 * A cutting plan, drawn.
 *
 * The register could already tell you a job used eleven boards at 82% yield. It
 * could not show you the boards, which is the only form in which a plan is
 * usable: nobody cuts to a percentage. This is the screen the whole cutlist
 * engine exists to produce.
 *
 * **The drawings arrive as SVG from the API and are rendered as images, not
 * injected as markup.** The renderer escapes every text node it writes, so
 * inlining would be safe today — but the text in those nodes is user-entered
 * part labels, and "safe because a function three packages away still escapes
 * correctly" is a property that quietly stops holding. An `<img>` with a data
 * URI cannot execute script whatever the bytes say, which is a guarantee rather
 * than an argument. Base64 via `Buffer` rather than `btoa`, because a part
 * labelled in Arabic is not Latin-1 and `btoa` throws on it.
 */
export default async function CuttingPlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();

  let detail: PlanDetail;
  try {
    detail = await pageFetch<PlanDetail>(`/production/cutting-plans/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const boards = detail.plan.boards ?? [];
  const summary = detail.plan.summary;
  const unplaced = detail.plan.unplaced ?? [];
  const material = (materialId: string) => detail.materials.find((m) => m.id === materialId);

  const dataUri = (svg: string) =>
    `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

  return (
    <>
      <PageHeader
        title={`Cutting plan v${detail.version}`}
        subtitle={[
          detail.workOrderNumber ?? 'unnumbered work order',
          detail.workOrderDescription,
          detail.projectCode ? `${detail.projectCode} · ${detail.projectName}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/production/cutlist" className="text-(--color-accent) hover:underline">
          ← All cutting plans
        </Link>
        {detail.isCommitted ? (
          <Badge tone="good">{`committed ${date(detail.committedAt)}`}</Badge>
        ) : (
          // A provisional plan has consumed nothing: the offcuts it names are
          // reserved, not cut, and re-planning releases them.
          <Badge tone="neutral">provisional</Badge>
        )}
        <span className="text-(--color-muted)">
          {`planned ${date(detail.createdAt)}${detail.generatedByName ? ` by ${detail.generatedByName}` : ''}`}
        </span>
      </div>

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Boards"
            value={integer(summary?.boardsUsed ?? boards.length)}
            hint={
              detail.offcutsUsed > 0
                ? `${integer(detail.sheetsUsed)} new · ${integer(detail.offcutsUsed)} off the rack`
                : 'new sheets only'
            }
          />
          <Stat
            label="Net yield"
            value={percent(detail.netYieldPercent)}
            // Net first, and it is the one on the big number. Gross treats a
            // large reusable remnant as waste, so opening a sheet to cut one
            // plinth reads as 84% waste and is nothing of the sort.
            hint={detail.grossYieldPercent ? `${percent(detail.grossYieldPercent)} gross` : undefined}
          />
          <Stat
            label="Material"
            value={<Money amount={detail.materialCost} currency={me.tenant.currencyCode} />}
          />
          <Stat
            label="Parts placed"
            value={
              summary
                ? `${integer(summary.partsPlaced)} of ${integer(summary.partsRequested)}`
                : integer(detail.cuttingList.length)
            }
            tone={unplaced.length > 0 ? 'bad' : 'neutral'}
          />
          <Stat
            label="Back on the rack"
            value={integer(summary?.reusableOffcuts ?? 0)}
            hint={
              summary ? `${quantity(summary.reusableAreaSqm)} m² recoverable` : undefined
            }
            tone="good"
          />
          <Stat
            label="Waste"
            value={summary ? `${quantity(summary.wasteAreaSqm)} m²` : '—'}
            hint={summary ? `of ${quantity(summary.totalAreaSqm)} m² opened` : undefined}
          />
        </div>
      </Card>

      {unplaced.length > 0 ? (
        // Loudly. A plan that quietly dropped four parts sends someone to the
        // saw with a job that cannot be finished from it.
        <Card className="mb-4">
          <p className="mb-2 text-sm font-medium text-(--color-bad)">
            {`${integer(unplaced.length)} part${unplaced.length === 1 ? '' : 's'} could not be placed`}
          </p>
          <ul className="space-y-1 text-sm text-(--color-muted)">
            {unplaced.map((part) => (
              <li key={part.partId}>
                {`${part.label ?? part.partId} × ${integer(part.quantity)} — ${part.reason}`}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {boards.length === 0 ? (
        <Empty
          title="This plan has no boards"
          detail="The stored plan carries no layout, so there is nothing to draw. Re-plan the work order to produce one."
        />
      ) : (
        <div className="space-y-4">
          {boards.map((board, index) => {
            const item = material(board.materialId);
            const reusable = board.remnants.filter((r) => r.usable);
            return (
              <Card key={`${board.stockId}-${index}`}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <span className="font-medium">{`Board ${index + 1}`}</span>
                    <span className="ms-2 text-sm text-(--color-muted)">
                      {item ? `${item.code} — ${item.name}` : 'unknown material'}
                    </span>
                    <span className="ms-2">
                      {/* Where the board came from is the fact the offcut
                          register exists to make visible. */}
                      <Badge tone={board.source === 'offcut' ? 'good' : 'neutral'}>
                        {board.source === 'offcut' ? 'off the rack' : 'new sheet'}
                      </Badge>
                    </span>
                  </div>
                  <div className="numeric text-sm text-(--color-muted)">
                    {`${dimensions(board.lengthMm, board.widthMm)} · yield ${percent(board.yieldPercent)}`}
                  </div>
                </div>

                {detail.drawings?.[index] ? (
                  <img
                    src={dataUri(detail.drawings[index]!)}
                    alt={`Cutting layout for board ${index + 1}: ${integer(board.placements.length)} parts`}
                    className="w-full max-w-full"
                  />
                ) : null}

                <Table
                  head={
                    <tr>
                      <Th>Part</Th>
                      <Th numeric>Cut size</Th>
                      <Th numeric>Position</Th>
                      <Th>Grain</Th>
                    </tr>
                  }
                >
                  {board.placements.map((placement, row) => (
                    <tr key={`${placement.partId}-${row}`}>
                      <Td>{placement.label ?? placement.partId}</Td>
                      <Td numeric>{dimensions(placement.lengthMm, placement.widthMm)}</Td>
                      {/* The corner the saw measures from. Without it the
                          drawing is a picture and not an instruction.

                          Deliberately NOT `integer()`: it groups thousands, and
                          "1,193, 613" beside a comma separator reads as three
                          numbers. Millimetres are never written grouped. */}
                      <Td numeric>{`x ${Math.round(placement.xMm)} · y ${Math.round(placement.yMm)}`}</Td>
                      <Td>
                        {placement.rotated ? (
                          <Badge tone="neutral">turned 90°</Badge>
                        ) : (
                          <span className="text-(--color-muted)">along</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>

                {reusable.length > 0 ? (
                  <p className="mt-3 text-xs text-(--color-good)">
                    {`Returns to the rack: ${reusable
                      .map((r) => dimensions(r.lengthMm, r.widthMm))
                      .join(' · ')}`}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      {detail.offcutsConsumed.length > 0 ? (
        <Card title="Taken off the rack" className="mt-4">
          <Table
            head={
              <tr>
                <Th>Material</Th>
                <Th numeric>Size</Th>
                <Th>Status now</Th>
              </tr>
            }
          >
            {detail.offcutsConsumed.map((piece) => (
              <tr key={piece.id}>
                <Td>{piece.itemCode ?? '—'}</Td>
                <Td numeric>{dimensions(piece.lengthMm, piece.widthMm)}</Td>
                <Td>
                  {/* The CURRENT status, not the one at planning time. A plan
                      made last week whose remnant has since been cut by another
                      job is a plan that will not cut as drawn, and this is the
                      only place that says so. */}
                  <Badge tone={piece.status === 'consumed' ? 'bad' : 'neutral'}>
                    {piece.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {(detail.plan.edgeBanding ?? []).length > 0 ? (
        <Card title="Edge banding" className="mt-4" footnote="Metres per tape, across the whole plan.">
          <Table
            head={
              <tr>
                <Th>Tape</Th>
                <Th numeric>Metres</Th>
              </tr>
            }
          >
            {(detail.plan.edgeBanding ?? []).map((tape) => (
              <tr key={tape.tapeId}>
                <Td>{tape.tapeId}</Td>
                <Td numeric>{quantity(tape.metres)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}
