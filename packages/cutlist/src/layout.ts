/**
 * Cutting layout drawings.
 *
 * Renders a board plan as SVG — the diagram that goes to the saw. Kept as
 * dependency-free string building so it works server-side for the PDF, and
 * client-side for the on-screen preview, without a rendering library.
 *
 * The drawing is deliberately plain: part outlines, labels, dimensions, and the
 * offcuts marked. A saw operator reads this at arm's length in a noisy factory,
 * so legibility beats decoration.
 */
import type { BoardPlan, CutlistPlan } from './types';

export interface LayoutOptions {
  /** Drawing width in pixels; height follows the board's aspect ratio. */
  widthPx?: number;
  /** Show each part's dimensions inside its rectangle. */
  showDimensions?: boolean;
  /** Shade the remnants that are worth returning to the register. */
  showRemnants?: boolean;
  title?: string;
}

const PALETTE = {
  board: '#f4f4f5',
  boardStroke: '#71717a',
  part: '#dbeafe',
  partStroke: '#1d4ed8',
  partText: '#1e3a8a',
  remnant: '#dcfce7',
  remnantStroke: '#16a34a',
  scrap: '#fee2e2',
  scrapStroke: '#dc2626',
  text: '#18181b',
  muted: '#52525b',
};

/** Renders one board as a standalone SVG document. */
export function renderBoardSvg(board: BoardPlan, options: LayoutOptions = {}): string {
  const widthPx = options.widthPx ?? 900;
  const showDimensions = options.showDimensions ?? true;
  const showRemnants = options.showRemnants ?? true;

  const margin = 48;
  const headerHeight = options.title ? 34 : 0;
  const scale = (widthPx - margin * 2) / board.lengthMm;
  const boardWidthPx = board.lengthMm * scale;
  const boardHeightPx = board.widthMm * scale;
  const totalHeight = boardHeightPx + margin * 2 + headerHeight + 26;

  // SVG's y axis points down; the board's points up. Flipping here keeps every
  // coordinate below in board space, which is what the plan carries.
  const toY = (yMm: number, heightMm: number) =>
    margin + headerHeight + (board.widthMm - yMm - heightMm) * scale;

  const parts: string[] = [];

  if (options.title) {
    parts.push(
      `<text x="${margin}" y="${margin - 12}" font-size="16" font-weight="600" ` +
        `fill="${PALETTE.text}">${escapeXml(options.title)}</text>`,
    );
  }

  parts.push(
    `<rect x="${margin}" y="${margin + headerHeight}" width="${round(boardWidthPx)}" ` +
      `height="${round(boardHeightPx)}" fill="${PALETTE.board}" ` +
      `stroke="${PALETTE.boardStroke}" stroke-width="1.5"/>`,
  );

  for (const placement of board.placements) {
    const x = margin + placement.xMm * scale;
    const y = toY(placement.yMm, placement.widthMm);
    const w = placement.lengthMm * scale;
    const h = placement.widthMm * scale;

    parts.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
        `fill="${PALETTE.part}" stroke="${PALETTE.partStroke}" stroke-width="1"/>`,
    );

    const label = placement.label ?? placement.partId;
    const centreX = round(x + w / 2);
    const centreY = round(y + h / 2);

    // Only label when the rectangle can actually hold the text.
    if (w > 60 && h > 24) {
      parts.push(
        `<text x="${centreX}" y="${centreY - (showDimensions ? 4 : -4)}" ` +
          `text-anchor="middle" font-size="11" font-weight="600" fill="${PALETTE.partText}">` +
          `${escapeXml(truncate(label, Math.floor(w / 7)))}</text>`,
      );

      if (showDimensions) {
        const dims = `${round(placement.lengthMm)}×${round(placement.widthMm)}${
          placement.rotated ? ' ↻' : ''
        }`;
        parts.push(
          `<text x="${centreX}" y="${centreY + 10}" text-anchor="middle" font-size="9" ` +
            `fill="${PALETTE.muted}">${escapeXml(dims)}</text>`,
        );
      }
    }
  }

  // Board dimensions and yield along the bottom.
  const footerY = margin + headerHeight + boardHeightPx + 18;
  parts.push(
    `<text x="${margin}" y="${round(footerY)}" font-size="11" fill="${PALETTE.muted}">` +
      `${round(board.lengthMm)} × ${round(board.widthMm)} mm · ${board.source} · ` +
      `yield ${board.yieldPercent}%</text>`,
  );

  // Remnants carry sizes, not coordinates — the optimiser reports what is left
  // over, not where on the board it sits — so they are listed rather than drawn.
  const reusable = showRemnants ? board.remnants.filter((r) => r.usable) : [];
  if (reusable.length > 0) {
    parts.push(
      `<text x="${round(margin + boardWidthPx)}" y="${round(footerY)}" text-anchor="end" ` +
        `font-size="11" fill="${PALETTE.remnantStroke}">` +
        `${reusable.length} reusable offcut${reusable.length === 1 ? '' : 's'}: ` +
        `${escapeXml(reusable.map((r) => `${round(r.lengthMm)}×${round(r.widthMm)}`).join(', '))}` +
        `</text>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${round(totalHeight)}" ` +
    `viewBox="0 0 ${widthPx} ${round(totalHeight)}" font-family="system-ui, sans-serif">` +
    parts.join('') +
    `</svg>`
  );
}

/** Every board in a plan, as separate SVG documents. */
export function renderPlanSvgs(plan: CutlistPlan, options: LayoutOptions = {}): string[] {
  return plan.boards.map((board, index) =>
    renderBoardSvg(board, {
      ...options,
      title: options.title
        ? `${options.title} — board ${index + 1} of ${plan.boards.length}`
        : `Board ${index + 1} of ${plan.boards.length}`,
    }),
  );
}

/**
 * The cutting list as rows — what gets printed alongside the drawing, and what
 * the part labels are generated from.
 */
export function toCuttingList(plan: CutlistPlan): {
  board: number;
  stockId: string;
  source: string;
  partId: string;
  label: string;
  lengthMm: number;
  widthMm: number;
  rotated: boolean;
  xMm: number;
  yMm: number;
}[] {
  return plan.boards.flatMap((board, boardIndex) =>
    board.placements.map((placement) => ({
      board: boardIndex + 1,
      stockId: board.stockId,
      source: board.source,
      partId: placement.partId,
      label: placement.label ?? placement.partId,
      lengthMm: placement.lengthMm,
      widthMm: placement.widthMm,
      rotated: placement.rotated,
      xMm: placement.xMm,
      yMm: placement.yMm,
    })),
  );
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 1) return '';
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
