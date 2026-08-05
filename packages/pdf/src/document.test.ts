import { describe, expect, it } from 'vitest';

import { A4, Page, encodeText, isRenderable, renderPdf, truncate, widthOf } from './document';
import { Layout } from './layout';

const decode = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

/**
 * Every offset in the cross-reference table must point at the byte where that
 * object's header begins. This is the invariant a reader checks first and the
 * one a hand-written PDF gets wrong, because it only breaks once the file
 * contains a character whose UTF-8 length is not 1.
 */
function assertXref(bytes: Uint8Array): { objects: number; offsets: number[] } {
  const text = decode(bytes);
  const match = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text);
  expect(match, 'the file has an xref table').toBeTruthy();

  const size = Number(match![1]);
  const entries = match![2]!.trimEnd().split('\n');
  expect(entries).toHaveLength(size);
  expect(entries[0]).toBe('0000000000 65535 f ');

  const offsets = entries.slice(1).map((entry) => Number(entry.slice(0, 10)));
  offsets.forEach((offset, index) => {
    expect(text.slice(offset, offset + 20)).toMatch(new RegExp(`^${index + 1} 0 obj`));
  });

  const startxref = /startxref\n(\d+)/.exec(text);
  expect(text.slice(Number(startxref![1]), Number(startxref![1]) + 4)).toBe('xref');

  return { objects: size - 1, offsets };
}

describe('renderPdf', () => {
  it('produces a file a reader will accept', () => {
    const page = new Page(A4.width, A4.height);
    page.text(50, 700, 'Payment certificate');

    const bytes = renderPdf([page], { title: 'Test' });
    const text = decode(bytes);

    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    assertXref(bytes);
  });

  it('keeps the xref honest when the text is not ASCII', () => {
    // The failure this pins: measuring object lengths in UTF-8 while writing
    // bytes in Latin-1 puts every offset after the first accented character out
    // by one, and the file opens as "damaged" rather than as wrong.
    const page = new Page(A4.width, A4.height);
    page.text(50, 700, 'Société Générale — Café, £250, ½ done');

    const bytes = renderPdf([page], { title: 'Accents' });
    assertXref(bytes);
    // One byte per character, so the stream length declared equals the bytes.
    const text = decode(bytes);
    const length = Number(/\/Length (\d+) >>\nstream\n/.exec(text)![1]);
    const stream = /stream\n([\s\S]*?)\nendstream/.exec(text)![1]!;
    expect(stream.length).toBe(length);
  });

  it('counts pages and links them all to one Pages node', () => {
    const pages = [1, 2, 3].map((n) => {
      const page = new Page(A4.width, A4.height);
      page.text(50, 700, `Page ${n}`);
      return page;
    });

    const text = decode(renderPdf(pages, { title: 'Three' }));
    expect(text).toMatch(/\/Count 3/);
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(3);
  });

  it('refuses to render nothing', () => {
    expect(() => renderPdf([], { title: 'Empty' })).toThrow(/at least one page/);
  });
});

describe('encodeText', () => {
  it('escapes what would end a literal', () => {
    expect(encodeText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
  });

  it('transliterates punctuation instead of losing it', () => {
    // The first generated certificate came out full of question marks because
    // the placeholder for a missing value was an em dash. An em dash is
    // punctuation, not script: a hyphen loses nothing.
    expect(encodeText('Marina Tower — joinery')).toBe('Marina Tower - joinery');
    expect(encodeText('it\u2019s “quoted” and 1\u20262')).toBe('it\'s "quoted" and 1...2');
    expect(isRenderable('Marina Tower — joinery')).toBe(true);
    // And it must be measured after folding, or every right-aligned figure on
    // the line drifts by the difference in character count.
    expect(widthOf('a—b', 'Helvetica', 10)).toBeCloseTo(widthOf('a-b', 'Helvetica', 10), 6);
  });

  it('replaces what the base-14 fonts cannot draw, rather than mangling it', () => {
    // Writing the low byte of an Arabic codepoint produces a plausible Latin
    // character, which on a payment certificate is worse than an obvious gap.
    expect(encodeText('مبنى')).toBe('????');
    expect(isRenderable('مبنى')).toBe(false);
    expect(isRenderable('Marina Tower')).toBe(true);
  });

  it('keeps Latin-1 intact', () => {
    expect(encodeText('Café £250')).toBe('Café £250');
  });
});

describe('widthOf', () => {
  it('measures against the real font metrics', () => {
    // Helvetica digits are 556/1000 em, so ten of them at 10pt is 55.6pt.
    expect(widthOf('0123456789', 'Helvetica', 10)).toBeCloseTo(55.6, 4);
    // Bold is wider for letters but not for digits — the whole reason a column
    // of figures aligns whichever weight it is set in.
    expect(widthOf('0123456789', 'Helvetica-Bold', 10)).toBeCloseTo(55.6, 4);
    expect(widthOf('Aerolith', 'Helvetica-Bold', 10)).toBeGreaterThan(
      widthOf('Aerolith', 'Helvetica', 10),
    );
  });

  it('truncates to a measured width, not a guessed character count', () => {
    const long = 'Supply and install veneered doors to level 12 lobby including ironmongery';
    const cut = truncate(long, 'Helvetica', 9, 120);

    expect(cut.endsWith('…')).toBe(true);
    expect(widthOf(cut, 'Helvetica', 9)).toBeLessThanOrEqual(120);
    expect(truncate('short', 'Helvetica', 9, 120)).toBe('short');
  });
});

describe('Layout', () => {
  it('breaks a long table across pages and repeats the header', () => {
    const layout = new Layout();
    layout.heading('Payment application', 'IPC-2026-00001');
    layout.table(
      [
        { header: 'Description', width: 0.7 },
        { header: 'Value', width: 0.3, align: 'end' },
      ],
      Array.from({ length: 90 }, (_, i) => [`Line ${i + 1}`, `${(i + 1) * 100}.00`]),
    );
    layout.footer('Aerolith Demo Joinery');

    expect(layout.pages.length).toBeGreaterThan(1);

    const text = decode(renderPdf(layout.pages, { title: 'Long' }));
    // The header is drawn once per page, so a reader who turns over still knows
    // what the right-hand column is.
    expect(text.match(/\(Description\) Tj/g)!.length).toBe(layout.pages.length);
    // "Page n of m" can only be right if it is written after the last page
    // exists — the classic way a report ends up saying "page 2 of 2" of five.
    expect(text).toContain(`(Page ${layout.pages.length} of ${layout.pages.length}) Tj`);
    expect(text).toContain('(Page 1 of ');
  });

  it('rejects columns that do not fill the width', () => {
    const layout = new Layout();
    expect(() =>
      layout.table([{ header: 'One', width: 0.4 }, { header: 'Two', width: 0.4 }], []),
    ).toThrow(/sum to 1/);
  });

  it('right-aligns a figure to the page margin', () => {
    const layout = new Layout();
    layout.summary([['Total', '1,234.56']]);

    const body = layout.pages[0]!.content();
    const x = Number(/([\d.]+) [\d.]+ Td \(1,234\.56\)/.exec(body)![1]);
    // Its right edge lands on the margin, whatever the digits are.
    expect(x + widthOf('1,234.56', 'Helvetica-Bold', 11)).toBeCloseTo(layout.right, 1);
  });
});
