import { describe, expect, it } from 'vitest';

import {
  DEFAULT_USABILITY,
  areaSqm,
  fits,
  guillotineRemnants,
  isUsableOffcut,
  offcutCost,
  selectBestOffcut,
  yieldPercent,
  type Panel,
} from './offcuts';

/** A standard 2440 x 1220 sheet. */
const sheet = (over: Partial<Panel> = {}): Panel => ({
  id: 'sheet',
  lengthMm: 2440,
  widthMm: 1220,
  thicknessMm: 18,
  ...over,
});

describe('fits — dimensions', () => {
  it('accepts a part that clearly fits', () => {
    const result = fits(sheet(), { lengthMm: 800, widthMm: 400 });
    expect(result.fits).toBe(true);
    expect(result.orientation).toBe('as_is');
  });

  it('rejects a part larger than the panel', () => {
    expect(fits(sheet(), { lengthMm: 3000, widthMm: 400 }).fits).toBe(false);
  });

  it('accounts for the saw kerf at the margin', () => {
    // Exactly panel-sized cannot be cut — the blade has to go somewhere.
    expect(fits(sheet(), { lengthMm: 2440, widthMm: 1220 }, { kerfMm: 3.2 }).fits).toBe(false);
    expect(fits(sheet(), { lengthMm: 2436, widthMm: 1216 }, { kerfMm: 3.2 }).fits).toBe(true);
  });

  it('accounts for edge trim', () => {
    // 10mm trimmed off every edge costs 20mm on each dimension.
    expect(fits(sheet(), { lengthMm: 2420, widthMm: 1200 }, { kerfMm: 0, edgeTrimMm: 10 }).fits).toBe(
      true,
    );
    expect(fits(sheet(), { lengthMm: 2430, widthMm: 1200 }, { kerfMm: 0, edgeTrimMm: 10 }).fits).toBe(
      false,
    );
  });

  it('rotates a part to make it fit when grain does not matter', () => {
    // 1000 long x 1500 wide does not fit as-is, but does turned 90°.
    const result = fits(sheet(), { lengthMm: 1000, widthMm: 1500 });
    expect(result.fits).toBe(true);
    expect(result.orientation).toBe('rotated');
  });

  it('rejects zero and negative dimensions', () => {
    expect(fits(sheet(), { lengthMm: 0, widthMm: 100 }).fits).toBe(false);
    expect(fits(sheet(), { lengthMm: -100, widthMm: 100 }).fits).toBe(false);
  });

  it('rejects a panel smaller than its own edge trim', () => {
    expect(
      fits({ id: 'tiny', lengthMm: 10, widthMm: 10 }, { lengthMm: 1, widthMm: 1 }, { edgeTrimMm: 20 })
        .fits,
    ).toBe(false);
  });
});

describe('fits — grain', () => {
  const grained = sheet({ grainDirection: 'length' });

  it('accepts a part whose grain runs the same way as the panel', () => {
    const result = fits(grained, { lengthMm: 800, widthMm: 400, grainAlong: 'length' });
    expect(result.fits).toBe(true);
    expect(result.orientation).toBe('as_is');
  });

  it('refuses to rotate a grained part just to make it fit', () => {
    // 1000 x 1500 would fit rotated, but rotating puts the grain across the
    // part — a visible defect on a door face.
    const result = fits(grained, { lengthMm: 1000, widthMm: 1500, grainAlong: 'length' });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/grain/i);
  });

  it('rotates when the part wants grain across its width', () => {
    const result = fits(grained, { lengthMm: 400, widthMm: 800, grainAlong: 'width' });
    expect(result.fits).toBe(true);
    expect(result.orientation).toBe('rotated');
  });

  it('rotates freely on a panel with no grain', () => {
    const plain = sheet({ grainDirection: null });
    const result = fits(plain, { lengthMm: 1000, widthMm: 1500, grainAlong: 'length' });
    expect(result.fits).toBe(true);
    expect(result.orientation).toBe('rotated');
  });

  it('rotates freely when the part has no grain requirement', () => {
    const result = fits(grained, { lengthMm: 1000, widthMm: 1500, grainAlong: 'any' });
    expect(result.fits).toBe(true);
  });

  it('reports "too small" rather than "wrong grain" when it is genuinely too small', () => {
    const result = fits(grained, { lengthMm: 5000, widthMm: 3000, grainAlong: 'length' });
    expect(result.reason).toMatch(/does not fit/i);
  });
});

