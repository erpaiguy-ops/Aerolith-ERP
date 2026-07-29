/**
 * A minimal PDF writer.
 *
 * Zero dependencies, not even Node — the same rule as `@aerolith/cutlist`, and
 * for the same reasons: it runs in the API today, in a worker tomorrow, and
 * nothing about generating a payment certificate should drag a headless browser
 * onto a free-tier VM with 24 GB of RAM doing real work.
 *
 * **Only the base-14 fonts.** Helvetica and Helvetica-Bold are guaranteed by
 * every conforming reader, so nothing is embedded and a two-page certificate is
 * a few kilobytes rather than a few hundred. The cost is stated plainly in
 * `encodeText`: WinAnsi covers Latin-1 and nothing else, so Arabic text needs an
 * embedded font before these documents can carry it. That is the same gap the
 * interface has, and pretending otherwise by emitting replacement characters
 * silently would be worse than saying so.
 *
 * Everything is written in PDF user space: origin bottom-left, 72 units to the
 * inch. A4 is 595.28 x 841.89.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

export type FontName = 'Helvetica' | 'Helvetica-Bold';

export interface TextOptions {
  font?: FontName;
  size?: number;
  /** 0 = black, 1 = white. Greys only; nothing here needs colour. */
  grey?: number;
}

interface Op {
  /** Content-stream fragment. */
  body: string;
}

/**
 * One page being written.
 *
 * Content is accumulated as operators and serialised once, because a PDF content
 * stream has to declare its own length before the reader will parse it.
 */
