import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import { saveItemCustomFieldsAction, updateItemAction } from './actions';

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

interface ItemDetail {
  item: {
    id: string;
    code: string;
    name: string;
    nativeName: string | null;
    description: string | null;
    type: string;
    lengthMm: string | null;
    widthMm: string | null;
    thicknessMm: string | null;
    hasGrainDirection: boolean;
    finishCode: string | null;
    colourCode: string | null;
    isStocked: boolean;
    isBatchTracked: boolean;
    isSerialTracked: boolean;
    barcode: string | null;
    standardCost: string | null;
    wastagePercent: string;
    isActive: boolean;
    customFields: Record<string, unknown>;
  };
  categoryName: string | null;
  stockUomCode: string | null;
  purchaseUomCode: string | null;
  onHand: string | null;
}

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
        step="any"
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
 * An item, editable — the catalogue row Procurement, Estimating and
 * Production all reference, which until now had no screen of its own beyond
 * the list.
 */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayManage = can(me.permissions, 'inventory.item.write') || me.user.isOwner;

  let detail: ItemDetail;
  try {
    detail = await pageFetch<ItemDetail>(`/inventory/items/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const customFieldDefs = await pageFetch<CustomFieldDefinition[]>(
    '/admin/custom-fields?entityType=item',
  );

  const { item } = detail;

  return (
    <>
      <PageHeader
        title={`${item.code} — ${item.name}`}
        subtitle={[detail.categoryName, item.type.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/inventory/items" className="text-(--color-accent) hover:underline">
          ← All items
        </Link>
        {item.isActive ? null : <Badge tone="bad">discontinued</Badge>}
      </div>

      <Card title="On hand" className="mb-6">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-(--color-muted)">Quantity</dt>
            <dd className="numeric">
              {detail.onHand == null ? (
                <span className="text-(--color-muted)">never stocked</span>
              ) : (
                `${detail.onHand} ${detail.stockUomCode ?? ''}`
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Stock UOM</dt>
            <dd>{detail.stockUomCode ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Purchase UOM</dt>
            <dd>{detail.purchaseUomCode ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Standard cost</dt>
            <dd>
              <Money amount={item.standardCost} currency={me.tenant.currencyCode} />
            </dd>
          </div>
        </dl>
      </Card>

      {mayManage ? (
        <Card title="Details" className="mb-6">
          <ActionForm action={updateItemAction} className="space-y-3">
            <input type="hidden" name="itemId" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                <input name="name" dir="auto" defaultValue={item.name} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Native name</span>
                <input name="nativeName" dir="auto" defaultValue={item.nativeName ?? ''} className={field} />
              </label>
              <label className="block sm:col-span-3">
                <span className="mb-1 block text-xs text-(--color-muted)">Description</span>
                <textarea
                  name="description"
                  dir="auto"
                  rows={2}
                  defaultValue={item.description ?? ''}
                  className={field}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Length (mm)</span>
                <input
                  type="number"
                  step="any"
                  name="lengthMm"
                  defaultValue={item.lengthMm ?? ''}
                  className={`${field} numeric`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Width (mm)</span>
                <input
                  type="number"
                  step="any"
                  name="widthMm"
                  defaultValue={item.widthMm ?? ''}
                  className={`${field} numeric`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Thickness (mm)</span>
                <input
                  type="number"
                  step="any"
                  name="thicknessMm"
                  defaultValue={item.thicknessMm ?? ''}
                  className={`${field} numeric`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Finish code</span>
                <input name="finishCode" defaultValue={item.finishCode ?? ''} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Colour code</span>
                <input name="colourCode" defaultValue={item.colourCode ?? ''} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Barcode</span>
                <input name="barcode" defaultValue={item.barcode ?? ''} className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Standard cost</span>
                <input
                  type="number"
                  step="any"
                  name="standardCost"
                  defaultValue={item.standardCost ?? ''}
                  className={`${field} numeric`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Wastage %</span>
                <input
                  type="number"
                  step="any"
                  name="wastagePercent"
                  defaultValue={item.wastagePercent}
                  className={`${field} numeric`}
                />
              </label>
            </div>
            <fieldset>
              <legend className="mb-1 block text-xs text-(--color-muted)">Tracking</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    name="hasGrainDirection"
                    value="true"
                    defaultChecked={item.hasGrainDirection}
                    className="accent-current"
                  />
                  Has grain direction
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    name="isStocked"
                    value="true"
                    defaultChecked={item.isStocked}
                    className="accent-current"
                  />
                  Stocked
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    name="isBatchTracked"
                    value="true"
                    defaultChecked={item.isBatchTracked}
                    className="accent-current"
                  />
                  Batch tracked
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    name="isSerialTracked"
                    value="true"
                    defaultChecked={item.isSerialTracked}
                    className="accent-current"
                  />
                  Serial tracked
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    name="isActive"
                    value="true"
                    defaultChecked={item.isActive}
                    className="accent-current"
                  />
                  Active
                </label>
              </div>
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </ActionForm>
        </Card>
      ) : (
        <Card title="Details" className="mb-6">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-(--color-muted)">Finish</dt>
              <dd>{item.finishCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">Colour</dt>
              <dd>{item.colourCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">Barcode</dt>
              <dd>{item.barcode ?? '—'}</dd>
            </div>
          </dl>
        </Card>
      )}

      {customFieldDefs.length > 0 ? (
        <Card title="Custom fields">
          <ActionForm action={saveItemCustomFieldsAction} className="space-y-3">
            <input type="hidden" name="itemId" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              {customFieldDefs.map((def) => (
                <label key={def.key} className="block">
                  <span className="mb-1 block text-xs text-(--color-muted)">
                    {def.label}
                    {def.isRequired ? ' *' : ''}
                  </span>
                  {mayManage ? (
                    <CustomFieldInput def={def} value={item.customFields[def.key]} />
                  ) : (
                    <p className="text-sm">
                      {item.customFields[def.key] == null || item.customFields[def.key] === ''
                        ? '—'
                        : String(item.customFields[def.key])}
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
