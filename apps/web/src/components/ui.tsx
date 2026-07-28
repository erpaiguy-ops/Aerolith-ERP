/**
 * The small set of primitives every screen here needs.
 *
 * Hand-written rather than pulled from a component library, for the reason
 * recorded in the tech stack: owning the source means no licence, no vendor and
 * no upgrade treadmill. Six components is not a design system, and calling it
 * one would be the kind of premature abstraction that makes the seventh screen
 * harder rather than easier.
 */
import { money, percent, type Tone } from '@/lib/format';

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-(--color-good)',
  bad: 'text-(--color-bad)',
  neutral: 'text-(--color-ink)',
};

/**
 * Isolates a run of text from the direction of the page around it.
 *
 * On an Arabic (RTL) page, a run of Latin text is laid out by the bidi
 * algorithm as an LTR island inside an RTL paragraph — but the punctuation at
 * its edges is *neutral*, so it takes the paragraph's direction and jumps to
 * the other end. "Variations, payment applications and retention." renders as
 * ".Variations, payment applications and retention", and a search placeholder
 * ending in an ellipsis renders with the ellipsis leading. It looks like
 * corrupted text, and it happens to every untranslated string on the page.
 *
 * `<bdi>` is `unicode-bidi: isolate` with the direction taken from the first
 * strong character, so each run is ordered by its own script and the neutrals
 * stay where they were written.
 *
 * It has to be an INLINE element rather than a property on the block. Setting
 * `unicode-bidi: plaintext` on the cells fixes the ordering and then resolves
 * `text-align: start` per run too, so English cells align left while Arabic
 * ones align right and the column loses a common edge — measurably worse than
 * the bug it fixes. An inline isolate leaves alignment to the block, which
 * still knows the page direction.
 *
 * This also covers user data permanently: an Arabic supplier name on an English
 * page has exactly the same problem in reverse, and no amount of translating
 * the interface would fix it.
 */
export function Bidi({ children }: { children: React.ReactNode }) {
  return <bdi>{children}</bdi>;
}

/**
 * Isolates children only when they are text.
 *
 * Table cells hold arbitrary nodes — `Money`, `Badge`, a `ProgressBar` whose
 * outer element is a flex block. Wrapping a block in an inline `<bdi>` would
 * change how it sizes, so the isolation is applied where it is both needed and
 * safe: strings and numbers. The components that render their own text — `Money`
 * via `Intl`, which emits its own direction marks — already handle themselves.
 */
function isolated(children: React.ReactNode): React.ReactNode {
  return typeof children === 'string' || typeof children === 'number' ? (
    <bdi>{children}</bdi>
  ) : (
    children
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          <Bidi>{title}</Bidi>
        </h1>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-(--color-muted)">
            <Bidi>{subtitle}</Bidi>
          </p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

export function Card({
  title,
  children,
  footnote,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  footnote?: string;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-(--color-line) bg-(--color-surface) ${className ?? ''}`}
    >
      {title ? (
        <h2 className="border-b border-(--color-line) px-4 py-2.5 text-sm font-medium">
          <Bidi>{title}</Bidi>
        </h2>
      ) : null}
      <div className="p-4">{children}</div>
      {footnote ? (
        <p className="border-t border-(--color-line) px-4 py-2 text-xs text-(--color-muted)">
          <Bidi>{footnote}</Bidi>
        </p>
      ) : null}
    </section>
  );
}

/** A single figure. `hint` is where the arithmetic gets explained, not hidden. */
export function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  /**
   * A node, not just a string, so a figure can be rendered by `Money` or a
   * `Badge` and still sit in the grid with everything else. The `numeric` class
   * below is harmless on text and correct on the numbers, which is most of them.
   */
  value: React.ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-xs text-(--color-muted)">
        <Bidi>{label}</Bidi>
      </div>
      <div className={`numeric mt-0.5 text-lg font-medium ${TONE_CLASS[tone]}`}>
        {isolated(value)}
      </div>
      {hint ? (
        <div className="mt-0.5 text-xs text-(--color-muted)">
          <Bidi>{hint}</Bidi>
        </div>
      ) : null}
    </div>
  );
}

export function Money({
  amount,
  currency,
  tone = 'neutral',
}: {
  amount: number | string | null | undefined;
  currency: string | null | undefined;
  tone?: Tone;
}) {
  // `whitespace-nowrap` because a negative figure otherwise breaks after the
  // minus sign — "Retention held: −" on one line and the amount on the next
  // reads as a stray dash, not as a deduction.
  return (
    <span className={`numeric whitespace-nowrap ${TONE_CLASS[tone]}`}>
      {money(amount, currency)}
    </span>
  );
}

/**
 * A progress bar that never claims more than it knows.
 *
 * `uncertain` renders it hatched — used when the underlying measurement was
 * self-assessed rather than counted. A solid bar for a typed percentage is the
 * UI telling the same lie the rule-of-credit system exists to prevent.
 */
export function ProgressBar({
  value,
  uncertain = false,
}: {
  value: number | null | undefined;
  uncertain?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Number(value ?? 0)));

  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-(--color-line)"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-(--color-accent)"
          style={{
            width: `${clamped}%`,
            opacity: uncertain ? 0.55 : 1,
            backgroundImage: uncertain
              ? 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,.5) 3px, rgba(255,255,255,.5) 6px)'
              : undefined,
          }}
        />
      </div>
      <span className="numeric w-12 shrink-0 text-right text-xs text-(--color-muted)">
        {percent(clamped, 0)}
      </span>
    </div>
  );
}

export function Table({
  head,
  children,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // Wide tables scroll inside their own container rather than pushing the
    // page sideways — a BOQ is always wider than a laptop.
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="text-start text-xs text-(--color-muted)">{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// `children` is optional so a table can carry an unlabelled action column —
// a header reading "Actions" above a single button is noise.
export function Th({ children, numeric }: { children?: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      // `pe-4` is padding-INLINE-end, not padding-right: it flips with the
      // document direction, so the Arabic build gets the gap on the correct
      // side without a second rule.
      className={`border-b border-(--color-line) pb-2 pe-4 font-medium last:pe-0 ${
        numeric ? 'text-end' : 'text-start'
      }`}
    >
      {isolated(children)}
    </th>
  );
}

export function Td({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td
      // Without the inline-end padding a right-aligned number touches the next
      // column and renders as one run of characters — "AED 14,112.0005 Apr
      // 2026" — which looks like corrupt data rather than a spacing bug.
      className={`border-b border-(--color-line) py-2 pe-4 last:pe-0 ${
        numeric ? 'numeric text-end' : 'text-start'
      }`}
    >
      {isolated(children)}
    </td>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: Tone }) {
  const classes: Record<Tone, string> = {
    good: 'bg-(--color-good)/10 text-(--color-good)',
    bad: 'bg-(--color-bad)/10 text-(--color-bad)',
    neutral: 'bg-(--color-canvas) text-(--color-muted)',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${classes[tone]}`}>
      {isolated(children)}
    </span>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-(--color-line) p-8 text-center">
      <p className="text-sm font-medium">
        <Bidi>{title}</Bidi>
      </p>
      {detail ? (
        <p className="mt-1 text-sm text-(--color-muted)">
          <Bidi>{detail}</Bidi>
        </p>
      ) : null}
    </div>
  );
}
