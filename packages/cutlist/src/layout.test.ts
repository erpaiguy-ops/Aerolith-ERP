import { describe, expect, it } from 'vitest';

import { renderBoardSvg, renderPlanSvgs, toCuttingList } from './layout';
import { optimise } from './optimise';
import type { Part, StockItem } from './types';

const MDF = 'mat-mdf';
const sheet: StockItem = {
  id: 'sheet-1',
  source: 'sheet',
  materialId: MDF,
  lengthMm: 2440,
  widthMm: 1220,
  thicknessMm: 18,
};

const parts: Part[] = [
  { id: 'door', label: 'Door front', materialId: MDF, lengthMm: 800, widthMm: 400, quantity: 4 },
];

const plan = optimise(parts, [sheet]);

describe('renderBoardSvg', () => {
  it('produces a well-formed SVG document', () => {
    const svg = renderBoardSvg(plan.boards[0]!);

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Every tag opened must be closed — a malformed drawing silently renders blank.
    expect(countOccurrences(svg, '<rect')).toBe(countOccurrences(svg, '/>'));
  });

  it('draws one rectangle per placed part, plus the board', () => {
    const board = plan.boards[0]!;
    const svg = renderBoardSvg(board);

    expect(countOccurrences(svg, '<rect')).toBe(board.placements.length + 1);
  });

  it('flips the y axis so the drawing matches the board, not the screen', () => {
    // A part at the board's origin must appear near the BOTTOM of the drawing.
    const board = {
      ...plan.boards[0]!,
      placements: [
        { partId: 'p', xMm: 0, yMm: 0, lengthMm: 1000, widthMm: 500, rotated: false },
      ],
    };
    const svg = renderBoardSvg(board, { widthPx: 1000 });

    // First rect is the board, second is the part.
    const ys = [...svg.matchAll(/<rect [^>]*\by="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThanOrEqual(2);

    const boardTop = ys[0]!;
    const partTop = ys[1]!;
    const boardHeightPx = Number(
      /<rect [^>]*height="([\d.]+)"[^>]*fill="#f4f4f5"/.exec(svg)?.[1] ??
        /<rect [^>]*\bheight="([\d.]+)"/.exec(svg)?.[1],
    );

    // A part at yMm = 0 sits at the BOTTOM of the board, so its top edge is
    // well below the board's top edge in screen coordinates.
    expect(partTop).toBeGreaterThan(boardTop);
    expect(partTop).toBeGreaterThan(boardTop + boardHeightPx / 2);
  });

  it('reports the board size, source and yield', () => {
    const svg = renderBoardSvg(plan.boards[0]!);

    expect(svg).toContain('2440 × 1220 mm');
    expect(svg).toContain('sheet');
    expect(svg).toContain('yield');
  });

  it('lists reusable offcuts so the operator knows what to keep', () => {
    const svg = renderBoardSvg(plan.boards[0]!);
    expect(svg).toMatch(/reusable offcut/);
  });

  it('can be told not to mention offcuts', () => {
    const svg = renderBoardSvg(plan.boards[0]!, { showRemnants: false });
    expect(svg).not.toMatch(/reusable offcut/);
  });

  it('escapes labels so a stray character cannot break the drawing', () => {
    const board = {
      ...plan.boards[0]!,
      placements: [
        {
          partId: 'p',
          label: 'Panel <A> & "B"',
          xMm: 0,
          yMm: 0,
          lengthMm: 2000,
          widthMm: 1000,
          rotated: false,
        },
      ],
    };

    const svg = renderBoardSvg(board);
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<A>');
  });

  it('omits a label that cannot fit in its rectangle', () => {
    // Text spilling outside its part makes the drawing unreadable.
    const board = {
      ...plan.boards[0]!,
      placements: [
        { partId: 'tiny', label: 'Tiny', xMm: 0, yMm: 0, lengthMm: 40, widthMm: 20, rotated: false },
      ],
    };

    const svg = renderBoardSvg(board, { widthPx: 900 });
    expect(svg).not.toContain('>Tiny<');
  });

  it('marks a rotated part so the operator turns it', () => {
    const board = {
      ...plan.boards[0]!,
      placements: [
        { partId: 'r', label: 'Rot', xMm: 0, yMm: 0, lengthMm: 1500, widthMm: 800, rotated: true },
      ],
    };

    expect(renderBoardSvg(board)).toContain('↻');
  });

  it('scales height to the board aspect ratio', () => {
    const svg = renderBoardSvg(plan.boards[0]!, { widthPx: 1000 });
    const height = Number(/height="([\d.]+)"/.exec(svg)?.[1]);

    // 2440x1220 is 2:1, so the drawing is roughly half as tall as wide, plus
    // margins and the footer.
    expect(height).toBeGreaterThan(400);
    expect(height).toBeLessThan(700);
  });
});

describe('renderPlanSvgs', () => {
  it('renders one drawing per board, each numbered', () => {
    const multi = optimise([{ ...parts[0]!, quantity: 30 }], [sheet]);
    const svgs = renderPlanSvgs(multi);

    expect(svgs).toHaveLength(multi.boards.length);
    expect(svgs[0]).toContain('Board 1 of');
  });

  it('prefixes a supplied title', () => {
    const svgs = renderPlanSvgs(plan, { title: 'WO-2026-0001' });
    expect(svgs[0]).toContain('WO-2026-0001 — board 1');
  });
});

describe('toCuttingList', () => {
  it('returns one row per placement with its board and position', () => {
    const rows = toCuttingList(plan);

    expect(rows).toHaveLength(plan.summary.partsPlaced);
    expect(rows[0]).toMatchObject({ board: 1, partId: 'door', label: 'Door front' });
    expect(typeof rows[0]!.xMm).toBe('number');
  });

  it('numbers boards from one, in plan order', () => {
    const multi = optimise([{ ...parts[0]!, quantity: 30 }], [sheet]);
    const rows = toCuttingList(multi);

    expect(Math.min(...rows.map((r) => r.board))).toBe(1);
    expect(Math.max(...rows.map((r) => r.board))).toBe(multi.boards.length);
  });

  it('falls back to the part id when a part has no label', () => {
    const unlabelled = optimise(
      [{ id: 'no-label', materialId: MDF, lengthMm: 500, widthMm: 300, quantity: 1 }],
      [sheet],
    );

    expect(toCuttingList(unlabelled)[0]!.label).toBe('no-label');
  });

  it('is empty for a plan with no boards', () => {
    expect(toCuttingList(optimise([], [sheet]))).toEqual([]);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