export class Page {
  private readonly ops: Op[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  text(x: number, y: number, value: string, options: TextOptions = {}): this {
    const font = options.font ?? 'Helvetica';
    const size = options.size ?? 10;
    const grey = options.grey ?? 0;

    this.ops.push({
      body:
        `BT /${font === 'Helvetica-Bold' ? 'F2' : 'F1'} ${num(size)} Tf ` +
        `${num(grey)} g ${num(x)} ${num(y)} Td (${encodeText(value)}) Tj ET`,
    });
    return this;
  }

  /**
   * Right-aligned text.
   *
   * Money on a certificate is read down a column, and a column of figures that
   * does not share a right edge cannot be read down at all. The width is
   * measured, not guessed — see `widthOf`.
   */
  textRight(right: number, y: number, value: string, options: TextOptions = {}): this {
    const size = options.size ?? 10;
    return this.text(right - widthOf(value, options.font ?? 'Helvetica', size), y, value, options);
  }

  line(x1: number, y1: number, x2: number, y2: number, grey = 0.75, width = 0.5): this {
    this.ops.push({
      body: `${num(grey)} G ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`,
    });
    return this;
  }

  rect(x: number, y: number, w: number, h: number, grey = 0.93): this {
    this.ops.push({ body: `${num(grey)} g ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f` });
    return this;
  }

  /** The content stream, ready to be wrapped in a stream object. */
  content(): string {
    return this.ops.map((op) => op.body).join('\n');
  }
}

export interface DocumentInfo {
  title: string;
  author?: string;
  subject?: string;
}

/**
 * Builds the file.
 *
 * The cross-reference table is why this is assembled in one pass at the end:
 * every object's byte offset has to be known, and the only honest way to know it
 * is to have written everything before it.
 */
export function renderPdf(pages: Page[], info: DocumentInfo): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 1-based object numbers
  };

  // Reserved so the page objects can name their parent before it exists.
  const catalogId = add('');
  const pagesId = add('');
  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.content();
    const contentId = add(
      `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

  const infoId = add(
    `<< /Title (${encodeText(info.title)}) ` +
      `/Author (${encodeText(info.author ?? 'Aerolith')}) ` +
      (info.subject ? `/Subject (${encodeText(info.subject)}) ` : '') +
      `/Producer (Aerolith ERP) >>`,
  );

  const chunks: string[] = ['%PDF-1.7\n'];
  // A binary comment on line two tells anything transferring this file that it
  // is not text. Without it a naive FTP or mail gateway may mangle line endings.
  chunks.push('%âãÏÓ\n');

  const offsets: number[] = [];
  let position = byteLength(chunks.join(''));

  objects.forEach((body, index) => {
    const serialised = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(position);
    position += byteLength(serialised);
    chunks.push(serialised);
  });

  const xrefStart = position;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('');

  chunks.push(xref);
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  );

  return latin1Bytes(chunks.join(''));
}

// ---------------------------------------------------------------------------

/**
 * Typography that is not Latin-1 but has an exact Latin-1 reading.
 *
 * An em dash, a curly quote and an ellipsis are punctuation, not script: they
 * carry no information a hyphen or a straight quote loses. Replacing them is
 * transliteration, not mangling, and without it an ordinary English document
 * written with proper punctuation prints as a row of question marks — which is
 * how the first generated certificate came out, because the placeholder for a
 * missing value was itself an em dash.
 *
 * Arabic and CJK are deliberately NOT in here. There is no faithful Latin
 * reading of them, so they stay unrenderable and the caller is told.
 */
const TRANSLITERATE: Record<string, string> = {
  '\u2014': '-', // em dash
  '\u2013': '-', // en dash
  '\u2212': '-', // minus sign
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': ',',
  '\u201c': '"',
  '\u201d': '"',
  '\u2026': '...',
  '\u00a0': ' ', // non-breaking space
  '\u200f': '', // right-to-left mark, which Intl inserts around Arabic currency
  '\u200e': '',
  '\u2022': '\u00b7', // bullet → middle dot, which IS in Latin-1
  '\u20ac': '\u0080', // euro, at 128 in WinAnsi rather than at its Unicode point
};

/** Latin-1 with the punctuation folded in. Shared by encoding and measuring. */
function normalise(value: string): string {
  let out = '';
  for (const char of value) out += TRANSLITERATE[char] ?? char;
  return out;
}

/**
 * Escapes a string for a PDF literal, and says what it cannot carry.
 *
 * `(`, `)` and `\` end or escape a literal, so they are escaped. Anything still
 * outside Latin-1 after transliteration is replaced rather than mangled: the
 * base-14 fonts are WinAnsi-encoded, so an Arabic or CJK codepoint has no glyph
 * and writing its low byte would produce a plausible-looking wrong character —
 * which on a payment certificate is worse than an obvious gap.
 */
export function encodeText(value: string): string {
  let out = '';
  for (const char of normalise(value)) {
    const code = char.codePointAt(0)!;
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code === 10 || code === 13) out += ' ';
    else if (code < 32) continue;
    else if (code <= 255) out += char;
    else out += '?';
  }
  return out;
}

/**
 * Whether a string survives to the page intact.
 *
 * Measured after transliteration, so a project called `Marina Tower — joinery`
 * counts as renderable (the dash becomes a hyphen) while an Arabic name does
 * not. Callers use this to say so on the document rather than let the recipient
 * discover it.
 */
export function isRenderable(value: string): boolean {
  for (const char of normalise(value)) if (char.codePointAt(0)! > 255) return false;
  return true;
}

/**
 * Text width in points.
 *
 * Helvetica's advance widths, in units of 1/1000 em, taken from the Adobe core
 * font metrics. They are needed for right alignment and for truncating a long
 * description to a column — guessing at an average character width puts a
 * ten-digit figure through the edge of the page often enough to matter.
 */
export function widthOf(value: string, font: FontName, size: number): number {
  const table = font === 'Helvetica-Bold' ? BOLD_WIDTHS : REGULAR_WIDTHS;
  let total = 0;
  // Measured after transliteration, or an em dash counts as one character here
  // and prints as one hyphen there, and every right-aligned figure on the line
  // drifts by the difference.
  for (const char of normalise(value)) {
    const code = char.codePointAt(0)!;
    total += table[code] ?? (code > 255 ? 556 : 556);
  }
  return (total * size) / 1000;
}

/** Shortens to fit, with an ellipsis, measuring as it goes. */
export function truncate(value: string, font: FontName, size: number, maxWidth: number): string {
  if (widthOf(value, font, size) <= maxWidth) return value;

  let out = '';
  for (const char of value) {
    if (widthOf(`${out}${char}…`, font, size) > maxWidth) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

function num(value: number): string {
  // Two decimals is finer than a printer resolves and keeps the file small.
  return String(Math.round(value * 100) / 100);
}

function byteLength(value: string): number {
  // Latin-1: one byte per code unit. Measuring in UTF-8 here would put every
  // xref offset out by the number of high characters above it, and a reader
  // would refuse the file.
  return value.length;
}

function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Adobe core metrics for Helvetica, code point → advance width.
 *
 * Only the printable Latin-1 range, because that is all the encoding carries.
 * Anything absent falls back to 556, which is the width of a digit and the most
 * common width in the font.
 */
const REGULAR_WIDTHS: Record<number, number> = buildWidths(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
);

const BOLD_WIDTHS: Record<number, number> = buildWidths(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
);

function buildWidths(characters: string, widths: number[]): Record<number, number> {
  const table: Record<number, number> = {};
  [...characters].forEach((char, index) => {
    const width = widths[index];
    if (width !== undefined) table[char.codePointAt(0)!] = width;
  });
  return table;
}
