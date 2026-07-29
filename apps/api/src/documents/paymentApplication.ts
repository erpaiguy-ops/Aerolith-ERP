/**
 * The payment application, as a document you can send.
 *
 * Composed here rather than in the Contracts module for the same reason the
 * cutlist drawing is: `@aerolith/pdf` is an engine, modules depend only on the
 * kernel, and the application layer is what may depend on both. A module that
 * imported a PDF writer would be a module that could not be sold without one.
 *
 * **Formatted for the tenant, not for the developer.** A valuation is read by a
 * quantity surveyor and a client's cost consultant, and the figures have to look
 * the way the rest of that job's paperwork looks — so money goes through `Intl`
 * with the tenant's own locale and currency rather than `toFixed(2)`.
 *
 * The one thing this document cannot do is Arabic, and the reason is in
 * `@aerolith/pdf`: the base-14 fonts are WinAnsi-encoded and nothing is
 * embedded. `isRenderable` is used below to say so on the document itself rather
 * than let a project name silently become question marks.
 */
import { A4, Layout, isRenderable, renderPdf } from '@aerolith/pdf';

export interface ApplicationDocumentInput {
  tenant: { name: string; locale: string; currencyCode: string | null; taxRegistrationNumber?: string | null };
  contract: {
    number: string | null;
    name: string;
    currencyCode: string | null;
    paymentTermDays: number | null;
    retentionPercent: string | null;
  } | null;
  project: { code: string | null; name: string | null } | null;
  client: { name: string | null } | null;
  application: {
    number: string | null;
    sequence: number;
    status: string;
    periodFrom: string | null;
    periodTo: string;
    workDoneToDate: string;
    variationsToDate: string;
    materialsOnSite: string;
    grossValuationToDate: string;
    retentionHeldToDate: string;
    advanceRecoveredToDate: string;
    netValuationToDate: string;
    previouslyCertifiedNet: string;
    netThisApplication: string;
    taxAmount: string;
    totalApplied: string;
    certifiedNet: string | null;
    certifiedTotal: string | null;
    certifiedOn: string | null;
    certificateReference: string | null;
    disallowedReason: string | null;
    submittedOn: string | null;
    dueOn: string | null;
  };
  lines: {
    description: string;
    uomCode: string | null;
    unitRate: string;
    quantityToDate: string;
    valueToDate: string;
    valueThisPeriod: string;
  }[];
}

