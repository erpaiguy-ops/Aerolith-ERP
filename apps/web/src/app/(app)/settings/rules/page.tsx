import { ActionForm, SubmitButton } from '@/components/Action';
import { FilterChips, listQuery } from '@/components/List';
import { Badge, Card, Empty, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, apiFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { overrideRuleAction } from '../actions';

interface Rule {
  key: string;
  value: unknown;
  layer: 'tenant' | 'country' | 'default';
  source: string | null;
  domain?: string;
  label?: string;
  description?: string | null;
  valueType?: string;
  defaultValue?: unknown;
  unit?: string | null;
  tenantOverridable?: boolean;
  ownerModule?: string | null;
}

interface RulesResponse {
  countryCode: string;
  asAt: string;
  domains: string[];
  /**
   * Over the WHOLE rule set, not the filtered slice. Computed on the server for
   * the same reason the offcut register's value is: "how much of this
   * workspace's configuration is actually ours" is a question about the
   * workspace, and a figure that silently rescopes when a filter is set is a
   * figure that gets quoted wrongly.
   */
  summary: {
    total: number;
    tenant: number;
    country: number;
    default: number;
    statutory: number;
  };
  rules: Rule[];
}

const BASE = '/settings/rules';

const LAYER_TONE = { tenant: 'good', country: 'neutral', default: 'bad' } as const;

const LAYER_MEANING: Record<string, string> = {
  tenant: 'you set this',
  country: 'from the country pack',
  default: 'nobody has said — the shipped fallback',
};

/** How a value is written into a text input, and read back out of one. */
function toInput(value: unknown, valueType: string | undefined): string {
  if (value === null || value === undefined) return '';
  if (valueType === 'json' || valueType === 'list' || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * The rule set, with the layer each answer came from.
 *
 * The layer is the whole point and the reason this is not a settings form. Three
 * layers resolve every rule — the tenant's own value, then the country pack,
 * then the shipped default — and an administrator's first question about any
 * number in an ERP is not "what is it" but "who decided it". A screen that shows
 * `10%` and not `10% — because the UAE pack says so` is a screen that makes
 * people ring the supplier.
 *
 * `default` is rendered as a warning rather than neutrally. It means no country
 * has an opinion and the software picked something: fine for a preference,
 * worth looking at for anything that ends up on an invoice.
 *
 * Statutory rules are shown and locked. Hiding them would be worse — an admin
 * who cannot find the retention rule assumes it is missing, not that it is
 * fixed by law — so they appear with the reason they cannot be changed.
 */
export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.localisation.manage') || me.user.isOwner;

  let data: RulesResponse;
  try {
    data = await apiFetch<RulesResponse>(
      `/localisation/rules${query.domain ? `?domain=${encodeURIComponent(query.domain)}` : ''}`,
    );
  } catch (error) {
    // 409, not 404: the endpoint exists and the tenant has not adopted a country
    // yet. That is a thing to go and do, not an error page.
    if (error instanceof ApiError && error.status === 409) {
      return (
        <>
          <PageHeader title="Rules" subtitle="Every configurable number, and who decided it." />
          <Empty
            title="No country adopted yet"
            detail="Rules resolve through the country pack, so there is nothing to resolve until this workspace has adopted one. Do that on the Workspace page."
          />
        </>
      );
    }
    throw error;
  }

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader
        title="Rules"
        subtitle={`Every configurable number in the system, resolved for ${data.countryCode} — and who decided each one.`}
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Set by you"
            value={integer(data.summary.tenant)}
            tone="good"
            hint={`of ${integer(data.summary.total)} rules`}
          />
          <Stat
            label="From the country pack"
            value={integer(data.summary.country)}
            hint={`pack for ${data.countryCode}`}
          />
          <Stat
            label="Shipped default"
            value={integer(data.summary.default)}
            tone={data.summary.default > 0 ? 'bad' : 'neutral'}
            hint="no country has an opinion"
          />
          <Stat
            label="Statutory"
            value={integer(data.summary.statutory)}
            hint="cannot be overridden"
          />
        </div>
      </Card>

      <div className="mb-4">
        <FilterChips
          base={BASE}
          query={query}
          param="domain"
          options={[
            { label: 'All', value: null },
            ...data.domains.map((domain) => ({ label: domain, value: domain })),
          ]}
        />
      </div>

      <Card>
        {data.rules.length === 0 ? (
          <Empty title="No rules in this domain" detail="Clear the filter to see everything." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Rule</Th>
                <Th numeric>Value</Th>
                <Th>Decided by</Th>
                {mayManage ? <Th>Override</Th> : null}
              </tr>
            }
          >
            {data.rules.map((rule) => {
              const editable = mayManage && rule.tenantOverridable !== false;
              return (
                <tr key={rule.key} className="align-top">
                  <Td>
                    <span className="block">{rule.label ?? rule.key}</span>
                    {/* The key, always. It is what appears in an API call, a
                        support question and this repository's source, and an
                        admin who can only see the prose label cannot ask about
                        it precisely. */}
                    <span className="numeric block text-xs text-(--color-muted)">{rule.key}</span>
                    {rule.description ? (
                      <span className="mt-0.5 block max-w-md text-xs text-(--color-muted)">
                        {rule.description}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    {/* Capped and breakable. A `json` rule serialises to one long
                        token with no break opportunity — the retention release
                        schedule, the mandatory-invoice-field list — and an
                        unconstrained cell stretches the column to fit it,
                        which pushed this table to 2,240px and left the override
                        form off the side of the screen. */}
                    <span className="numeric inline-block max-w-[14rem] break-all">
                      {toInput(rule.value, rule.valueType)}
                      {rule.unit ? (
                        <span className="ms-1 text-xs text-(--color-muted)">{rule.unit}</span>
                      ) : null}
                    </span>
                    {rule.layer === 'tenant' ? (
                      // What it would fall back to. An admin undoing an override
                      // needs to know what they are undoing it to.
                      <span className="block text-xs text-(--color-muted)">
                        {`default ${toInput(rule.defaultValue, rule.valueType)}`}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={LAYER_TONE[rule.layer] ?? 'neutral'}>{rule.layer}</Badge>
                    <span className="mt-0.5 block text-xs text-(--color-muted)">
                      {rule.source ?? LAYER_MEANING[rule.layer]}
                    </span>
                  </Td>
                  {mayManage ? (
                    <Td>
                      {editable ? (
                        <ActionForm action={overrideRuleAction} className="flex items-start gap-2">
                          <input type="hidden" name="key" value={rule.key} />
                          <input type="hidden" name="valueType" value={rule.valueType ?? 'string'} />
                          {rule.valueType === 'boolean' ? (
                            <select
                              name="value"
                              className={`${field} w-24`}
                              defaultValue={String(rule.value)}
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : (
                            <input
                              name="value"
                              dir="auto"
                              defaultValue={toInput(rule.value, rule.valueType)}
                              className={`${field} w-32`}
                            />
                          )}
                          <input
                            name="reason"
                            dir="auto"
                            placeholder="Why…"
                            className={`${field} w-32`}
                          />
                          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
                        </ActionForm>
                      ) : (
                        <span className="text-xs text-(--color-muted)">
                          Statutory — fixed by law, not by preference.
                        </span>
                      )}
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
