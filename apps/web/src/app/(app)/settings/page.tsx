import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { integer, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

import { adoptCountryAction } from './actions';

interface Country {
  code: string;
  name: string;
  nativeName: string | null;
  currencyCode: string;
  packVersion: string;
  adminDivisionLabel: string | null;
}

interface Requirement {
  id: string;
  code: string;
  name: string;
  nativeName: string | null;
  subject: string;
  category: string;
  isMandatory: boolean;
  hasExpiry: boolean;
  expiryNoticeDays: number[] | null;
  blocksOnboarding: boolean;
  blocksSiteAccess: boolean;
  issuingAuthority: string | null;
  isCustomised: boolean;
  isUserDefined: boolean;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate: string;
  regimeCode: string | null;
  applicability: string;
  isRecoverable: boolean;
  isReverseCharge: boolean;
  isDefault: boolean;
  isCustomised: boolean;
}

/**
 * The workspace: which country this tenant runs under, and what adopting it
 * produced.
 *
 * The README's second sentence is that country specifics are data rather than
 * code. Until now that was true of the schema and invisible in the product —
 * `POST /localisation/adopt` had no caller, so a new tenant could not be
 * configured through the application at all. This is where the claim becomes
 * something a person can do.
 *
 * Adoption COPIES the country's requirements, tax codes and holidays into the
 * tenant's own tables. That is the whole design: the copy is editable, so a
 * company with a rule its country does not have adds it here rather than waiting
 * for a release, and a company that disagrees with a default changes it without
 * affecting anybody else on the same pack.
 */
export default async function SettingsPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.localisation.manage') || me.user.isOwner;
  const adopted = Boolean(me.tenant.countryCode);

  // Requirements and tax codes only exist once a country has been adopted, and
  // asking for them before that returns empty lists rather than an error — so
  // they are fetched together and the page decides what to show.
  const [countries, requirements, taxCodes] = await Promise.all([
    pageFetch<{ countries: Country[] }>('/localisation/countries'),
    pageFetch<{ requirements: Requirement[] }>('/localisation/requirements'),
    pageFetch<{ taxCodes: TaxCode[] }>('/localisation/tax-codes'),
  ]);

  const current = countries.countries.find((c) => c.code === me.tenant.countryCode);
  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  const bySubject = new Map<string, Requirement[]>();
  for (const requirement of requirements.requirements) {
    const list = bySubject.get(requirement.subject) ?? [];
    list.push(requirement);
    bySubject.set(requirement.subject, list);
  }

  return (
    <>
      <PageHeader
        title="Workspace"
        subtitle="The country this business runs under, and everything adopting it filled in."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Country"
            value={current ? `${current.name} (${current.code})` : 'Not adopted'}
            tone={adopted ? 'neutral' : 'bad'}
            hint={current?.nativeName ?? undefined}
          />
          <Stat label="Currency" value={me.tenant.currencyCode ?? '—'} />
          <Stat
            label="Requirements"
            value={integer(requirements.requirements.length)}
            hint={adopted ? 'yours to edit' : undefined}
          />
          <Stat label="Tax codes" value={integer(taxCodes.taxCodes.length)} />
        </div>
      </Card>

      {mayManage ? (
        <Card title={adopted ? 'Change or refresh the country pack' : 'Adopt a country'} className="mb-4">
          {adopted ? (
            <p className="mb-3 text-sm text-(--color-muted)">
              {/* Said before the button, not after. Refreshing is the one action
                  here that can undo somebody's work. */}
              This workspace already runs under {current?.name ?? me.tenant.countryCode}. Refreshing
              re-copies from the country pack and <strong>overwrites requirements and tax codes you
              have edited</strong>. Rule overrides you have set are not touched.
            </p>
          ) : (
            <p className="mb-3 text-sm text-(--color-muted)">
              Adopting copies the country&rsquo;s requirements, tax codes and holidays into this
              workspace as your own editable copy. Nothing here is shared with other workspaces
              afterwards.
            </p>
          )}

          <ActionForm action={adoptCountryAction}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="countryCode" className="mb-1 block text-xs text-(--color-muted)">
                  Country
                </label>
                <select
                  id="countryCode"
                  name="countryCode"
                  className={field}
                  defaultValue={me.tenant.countryCode ?? ''}
                >
                  <option value="" disabled>
                    Choose a country…
                  </option>
                  {countries.countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {`${country.name} — ${country.currencyCode} · pack ${country.packVersion}`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="currencyCode" className="mb-1 block text-xs text-(--color-muted)">
                  Currency (optional)
                </label>
                <input
                  id="currencyCode"
                  name="currencyCode"
                  maxLength={3}
                  placeholder={current?.currencyCode ?? 'AED'}
                  className={`${field} uppercase`}
                />
              </div>

              <div>
                <label htmlFor="timezone" className="mb-1 block text-xs text-(--color-muted)">
                  Timezone (optional)
                </label>
                <input id="timezone" name="timezone" placeholder="Asia/Dubai" className={field} />
              </div>

              <div>
                <label
                  htmlFor="taxRegistrationNumber"
                  className="mb-1 block text-xs text-(--color-muted)"
                >
                  Tax registration number
                </label>
                <input id="taxRegistrationNumber" name="taxRegistrationNumber" className={field} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SubmitButton pendingLabel="Adopting…">
                {adopted ? 'Adopt this country' : 'Adopt'}
              </SubmitButton>
              {adopted ? (
                <label className="flex items-center gap-2 text-sm text-(--color-muted)">
                  <input type="checkbox" name="refresh" value="true" />
                  Re-copy from the pack, overwriting my edits
                </label>
              ) : null}
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {!adopted ? (
        <Empty
          title="Nothing configured yet"
          detail="Adopt a country and this workspace gets its requirement set, its tax codes and its statutory rules."
        />
      ) : (
        <>
          <Card title="Tax codes" className="mb-4" footnote="Copied from the country pack. Editable per workspace.">
            <Table
              head={
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th numeric>Rate</Th>
                  <Th>Applies to</Th>
                  <Th>Notes</Th>
                </tr>
              }
            >
              {taxCodes.taxCodes.map((code) => (
                <tr key={code.id}>
                  <Td>
                    <span className="numeric">{code.code}</span>
                    {code.isDefault ? (
                      <span className="ms-2">
                        <Badge tone="neutral">default</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>{code.name}</Td>
                  <Td numeric>{percent(code.rate)}</Td>
                  <Td>{code.applicability}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {code.isReverseCharge ? <Badge tone="neutral">reverse charge</Badge> : null}
                      {!code.isRecoverable ? <Badge tone="bad">not recoverable</Badge> : null}
                      {code.isCustomised ? <Badge tone="good">edited</Badge> : null}
                    </span>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card
            title="Requirements"
            footnote="What this country expects a person, a company or a site to hold. Grouped by who it applies to."
          >
            {[...bySubject.entries()].map(([subject, list]) => (
              <div key={subject} className="mb-6 last:mb-0">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-(--color-muted)">
                  {`${subject} · ${integer(list.length)}`}
                </h3>
                <Table
                  head={
                    <tr>
                      <Th>Code</Th>
                      <Th>Requirement</Th>
                      <Th>Category</Th>
                      <Th>Expiry</Th>
                      <Th>Blocks</Th>
                    </tr>
                  }
                >
                  {list.map((requirement) => (
                    <tr key={requirement.id}>
                      <Td>
                        <span className="numeric">{requirement.code}</span>
                      </Td>
                      <Td>
                        <span className="block">{requirement.name}</span>
                        {requirement.issuingAuthority ? (
                          <span className="block text-xs text-(--color-muted)">
                            {requirement.issuingAuthority}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{requirement.category}</Td>
                      <Td>
                        {/* The notice days are the point of tracking expiry at
                            all: a visa that expires in 30 days is a problem
                            today, not on the day it lapses. */}
                        {requirement.hasExpiry ? (
                          <span className="numeric text-xs">
                            {(requirement.expiryNoticeDays ?? []).length > 0
                              ? `warn at ${(requirement.expiryNoticeDays ?? []).join(', ')} days`
                              : 'tracked'}
                          </span>
                        ) : (
                          <span className="text-(--color-muted)">—</span>
                        )}
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {requirement.isMandatory ? <Badge tone="bad">mandatory</Badge> : null}
                          {requirement.blocksOnboarding ? <Badge tone="neutral">joining</Badge> : null}
                          {requirement.blocksSiteAccess ? <Badge tone="neutral">site access</Badge> : null}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </Card>
        </>
      )}
    </>
  );
}