export function renderApplicationPdf(input: ApplicationDocumentInput): Uint8Array {
  const { application: app, contract, tenant } = input;
  const currency = contract?.currencyCode ?? tenant.currencyCode ?? undefined;
  const locale = tenant.locale || 'en';

  const money = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === '') return '—';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    return new Intl.NumberFormat(locale, {
      style: currency ? 'currency' : 'decimal',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const day = (value: string | null | undefined): string => {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    // UTC: a valuation period ends on a date, not at a moment, and rendering it
    // in the server's zone moves month-ends across the boundary they define.
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed);
  };

  const quantity = (value: string | null | undefined, uom: string | null): string => {
    if (value === null || value === undefined) return '—';
    const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
      Number(value),
    );
    return uom ? `${formatted} ${uom}` : formatted;
  };

  const layout = new Layout(A4);
  const title = app.number ?? `Application ${app.sequence}`;

  layout.heading(
    'Interim payment application',
    [title, contract?.number, contract?.name].filter(Boolean).join(' · '),
  );

  layout.facts([
    ['Employer / client', input.client?.name ?? '—'],
    ['Contractor', tenant.name],
    ['Project', [input.project?.code, input.project?.name].filter(Boolean).join(' — ') || '—'],
    ['Contract', [contract?.number, contract?.name].filter(Boolean).join(' — ') || '—'],
    ['Valuation period', `${day(app.periodFrom)} to ${day(app.periodTo)}`],
    ['Application number', `${title} (no. ${app.sequence})`],
    ['Submitted', day(app.submittedOn)],
    [
      'Payment due',
      app.dueOn
        ? `${day(app.dueOn)}${contract?.paymentTermDays ? ` (${contract.paymentTermDays} days)` : ''}`
        : '—',
    ],
  ]);

  if (input.lines.length > 0) {
    layout.sectionTitle('Valuation of work');
    layout.table(
      [
        { header: 'Description', width: 0.4 },
        { header: 'Rate', width: 0.14, align: 'end' },
        { header: 'Quantity to date', width: 0.16, align: 'end' },
        { header: 'Value to date', width: 0.15, align: 'end' },
        { header: 'This period', width: 0.15, align: 'end' },
      ],
      input.lines.map((line) => [
        line.description,
        money(line.unitRate),
        quantity(line.quantityToDate, line.uomCode),
        money(line.valueToDate),
        money(line.valueThisPeriod),
      ]),
      {
        totals: [
          'Total',
          '',
          '',
          money(sum(input.lines.map((l) => l.valueToDate))),
          money(sum(input.lines.map((l) => l.valueThisPeriod))),
        ],
      },
    );
  }

  layout.sectionTitle('Valuation summary');

  /*
   * The order is the order the arithmetic runs in, and it is the order a cost
   * consultant checks it in: gross, then what is held back, then what was
   * already paid. A summary that jumps to the net figure is one that has to be
   * taken on trust.
   */
  layout.summary([
    ['Work done to date', money(app.workDoneToDate)],
    ['Variations to date', money(app.variationsToDate)],
    ['Materials on site', money(app.materialsOnSite)],
    ['Gross valuation to date', money(app.grossValuationToDate)],
    [
      contract?.retentionPercent
        ? `Less retention (${Number(contract.retentionPercent)}%)`
        : 'Less retention',
      `(${money(app.retentionHeldToDate)})`,
    ],
    ['Less advance recovered', `(${money(app.advanceRecoveredToDate)})`],
    ['Net valuation to date', money(app.netValuationToDate)],
    ['Less previously certified', `(${money(app.previouslyCertifiedNet)})`],
    ['Net this application', money(app.netThisApplication)],
    ['Tax', money(app.taxAmount)],
    ['Total applied', money(app.totalApplied)],
  ]);

  if (app.certifiedNet !== null) {
    layout.sectionTitle('Certified by the client');
    layout.summary([
      ['Certified on', day(app.certifiedOn)],
      ['Certificate reference', app.certificateReference ?? '—'],
      ['Certified net', money(app.certifiedNet)],
      [
        // The difference is the most useful commercial fact on the page and the
        // one a spreadsheet destroys by typing one figure over the other.
        'Difference from applied',
        money(Number(app.certifiedNet) - Number(app.netThisApplication)),
      ],
      ['Certified total', money(app.certifiedTotal)],
    ]);

    if (app.disallowedReason) {
      layout.sectionTitle('Disallowed');
      layout.paragraph(app.disallowedReason);
    }
  } else {
    layout.sectionTitle('Certification');
    layout.paragraph(
      'This application has not yet been certified. The figures above are the amounts applied for, ' +
        'not amounts agreed.',
    );
  }

  // Said on the document rather than discovered by the recipient. A project or
  // client name outside Latin-1 prints as question marks until a font is
  // embedded, and a certificate that quietly mangles the employer's name is not
  // one you want to have sent.
  const unrenderable = [
    input.client?.name,
    input.project?.name,
    contract?.name,
    tenant.name,
    ...input.lines.map((line) => line.description),
  ].filter((value): value is string => typeof value === 'string' && !isRenderable(value));

  if (unrenderable.length > 0) {
    layout.sectionTitle('Note');
    layout.paragraph(
      'Some text on this document could not be rendered in the document font and appears as ' +
        'question marks. Non-Latin scripts need an embedded font, which this build does not yet ' +
        'carry.',
      { grey: 0.45 },
    );
  }

  layout.footer(
    [
      tenant.name,
      tenant.taxRegistrationNumber ? `TRN ${tenant.taxRegistrationNumber}` : null,
      `Generated ${day(new Date().toISOString().slice(0, 10))}`,
    ]
      .filter(Boolean)
      .join('  ·  '),
  );

  return renderPdf(layout.pages, {
    title: `${title} — ${contract?.name ?? 'Payment application'}`,
    author: tenant.name,
    subject: 'Interim payment application',
  });
}

function sum(values: (string | null)[]): number {
  return values.reduce<number>((total, value) => total + (value === null ? 0 : Number(value)), 0);
}