describe('fits — material matching', () => {
  it('refuses to mix grain batches', () => {
    // Two production batches of veneer differ visibly; a run finished from both
    // is a rejected installation.
    const result = fits(sheet({ grainCode: 'OAK-B21' }), {
      lengthMm: 500,
      widthMm: 300,
      grainCode: 'OAK-B22',
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/grain batch/i);
  });

  it('refuses to mix colour batches', () => {
    const result = fits(sheet({ colourCode: 'RAL9010-A' }), {
      lengthMm: 500,
      widthMm: 300,
      colourCode: 'RAL9010-B',
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/colour batch/i);
  });

  it('does not constrain when only one side declares a batch', () => {
    expect(fits(sheet({ grainCode: 'OAK-B21' }), { lengthMm: 500, widthMm: 300 }).fits).toBe(true);
  });

  it('rejects a thickness mismatch', () => {
    expect(
      fits(sheet({ thicknessMm: 18 }), { lengthMm: 500, widthMm: 300, thicknessMm: 25 }).fits,
    ).toBe(false);
  });

  it('tolerates a small thickness difference', () => {
    expect(
      fits(sheet({ thicknessMm: 18 }), { lengthMm: 500, widthMm: 300, thicknessMm: 18.3 }).fits,
    ).toBe(true);
  });
});

describe('selectBestOffcut', () => {
  const rack: Panel[] = [
    { id: 'big', lengthMm: 2440, widthMm: 1220 },
    { id: 'medium', lengthMm: 1200, widthMm: 600 },
    { id: 'snug', lengthMm: 850, widthMm: 450 },
    { id: 'tiny', lengthMm: 300, widthMm: 200 },
  ];

  it('picks the smallest offcut that fits, not the first or the largest', () => {
    // Consuming a full sheet for an 800x400 part destroys the register's value.
    const result = selectBestOffcut(rack, { lengthMm: 800, widthMm: 400 });
    expect(result?.panel.id).toBe('snug');
  });

  it('falls back to a larger piece when nothing smaller fits', () => {
    const result = selectBestOffcut(rack, { lengthMm: 2000, widthMm: 900 });
    expect(result?.panel.id).toBe('big');
  });

  it('returns null when nothing on the rack fits', () => {
    expect(selectBestOffcut(rack, { lengthMm: 5000, widthMm: 3000 })).toBeNull();
  });

  it('respects grain when choosing', () => {
    const grainedRack: Panel[] = [
      { id: 'across', lengthMm: 900, widthMm: 500, grainDirection: 'width' },
      { id: 'along', lengthMm: 2000, widthMm: 900, grainDirection: 'length' },
    ];

    // The snug piece has the grain the wrong way, so the larger one wins.
    const result = selectBestOffcut(grainedRack, {
      lengthMm: 800,
      widthMm: 400,
      grainAlong: 'length',
    });
    expect(result?.panel.id).toBe('along');
  });

  it('returns null for an empty rack', () => {
    expect(selectBestOffcut([], { lengthMm: 100, widthMm: 100 })).toBeNull();
  });
});

describe('isUsableOffcut', () => {
  it('accepts a piece worth keeping', () => {
    expect(isUsableOffcut({ lengthMm: 1200, widthMm: 600 })).toBe(true);
  });

  it('rejects a sliver that is long but too narrow to handle', () => {
    // 2000 x 80 is 0.16m² and dangerous on a panel saw.
    expect(isUsableOffcut({ lengthMm: 2000, widthMm: 80 })).toBe(false);
  });

  it('rejects a piece below the minimum area', () => {
    expect(isUsableOffcut({ lengthMm: 400, widthMm: 400 })).toBe(false);
  });

  it('honours a tenant-configured rule', () => {
    const generous = { minimumAreaSqm: 0.05, minimumDimensionMm: 100 };
    expect(isUsableOffcut({ lengthMm: 400, widthMm: 400 }, generous)).toBe(true);
  });

  it('uses sensible defaults', () => {
    expect(DEFAULT_USABILITY.minimumAreaSqm).toBe(0.25);
  });
});

describe('guillotineRemnants', () => {
  it('leaves exactly two rectangles', () => {
    const remnants = guillotineRemnants(sheet(), { lengthMm: 1000, widthMm: 600 }, { kerfMm: 0 });
    expect(remnants).toHaveLength(2);
  });

  it('keeps one large piece rather than two awkward strips', () => {
    const remnants = guillotineRemnants(sheet(), { lengthMm: 1000, widthMm: 600 }, { kerfMm: 0 });
    const largest = Math.max(...remnants.map((r) => areaSqm(r)));

    // Cutting across the length leaves 1440 x 1220 = 1.757m². Cutting along the
    // width leaves 2440 x 620 = 1.513m². The strategy must choose the former.
    expect(largest).toBeCloseTo(1.7568, 3);
  });

  it('conserves area, allowing for the kerf', () => {
    const panel = sheet();
    const part = { lengthMm: 1000, widthMm: 600 };
    const remnants = guillotineRemnants(panel, part, { kerfMm: 0 });

    const total = remnants.reduce((sum, r) => sum + areaSqm(r), 0) + (1000 * 600) / 1_000_000;
    expect(total).toBeCloseTo(areaSqm(panel), 3);
  });

  it('drops a zero-size remnant when the part fills a dimension', () => {
    const panel: Panel = { id: 'exact', lengthMm: 1000, widthMm: 600 };
    const remnants = guillotineRemnants(panel, { lengthMm: 1000, widthMm: 400 }, { kerfMm: 0 });

    expect(remnants).toHaveLength(1);
    expect(remnants[0]!.widthMm).toBe(200);
  });

  it('returns nothing when the part does not fit', () => {
    expect(guillotineRemnants(sheet(), { lengthMm: 5000, widthMm: 3000 })).toEqual([]);
  });

  it('carries the parent grain and batch onto the remnants', () => {
    const panel = sheet({ grainDirection: 'length', grainCode: 'OAK-B21' });
    const remnants = guillotineRemnants(panel, { lengthMm: 800, widthMm: 400 }, { kerfMm: 0 });

    expect(remnants.every((r) => r.grainDirection === 'length')).toBe(true);
    expect(remnants.every((r) => r.grainCode === 'OAK-B21')).toBe(true);
  });

  it('accounts for the kerf in the remnant dimensions', () => {
    const remnants = guillotineRemnants(sheet(), { lengthMm: 1000, widthMm: 600 }, { kerfMm: 3.2 });
    const full = remnants.find((r) => r.widthMm === 1220);
    expect(full?.lengthMm).toBeCloseTo(2440 - 1000 - 3.2, 2);
  });
});

describe('yieldPercent', () => {
  it('reports the proportion of a sheet that becomes parts', () => {
    // Four 1200x600 parts from a 2440x1220 sheet.
    const parts = Array.from({ length: 4 }, () => ({ lengthMm: 1200, widthMm: 600 }));
    expect(yieldPercent(sheet(), parts)).toBeCloseTo(96.75, 1);
  });

  it('is zero for no parts', () => {
    expect(yieldPercent(sheet(), [])).toBe(0);
  });

  it('is zero for a zero-area panel rather than dividing by zero', () => {
    expect(yieldPercent({ id: 'x', lengthMm: 0, widthMm: 0 }, [{ lengthMm: 1, widthMm: 1 }])).toBe(0);
  });
});

describe('offcutCost', () => {
  it('apportions the parent cost by area', () => {
    // A quarter-sheet remnant of a 200/sheet board carries 50.
    const parent = { lengthMm: 2440, widthMm: 1220 };
    const remnant = { lengthMm: 1220, widthMm: 610 };
    expect(offcutCost(parent, 200, remnant)).toBeCloseTo(50, 2);
  });

  it('is zero for a zero-area parent', () => {
    expect(offcutCost({ lengthMm: 0, widthMm: 0 }, 100, { lengthMm: 10, widthMm: 10 })).toBe(0);
  });
});

describe('areaSqm', () => {
  it('converts square millimetres to square metres', () => {
    expect(areaSqm({ lengthMm: 2440, widthMm: 1220 })).toBeCloseTo(2.9768, 4);
  });
});
