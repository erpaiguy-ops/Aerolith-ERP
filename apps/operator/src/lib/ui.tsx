/**
 * The handful of presentational pieces this surface needs.
 *
 * Written out rather than imported from apps/web: that module reaches
 * `lib/locale` through `lib/format` and is `server-only` in a way tied to the
 * tenant request context, and there is no tenant here. Sharing them would mean
 * a package that serves two masters and gets worse at both — see
 * docs/07-platform-operations.md.
 */
export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'text-(--color-good) border-(--color-good)/40 bg-(--color-good)/10'
      : status === 'trial'
        ? 'text-(--color-warn) border-(--color-warn)/40 bg-(--color-warn)/10'
        : 'text-(--color-bad) border-(--color-bad)/40 bg-(--color-bad)/10';

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}>{status}</span>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-(--color-line) bg-(--color-surface)">
      {title ? (
        <h2 className="border-b border-(--color-line) px-4 py-3 text-sm font-medium">{title}</h2>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface) px-4 py-3">
      <div className="text-xs text-(--color-muted)">{label}</div>
      <div className="numeric mt-0.5 text-2xl font-semibold">{value}</div>
    </div>
  );
}

/** ISO date, or an em dash. Never a locale format — operators compare these. */
export function day(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : '—';
}
