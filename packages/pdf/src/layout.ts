/**
 * The furniture a business document needs: a header, key/value blocks, a table
 * that breaks across pages, and a footer that knows how many pages there are.
 *
 * Kept separate from `document.ts` so the writer stays a writer. Nothing here
 * knows what a payment application is either — that lives in the module that
 * has one.
 */
import { A4, Page, truncate, widthOf, type FontName } from './document';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const MARGINS: Margins = { top: 56, right: 42, bottom: 56, left: 42 };

export interface Column {
  header: string;
  /** Fraction of the available width. The row asserts these sum to 1. */
  width: number;
  align?: 'start' | 'end';
}

/**
 * A document being laid out top-down.
 *
 * Tracks the cursor and opens a new page when the next block will not fit,
 * which is the only part of document layout that is genuinely fiddly: a table
 * that runs off the bottom of the page silently is a certificate that is missing
 * lines, and nobody notices until the client does.
 */
export class Layout {
  readonly pages: Page[] = [];
  private page: Page;
  private y: number;

  constructor(
    private readonly size: { width: number; height: number } = A4,
    private readonly margins: Margins = MARGINS,
  ) {
    this.page = new Page(size.width, size.height);
    this.pages.push(this.page);
    this.y = size.height - margins.top;
  }

  get current(): Page {
    return this.page;
  }

  get contentWidth(): number {
    return this.size.width - this.margins.left - this.margins.right;
  }

  get right(): number {
    return this.size.width - this.margins.right;
  }

  /** Opens a new page and resets the cursor. */
  break(): Page {
    this.page = new Page(this.size.width, this.size.height);
    this.pages.push(this.page);
    this.y = this.size.height - this.margins.top;
    return this.page;
  }

  /** Ensures `height` fits below the cursor, breaking if it does not. */
  reserve(height: number): void {
    if (this.y - height < this.margins.bottom) this.break();
  }

  move(down: number): void {
    this.y -= down;
  }

  get cursor(): number {
    return this.y;
  }

  heading(title: string, subtitle?: string): void {
    this.reserve(subtitle ? 40 : 26);
    this.page.text(this.margins.left, this.y, title, { font: 'Helvetica-Bold', size: 16 });
    this.y -= 16;
    if (subtitle) {
      this.page.text(this.margins.left, this.y, subtitle, { size: 9, grey: 0.4 });
      this.y -= 12;
    }
    this.y -= 8;
    this.page.line(this.margins.left, this.y, this.right, this.y, 0.8);
    this.y -= 16;
  }

  sectionTitle(text: string): void {
    this.reserve(24);
    this.page.text(this.margins.left, this.y, text.toUpperCase(), {
      font: 'Helvetica-Bold',
      size: 8,
      grey: 0.4,
    });
    this.y -= 14;
  }

  /**
   * A two-column block of facts.
   *
   * Laid out in pairs across the page rather than as one long list, because a
   * certificate's header is read at a glance and eight stacked rows is not a
   * glance.
   */
  facts(entries: [string, string][], columns = 2): void {
    const columnWidth = this.contentWidth / columns;

    for (let index = 0; index < entries.length; index += columns) {
      this.reserve(26);
      const row = entries.slice(index, index + columns);

      row.forEach(([label, value], column) => {
        const x = this.margins.left + column * columnWidth;
        this.page.text(x, this.y, label, { size: 7.5, grey: 0.45 });
        this.page.text(x, this.y - 11, value, { size: 10 });
      });

      this.y -= 26;
    }
    this.y -= 4;
  }

