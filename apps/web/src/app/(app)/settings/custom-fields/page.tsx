import { ActionForm, SubmitButton } from '@/components/Action';
import { FilterChips, listQuery } from '@/components/List';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import { createCustomFieldAction, setCustomFieldActiveAction } from './actions';

interface CustomFieldDefinition {
  id: string;
  entityType: string;
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  isRequired: boolean;
  isSearchable: boolean;
  showInList: boolean;
  options: { value: string; label: string }[];
  section: string | null;
  isActive: boolean;
}

const BASE = '/settings/custom-fields';

const ENTITY_TYPES = [
  { label: 'Projects', value: 'project' },
  { label: 'Parties', value: 'party' },
  { label: 'Items', value: 'item' },
];

const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'select',
  'multiselect',
  'user',
  'party',
  'item',
  'project',
  'document',
  'url',
];

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * The custom field catalogue — what a tenant has added beyond the fields
 * every ERP ships with.
 *
 * Defining a field here is only half the feature: a value is set from the
 * entity's own screen (a project's detail page, for one), using that
 * entity's own write permission, not this one. This page is the schema-ish
 * decision of what exists, which is why it carries its own separate
 * permission — a project editor setting a value and an admin deciding what
 * fields projects even have are different acts.
 */
export default async function CustomFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.custom_fields.manage') || me.user.isOwner;
  const entityType = query.entityType ?? 'project';

  const definitions = await pageFetch<CustomFieldDefinition[]>(
    `/admin/custom-fields?entityType=${entityType}&includeInactive=true`,
  );

  return (
    <>
      <PageHeader
        title="Custom fields"
        subtitle="The tenant-specific fields on parties, items and projects — beyond what the product ships with."
      />

      <div className="mb-4">
        <FilterChips base={BASE} query={{ ...query, entityType }} param="entityType" options={ENTITY_TYPES} />
      </div>

      <Card className="mb-6">
        {definitions.length === 0 ? (
          <Empty
            title="No custom fields yet"
            detail={`Nothing has been defined for ${entityType}s. Add one below.`}
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Field</Th>
                <Th>Type</Th>
                <Th>Required</Th>
                <Th>Status</Th>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {definitions.map((def) => (
              <tr key={def.id}>
                <Td>
                  <span className="block">{def.label}</span>
                  <span className="numeric block text-xs text-(--color-muted)">{def.key}</span>
                  {def.helpText ? (
                    <span className="mt-0.5 block text-xs text-(--color-muted)">{def.helpText}</span>
                  ) : null}
                </Td>
                <Td>
                  {def.type}
                  {def.options.length > 0 ? (
                    <span className="block text-xs text-(--color-muted)">
                      {def.options.map((o) => o.label).join(', ')}
                    </span>
                  ) : null}
                </Td>
                <Td>{def.isRequired ? <Badge tone="neutral">required</Badge> : '—'}</Td>
                <Td>
                  <Badge tone={def.isActive ? 'good' : 'bad'}>
                    {def.isActive ? 'active' : 'retired'}
                  </Badge>
                </Td>
                {mayManage ? (
                  <Td>
                    <ActionForm action={setCustomFieldActiveAction}>
                      <input type="hidden" name="fieldId" value={def.id} />
                      <input type="hidden" name="entityType" value={entityType} />
                      <input type="hidden" name="isActive" value={(!def.isActive).toString()} />
                      <SubmitButton pendingLabel="Saving…">
                        {def.isActive ? 'Retire' : 'Reactivate'}
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {mayManage ? (
        <Card title={`Add a field for ${entityType}s`}>
          <ActionForm action={createCustomFieldAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="entityType" value={entityType} />
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Key</span>
              <input name="key" placeholder="lift_count" className={field} />
              <span className="mt-1 block text-xs text-(--color-muted)">
                Lowercase, letters/numbers/underscores. Cannot change once set.
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Label</span>
              <input name="label" dir="auto" placeholder="Number of lifts" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Type</span>
              <select name="type" className={field} defaultValue="text">
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Required?</span>
              <select name="isRequired" className={field} defaultValue="false">
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">
                Options, comma-separated (only used by select / multiselect)
              </span>
              <input name="options" dir="auto" placeholder="Option A, Option B" className={field} />
            </label>
            <div>
              <SubmitButton pendingLabel="Adding…">Add field</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
