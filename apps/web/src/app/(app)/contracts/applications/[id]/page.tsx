import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch, pageFetch } from '@/lib/api';
import { date, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

interface ApplicationDetail {
  application: {
    id: string;
    contractId: string;
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
    paidOn: string | null;
  };
  contract: {
    id: string;
    number: string | null;
    name: string;
    currencyCode: string | null;
    paymentTermDays: number | null;
  } | null;
  lines: {
    id: string;
    description: string;
    uomCode: string | null;
    unitRate: string;
    quantityContract: string | null;
    quantityToDate: string;
    quantityPrevious: string;
    valueToDate: string;
    valueThisPeriod: string;
  }[];
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

/** Sends the valuation to the client and starts the certification clock. */
async function submit(id: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';

  const submittedOn = String(form.get('submittedOn') ?? '');
  if (!submittedOn) return { status: 'error', error: 'Give the date this went to the client.' };

  return runAction(
    () =>
      apiFetch(`/contracts/applications/${id}/submit`, {
        method: 'POST',
        body: { submittedOn },
      }),
    {
      revalidate: [`/contracts/applications/${id}`, '/contracts/applications'],
      success: 'Submitted.',
    },
  );
}

/**
 * Records what the client actually certified.
 *
 * Kept as a separate figure rather than overwriting the application, because the
 * difference between the two is the most useful commercial fact on the job. A
 * spreadsheet destroys it by typing one over the other, and then nobody can
 * answer "how much does this client trim, on average" — which is a number you
 * can price the next tender against.
 */
async function certify(id: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';

  const certifiedOn = String(form.get('certifiedOn') ?? '');
  const raw = form.get('certifiedNet');
  const certifiedNet = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;

  if (!certifiedOn) return { status: 'error', error: 'Give the date on the certificate.' };
  if (!Number.isFinite(certifiedNet)) {
    return { status: 'error', error: 'Give the net amount the client certified.' };
  }

  return runAction(
    () =>
      apiFetch(`/contracts/applications/${id}/certify`, {
        method: 'POST',
        body: {
          certifiedNet,
          certifiedOn,
          certificateReference: requiredText(form, 'certificateReference') ?? undefined,
          disallowedReason: requiredText(form, 'disallowedReason') ?? undefined,
        },
      }),
    {
      revalidate: [
        `/contracts/applications/${id}`,
        '/contracts/applications',
        '/contracts',
      ],
      success: 'Certificate recorded.',
    },
  );
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let detail: ApplicationDetail;
  try {
    detail = await pageFetch<ApplicationDetail>(`/contracts/applications/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { application, contract, lines } = detail;
  const currency = contract?.currencyCode ?? me.tenant.currencyCode;

  const applied = num(application.totalApplied);
  const certified = application.certifiedTotal == null ? null : num(application.certifiedTotal);
  const disallowed = certified == null ? null : certified - applied;

  const isDraft = application.status === 'draft';
  const isSubmitted = application.status === 'submitted';
  const maySubmit = can(me.permissions, 'contracts.application.submit');
  const mayCertify = can(me.permissions, 'contracts.application.certify');

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={application.number ?? `IPC ${application.sequence}`}
        subtitle={
          contract
            ? `${contract.number ?? contract.name} · period to ${date(application.periodTo)}`
            : `Period to ${date(application.periodTo)}`
        }
      />

      <p className="mb-4 text-sm">
        {/* A plain anchor, not a `Link`: this is a file download, and the client
            router would try to render the response as a page. `download` asks
            the browser to save rather than navigate, and the API's own
            `Content-Disposition` names it after the application. */}
        <a
          href={`/api/applications/${id}/pdf`}
          download
          className="text-(--color-accent) hover:underline"
        >
          Download as PDF
        </a>
        <span className="ms-2 text-(--color-muted)">
          Generated when you ask for it, from the figures on this page.
        </span>
      </p>

      {/* The certificate, once there is one. Reported by durable state rather
          than by the action's message, which is removed along with the form the
          moment the status changes. */}
      {certified != null ? (
        <Card className="mb-6">
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Applied" value={<Money amount={applied} currency={currency} />} />
            <Stat label="Certified" value={<Money amount={certified} currency={currency} />} />
            <Stat
              label="Disallowed"
              value={<Money amount={disallowed} currency={currency} />}
              tone={disallowed != null && disallowed < 0 ? 'bad' : 'neutral'}
              hint={
                disallowed != null && applied !== 0
                  ? `${percent((disallowed / Math.abs(applied)) * 100)} of the application`
                  : undefined
              }
            />
            <Stat label="Certificate" value={application.certificateReference ?? '—'} />
          </div>
          {application.disallowedReason ? (
            <p className="mt-3 border-s-2 border-(--color-line) ps-3 text-sm">
              {application.disallowedReason}
            </p>
          ) : null}
        </Card>
      ) : null}

      {isDraft ? (
        <Card className="mb-6">
          <div className="mb-3">
            <p className="text-sm font-medium">Not yet submitted</p>
            <p className="mt-1 text-sm text-(--color-muted)">
              Submitting sends <Money amount={applied} currency={currency} /> to the client and
              starts the certification clock.
            </p>
          </div>

          {maySubmit ? (
            <ActionForm action={submit.bind(null, id)}>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="submittedOn" className="mb-1 block text-xs text-(--color-muted)">
                    Submitted on
                  </label>
                  <input
                    id="submittedOn"
                    name="submittedOn"
                    type="date"
                    required
                    defaultValue={today}
                    className={field}
                  />
                </div>
                <SubmitButton pendingLabel="Submitting…">Submit to client</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-(--color-muted)">
              You do not have permission to submit a payment application.
            </p>
          )}
        </Card>
      ) : null}

      {isSubmitted ? (
        <Card className="mb-6" title="Record the certificate">
          <p className="mb-3 text-sm text-(--color-muted)">
            Enter what the client actually certified. It is kept beside the application, never
            over it — the difference is the disallowance, and a client who trims every valuation
            is a pattern worth pricing against.
          </p>

          {mayCertify ? (
            <ActionForm action={certify.bind(null, id)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label htmlFor="certifiedNet" className="mb-1 block text-xs text-(--color-muted)">
                    Certified net
                  </label>
                  <input
                    id="certifiedNet"
                    name="certifiedNet"
                    type="number"
                    step="any"
                    required
                    // Defaulted to what was applied for, because most
                    // certificates agree and typing the number again is how a
                    // digit gets dropped.
                    defaultValue={num(application.netThisApplication)}
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="certifiedOn" className="mb-1 block text-xs text-(--color-muted)">
                    Certified on
                  </label>
                  <input
                    id="certifiedOn"
                    name="certifiedOn"
                    type="date"
                    required
                    defaultValue={today}
                    className={field}
                  />
                </div>
                <div>
                  <label
                    htmlFor="certificateReference"
                    className="mb-1 block text-xs text-(--color-muted)"
                  >
                    Certificate reference
                  </label>
                  <input id="certificateReference" name="certificateReference" className={field} />
                </div>
                <div>
                  <label
                    htmlFor="disallowedReason"
                    className="mb-1 block text-xs text-(--color-muted)"
                  >
                    Reason, if reduced
                  </label>
                  <input id="disallowedReason" name="disallowedReason" className={field} />
                </div>
              </div>
              <div className="mt-3">
                <SubmitButton pendingLabel="Recording…">Record certificate</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-(--color-muted)">
              You do not have permission to record a certificate.
            </p>
          )}
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card
          title="Valuation to date"
          footnote="Cumulative. This application is the difference against what was previously certified — not against what was previously applied for, which is how a disallowance gets quietly written off."
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="Work done"
              value={<Money amount={num(application.workDoneToDate)} currency={currency} />}
            />
            <Stat
              label="Variations"
              value={<Money amount={num(application.variationsToDate)} currency={currency} />}
            />
            <Stat
              label="Materials on site"
              value={<Money amount={num(application.materialsOnSite)} currency={currency} />}
            />
            <Stat
              label="Gross"
              value={<Money amount={num(application.grossValuationToDate)} currency={currency} />}
            />
            <Stat
              label="Retention held"
              value={<Money amount={-num(application.retentionHeldToDate)} currency={currency} />}
            />
            <Stat
              label="Net to date"
              value={<Money amount={num(application.netValuationToDate)} currency={currency} />}
            />
          </div>
        </Card>

        <Card title="This application">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="Previously certified"
              value={<Money amount={num(application.previouslyCertifiedNet)} currency={currency} />}
            />
            <Stat
              label="Net this period"
              value={<Money amount={num(application.netThisApplication)} currency={currency} />}
            />
            <Stat
              label="Tax"
              value={<Money amount={num(application.taxAmount)} currency={currency} />}
            />
            <Stat label="Total applied" value={<Money amount={applied} currency={currency} />} />
            <Stat
              label="Status"
              value={<Badge tone={application.status === 'paid' ? 'good' : 'neutral'}>{application.status}</Badge>}
            />
            <Stat label="Due" value={date(application.dueOn)} />
          </div>
        </Card>
      </div>

      <Card title="Measured lines">
        {lines.length === 0 ? (
          <Empty
            title="No measured detail"
            detail="This application was entered as a lump sum rather than measured line by line."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Description</Th>
                <Th numeric>Contract qty</Th>
                <Th numeric>To date</Th>
                <Th numeric>Rate</Th>
                <Th numeric>Value to date</Th>
                <Th numeric>This period</Th>
              </tr>
            }
          >
            {lines.map((line) => (
              <tr key={line.id}>
                <Td>{line.description}</Td>
                <Td numeric>
                  {line.quantityContract == null ? '—' : Number(line.quantityContract)}
                </Td>
                <Td numeric>{Number(line.quantityToDate)}</Td>
                <Td numeric>{Number(line.unitRate)}</Td>
                <Td numeric>
                  <Money amount={num(line.valueToDate)} currency={currency} />
                </Td>
                <Td numeric>
                  <Money amount={num(line.valueThisPeriod)} currency={currency} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {contract ? (
        <p className="mt-4 text-sm">
          <Link href={`/contracts/${contract.id}`} className="text-(--color-accent) hover:underline">
            ← {contract.number ?? contract.name}
          </Link>
        </p>
      ) : null}
    </>
  );
}