  /**
   * A table, breaking across pages with its header repeated.
   *
   * `rows` are already strings: formatting money and dates is the caller's job,
   * and it must be, because a document is rendered in the tenant's locale and
   * this package deliberately knows nothing about locales.
   */
  table(columns: Column[], rows: string[][], options: { totals?: string[] } = {}): void {
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    if (Math.abs(total - 1) > 0.001) {
      throw new Error(`Table column widths must sum to 1, got ${total}.`);
    }

    const xs: number[] = [];
    let x = this.margins.left;
    for (const column of columns) {
      xs.push(x);
      x += column.width * this.contentWidth;
    }

    const header = () => {
      this.reserve(24);
      columns.forEach((column, index) => {
        const cellRight = xs[index]! + column.width * this.contentWidth;
        if (column.align === 'end') {
          this.page.textRight(cellRight - 4, this.y, column.header, {
            font: 'Helvetica-Bold',
            size: 8,
            grey: 0.35,
          });
        } else {
          this.page.text(xs[index]!, this.y, column.header, {
            font: 'Helvetica-Bold',
            size: 8,
            grey: 0.35,
          });
        }
      });
      this.y -= 6;
      this.page.line(this.margins.left, this.y, this.right, this.y, 0.8);
      this.y -= 12;
    };

    header();

    for (const row of rows) {
      if (this.y - 16 < this.margins.bottom) {
        this.break();
        header();
      }

      columns.forEach((column, index) => {
        const width = column.width * this.contentWidth;
        const value = truncate(row[index] ?? '', 'Helvetica', 9, width - 6);
        if (column.align === 'end') {
          this.page.textRight(xs[index]! + width - 4, this.y, value, { size: 9 });
        } else {
          this.page.text(xs[index]!, this.y, value, { size: 9 });
        }
      });

      this.y -= 14;
      this.page.line(this.margins.left, this.y + 4, this.right, this.y + 4, 0.9, 0.25);
    }

    if (options.totals) {
      this.reserve(22);
      this.y -= 2;
      this.page.line(this.margins.left, this.y + 8, this.right, this.y + 8, 0.5);
      columns.forEach((column, index) => {
        const width = column.width * this.contentWidth;
        const value = options.totals![index] ?? '';
        if (!value) return;
        if (column.align === 'end') {
          this.page.textRight(xs[index]! + width - 4, this.y, value, {
            font: 'Helvetica-Bold',
            size: 9,
          });
        } else {
          this.page.text(xs[index]!, this.y, value, { font: 'Helvetica-Bold', size: 9 });
        }
      });
      this.y -= 16;
    }

    this.y -= 8;
  }

  /** A right-aligned summary block — the figures the document exists to state. */
  summary(entries: [string, string][], emphasiseLast = true): void {
    const width = 220;
    const left = this.right - width;

    for (const [index, [label, value]] of entries.entries()) {
      const last = emphasiseLast && index === entries.length - 1;
      this.reserve(last ? 24 : 16);

      if (last) {
        this.page.line(left, this.y + 11, this.right, this.y + 11, 0.5);
        this.y -= 4;
      }

      this.page.text(left, this.y, label, {
        size: last ? 10 : 9,
        grey: last ? 0 : 0.4,
        font: last ? 'Helvetica-Bold' : 'Helvetica',
      });
      this.page.textRight(this.right, this.y, value, {
        size: last ? 11 : 9,
        font: last ? 'Helvetica-Bold' : 'Helvetica',
      });
      this.y -= last ? 18 : 14;
    }
    this.y -= 6;
  }

  paragraph(text: string, options: { size?: number; grey?: number } = {}): void {
    const size = options.size ?? 9;
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';

    const flush = () => {
      if (!line) return;
      this.reserve(14);
      this.page.text(this.margins.left, this.y, line, { size, grey: options.grey ?? 0.3 });
      this.y -= 12;
      line = '';
    };

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, 'Helvetica', size) > this.contentWidth) {
        flush();
        line = word;
      } else {
        line = candidate;
      }
    }
    flush();
    this.y -= 6;
  }

  /**
   * Stamps a footer on every page.
   *
   * Done at the end because "page 2 of 5" cannot be written before page 5
   * exists — which is the whole reason documents get printed with "page 2 of 2"
   * on a five page report.
   */
  footer(text: string, font: FontName = 'Helvetica'): void {
    this.pages.forEach((page, index) => {
      const y = this.margins.bottom - 22;
      page.line(this.margins.left, y + 14, this.right, y + 14, 0.85, 0.25);
      page.text(this.margins.left, y, text, { size: 7.5, grey: 0.45, font });
      page.textRight(this.right, y, `Page ${index + 1} of ${this.pages.length}`, {
        size: 7.5,
        grey: 0.45,
      });
    });
  }
}
