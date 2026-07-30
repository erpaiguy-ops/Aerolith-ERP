import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import {
  addContactAction,
  removeContactAction,
  saveCustomFieldsAction,
  setBlockedAction,
  updatePartyAction,
} from './actions';

interface CustomFieldOption {
  value: string;
  label: string;
}

interface CustomFieldDefinition {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  isRequired: boolean;
  options: CustomFieldOption[];
}

interface PartyContact {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

interface PartyDetail {
  party: {
    id: string;
    code: string;
    name: string;
    countryCode: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    taxRegistrationNumber: string | null;
    isCustomer: boolean;
    isSupplier: boolean;
    isSubcontractor: boolean;
    isConsultant: boolean;
    isEmployee: boolean;
    isBlocked: boolean;
    blockReason: string | null;
    customFields: Record<string, unknown>;
  };
  contacts: PartyContact[];
}

const ROLE_LABEL: Record<string, string> = {
  isCustomer: 'customer',
  isSupplier: 'supplier',
  isSubcontractor: 'subcontractor',
  isConsultant: 'consultant',
  isEmployee: 'employee',
};

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1.5 text-sm outline-none focus:border-(--color-accent)';

/** One editable cell for a custom field, shaped by its declared type. */
function CustomFieldInput({ def, value }: { def: CustomFieldDefinition; value: unknown }) {
  if (def.type === 'boolean') {
    return (
      <select name={def.key} defaultValue={value === true ? 'true' : 'false'} className={field}>
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>
    );
  }
  if (def.type === 'select') {
    return (
      <select name={def.key} defaultValue={typeof value === 'string' ? value : ''} className={field}>
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'textarea') {
    return (
      <textarea
        name={def.key}
        dir="auto"
        defaultValue={typeof value === 'string' ? value : ''}
        className={field}
        rows={2}
      />
    );
  }
  if (def.type === 'number' || def.type === 'decimal') {
    return (
      <input
        type="number"
        name={def.key}
        defaultValue={typeof value === 'number' || typeof value === 'string' ? value : ''}
        className={`${field} numeric`}
      />
    );
  }
  if (def.type === 'date' || def.type === 'datetime') {
    return (
      <input
        type={def.type === 'date' ? 'date' : 'datetime-local'}
        name={def.key}
        defaultValue={typeof value === 'string' ? value : ''}
        className={field}
      />
    );
  }
  if (def.type === 'multiselect') {
    return (
      <input
        name={def.key}
        dir="auto"
        placeholder="Comma-separated"
        defaultValue={Array.isArray(value) ? value.join(', ') : ''}
        className={field}
      />
    );
  }
  return (
    <input name={def.key} dir="auto" defaultValue={typeof value === 'string' ? value : ''} className={field} />
  );
}

/**
 * A party, editable — the record every module's "who is this for/from" field
 * ultimately points at.
 */
export default async function PartyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.master_data.manage') || me.user.isOwner;

  let detail: PartyDetail;
  try {
    detail = await pageFetch<PartyDetail>(`/master-data/parties/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const customFieldDefs = await pageFetch<CustomFieldDefinition[]>(
    '/admin/custom-fields?entityType=party',
  );

  const { party } = detail;
  const roles = (Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]).filter(
    (key) => party[key as keyof typeof party],
  );

  return (
    <>
      <PageHeader
        title={`${party.code} — ${party.name}`}
        subtitle={roles.map((r) => ROLE_LABEL[r]).join(' · ') || 'No role set'}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/master-data/parties" className="text-(--color-accent) hover:underline">
          ← All parties
        </Link>
        {party.isBlocked ? <Badge tone="bad">blocked</Badge> : null}
      </div>

      {mayManage ? (
        <Card title="Details" className="mb-6">
          <ActionForm action={updatePartyAction} className="space-y-3">
            <input type="hidden" name="partyId" value={party.id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                <input name="name" dir="auto" defaultValue={party.name} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Country</span>
                <input
                  name="countryCode"
                  maxLength={2}
                  defaultValue={party.countryCode ?? ''}
                  className={field}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Email</span>
                <input name="email" type="email" defaultValue={party.email ?? ''} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Phone</span>
                <input name="phone" defaultValue={party.phone ?? ''} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Website</span>
                <input name="website" defaultValue={party.website ?? ''} className={field} />
              </label>
              <label className="block sm:col-span-3">
                <span className="mb-1 block text-xs text-(--color-muted)">Tax registration number</span>
                <input
                  name="taxRegistrationNumber"
                  className={field}
                  defaultValue={party.taxRegistrationNumber ?? ''}
                />
              </label>
            </div>
            <fieldset>
              <legend className="mb-1 block text-xs text-(--color-muted)">Roles</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                {Object.entries(ROLE_LABEL).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      name={key}
                      value="true"
                      defaultChecked={Boolean(party[key as keyof typeof party])}
                      className="accent-current"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </ActionForm>
        </Card>
      ) : (
        <Card title="Details" className="mb-6">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-(--color-muted)">Country</dt>
              <dd>{party.countryCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">Email</dt>
              <dd>{party.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">Phone</dt>
              <dd>{party.phone ?? '—'}</dd>
            </div>
          </dl>
        </Card>
      )}

      {mayManage ? (
        <Card title="Trading status" className="mb-6">
          {party.isBlocked ? (
            <div>
              <p className="mb-2 text-sm text-(--color-bad)">{party.blockReason}</p>
              <ActionForm action={setBlockedAction}>
                <input type="hidden" name="partyId" value={party.id} />
                <input type="hidden" name="isBlocked" value="false" />
                <SubmitButton pendingLabel="Saving…">Unblock</SubmitButton>
              </ActionForm>
            </div>
          ) : (
            <ActionForm action={setBlockedAction} className="flex items-end gap-2">
              <input type="hidden" name="partyId" value={party.id} />
              <input type="hidden" name="isBlocked" value="true" />
              <label className="flex-1">
                <span className="mb-1 block text-xs text-(--color-muted)">
                  Block this party — stops every module trading with them
                </span>
                <input name="blockReason" dir="auto" placeholder="Why…" className={field} />
              </label>
              <SubmitButton tone="danger" pendingLabel="Blocking…">
                Block
              </SubmitButton>
            </ActionForm>
          )}
        </Card>
      ) : null}

      <Card title="Contacts" className="mb-6">
        {detail.contacts.length === 0 ? (
          <p className="mb-3 text-sm text-(--color-muted)">No contacts yet.</p>
        ) : (
          <div className="mb-4 divide-y divide-(--color-line)">
            {detail.contacts.map((contact) => (
              <div key={contact.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <span className="block text-sm">
                    {contact.name}
                    {contact.isPrimary ? (
                      <span className="ms-2">
                        <Badge tone="good">primary</Badge>
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-(--color-muted)">
                    {[contact.jobTitle, contact.email, contact.phone].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {mayManage ? (
                  <ActionForm action={removeContactAction}>
                    <input type="hidden" name="partyId" value={party.id} />
                    <input type="hidden" name="contactId" value={contact.id} />
                    <SubmitButton pendingLabel="Removing…">Remove</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {mayManage ? (
          <ActionForm action={addContactAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="partyId" value={party.id} />
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Job title</span>
              <input name="jobTitle" dir="auto" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Email</span>
              <input name="email" type="email" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Phone</span>
              <input name="phone" className={field} />
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="isPrimary" value="true" className="accent-current" />
              Primary contact
            </label>
            <div>
              <SubmitButton pendingLabel="Adding…">Add contact</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>

      {customFieldDefs.length > 0 ? (
        <Card title="Custom fields">
          <ActionForm action={saveCustomFieldsAction} className="space-y-3">
            <input type="hidden" name="partyId" value={party.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              {customFieldDefs.map((def) => (
                <label key={def.key} className="block">
                  <span className="mb-1 block text-xs text-(--color-muted)">
                    {def.label}
                    {def.isRequired ? ' *' : ''}
                  </span>
                  {mayManage ? (
                    <CustomFieldInput def={def} value={party.customFields[def.key]} />
                  ) : (
                    <p className="text-sm">
                      {party.customFields[def.key] == null || party.customFields[def.key] === ''
                        ? '—'
                        : String(party.customFields[def.key])}
                    </p>
                  )}
                  {def.helpText ? (
                    <span className="mt-1 block text-xs text-(--color-muted)">{def.helpText}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {mayManage ? <SubmitButton pendingLabel="Saving…">Save</SubmitButton> : null}
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
