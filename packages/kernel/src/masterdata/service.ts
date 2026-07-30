/**
 * Parties — the shared master data every module was already joining against
 * and nothing could create, list or edit directly.
 *
 * One table with role flags rather than separate customer/supplier tables,
 * per the schema's own reasoning: the same company is routinely a client on
 * one job and a subcontractor on another, and splitting them guarantees
 * duplicate records. `code` is chosen by the caller, not allocated — a
 * supplier code is usually a meaningful abbreviation ("EMAAR", "HAFELE"),
 * not a sequence number, which is why this does not go through
 * `allocateNumber` the way a tender or requisition does.
 */
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { party, partyContact } from '../db/schema';
import { recordAudit } from '../audit/service';
import { listCustomFieldDefinitions, validateCustomFieldValues } from '../customfields/service';
import { listResult, searchPattern, type ListParams, type ListResult } from '../db/list';
import { requireTenantContext } from '../tenancy/context';

const MODULE_KEY = 'kernel';

export class MasterDataError extends Error {
  override readonly name = 'MasterDataError';
}

export type PartyRole = 'customer' | 'supplier' | 'subcontractor' | 'consultant' | 'employee';

const ROLE_COLUMN = {
  customer: party.isCustomer,
  supplier: party.isSupplier,
  subcontractor: party.isSubcontractor,
  consultant: party.isConsultant,
  employee: party.isEmployee,
} as const;

export interface PartyListRow {
  id: string;
  code: string;
  type: string;
  name: string;
  countryCode: string | null;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
  isSubcontractor: boolean;
  isConsultant: boolean;
  isEmployee: boolean;
  isBlocked: boolean;
}

export const PARTY_SORTS = ['code', 'name', 'createdAt'] as const;
export type PartySort = (typeof PARTY_SORTS)[number];

export async function listParties(
  tx: Transaction,
  params: ListParams<PartySort>,
  filters: { role?: PartyRole; includeInactive?: boolean } = {},
): Promise<ListResult<PartyListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(party.tenantId, tenantId)];
  if (!filters.includeInactive) conditions.push(isNull(party.deletedAt));
  if (filters.role) conditions.push(eq(ROLE_COLUMN[filters.role], true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(party.code, pattern), ilike(party.name, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn = { code: party.code, name: party.name, createdAt: party.createdAt }[
    params.sort
  ] ?? party.name;

  const rows = await tx
    .select({
      id: party.id,
      code: party.code,
      type: party.type,
      name: party.name,
      countryCode: party.countryCode,
      email: party.email,
      phone: party.phone,
      isCustomer: party.isCustomer,
      isSupplier: party.isSupplier,
      isSubcontractor: party.isSubcontractor,
      isConsultant: party.isConsultant,
      isEmployee: party.isEmployee,
      isBlocked: party.isBlocked,
    })
    .from(party)
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(party.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(party).where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

export interface PartyContactRow {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export interface PartyDetail {
  party: typeof party.$inferSelect;
  contacts: PartyContactRow[];
}

export async function getPartyDetail(tx: Transaction, partyId: string): Promise<PartyDetail | null> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(party)
    .where(and(eq(party.tenantId, tenantId), eq(party.id, partyId), isNull(party.deletedAt)));
  if (!row) return null;

  const contacts = await tx
    .select({
      id: partyContact.id,
      name: partyContact.name,
      jobTitle: partyContact.jobTitle,
      email: partyContact.email,
      phone: partyContact.phone,
      isPrimary: partyContact.isPrimary,
    })
    .from(partyContact)
    .where(and(eq(partyContact.partyId, partyId), isNull(partyContact.deletedAt)))
    .orderBy(desc(partyContact.isPrimary), asc(partyContact.name));

  return { party: row, contacts };
}

export interface CreatePartyInput {
  code: string;
  name: string;
  type?: 'organisation' | 'individual';
  nativeName?: string | null;
  legalName?: string | null;
  isCustomer?: boolean;
  isSupplier?: boolean;
  isSubcontractor?: boolean;
  isConsultant?: boolean;
  isEmployee?: boolean;
  countryCode?: string | null;
  address?: Record<string, string>;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  taxRegistrationNumber?: string | null;
  currencyCode?: string | null;
  paymentTermDays?: number | null;
  creditLimit?: number | null;
}

export async function createParty(tx: Transaction, input: CreatePartyInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  if (
    !input.isCustomer &&
    !input.isSupplier &&
    !input.isSubcontractor &&
    !input.isConsultant &&
    !input.isEmployee
  ) {
    throw new MasterDataError('A party needs at least one role — customer, supplier, subcontractor, consultant or employee.');
  }

  const [row] = await tx
    .insert(party)
    .values({
      tenantId,
      code: input.code,
      name: input.name,
      type: input.type ?? 'organisation',
      nativeName: input.nativeName,
      legalName: input.legalName,
      isCustomer: input.isCustomer ?? false,
      isSupplier: input.isSupplier ?? false,
      isSubcontractor: input.isSubcontractor ?? false,
      isConsultant: input.isConsultant ?? false,
      isEmployee: input.isEmployee ?? false,
      countryCode: input.countryCode,
      address: input.address ?? {},
      email: input.email,
      phone: input.phone,
      website: input.website,
      taxRegistrationNumber: input.taxRegistrationNumber,
      currencyCode: input.currencyCode,
      paymentTermDays: input.paymentTermDays,
      creditLimit: input.creditLimit == null ? null : String(input.creditLimit),
    })
    .onConflictDoNothing({ target: [party.tenantId, party.code] })
    .returning({ id: party.id });

  if (!row) throw new MasterDataError(`"${input.code}" is already in use.`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.party',
    entityId: row.id,
    entityLabel: `${input.code} — ${input.name}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdatePartyInput {
  name?: string;
  nativeName?: string | null;
  legalName?: string | null;
  isCustomer?: boolean;
  isSupplier?: boolean;
  isSubcontractor?: boolean;
  isConsultant?: boolean;
  isEmployee?: boolean;
  countryCode?: string | null;
  address?: Record<string, string>;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  taxRegistrationNumber?: string | null;
  currencyCode?: string | null;
  paymentTermDays?: number | null;
  creditLimit?: number | null;
  isBlocked?: boolean;
  blockReason?: string | null;
}

export async function updateParty(
  tx: Transaction,
  input: { partyId: string } & UpdatePartyInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(party)
    .where(and(eq(party.tenantId, tenantId), eq(party.id, input.partyId)));
  if (!existing) throw new MasterDataError('Party not found.');

  if (input.isBlocked && !input.blockReason && !existing.blockReason) {
    throw new MasterDataError('Blocking a party needs a reason — it stops every module trading with them.');
  }

  await tx
    .update(party)
    .set({
      name: input.name ?? existing.name,
      nativeName: input.nativeName !== undefined ? input.nativeName : existing.nativeName,
      legalName: input.legalName !== undefined ? input.legalName : existing.legalName,
      isCustomer: input.isCustomer ?? existing.isCustomer,
      isSupplier: input.isSupplier ?? existing.isSupplier,
      isSubcontractor: input.isSubcontractor ?? existing.isSubcontractor,
      isConsultant: input.isConsultant ?? existing.isConsultant,
      isEmployee: input.isEmployee ?? existing.isEmployee,
      countryCode: input.countryCode !== undefined ? input.countryCode : existing.countryCode,
      address: input.address ?? existing.address,
      email: input.email !== undefined ? input.email : existing.email,
      phone: input.phone !== undefined ? input.phone : existing.phone,
      website: input.website !== undefined ? input.website : existing.website,
      taxRegistrationNumber:
        input.taxRegistrationNumber !== undefined
          ? input.taxRegistrationNumber
          : existing.taxRegistrationNumber,
      currencyCode: input.currencyCode !== undefined ? input.currencyCode : existing.currencyCode,
      paymentTermDays: input.paymentTermDays !== undefined ? input.paymentTermDays : existing.paymentTermDays,
      creditLimit:
        input.creditLimit !== undefined
          ? input.creditLimit == null
            ? null
            : String(input.creditLimit)
          : existing.creditLimit,
      isBlocked: input.isBlocked ?? existing.isBlocked,
      blockReason: input.blockReason !== undefined ? input.blockReason : existing.blockReason,
      updatedAt: new Date(),
    })
    .where(eq(party.id, input.partyId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.party',
    entityId: input.partyId,
    entityLabel: `${existing.code} — ${existing.name}`,
    action: 'update',
  });
}

export interface AddPartyContactInput {
  partyId: string;
  name: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export async function addPartyContact(
  tx: Transaction,
  input: AddPartyContactInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: party.id })
    .from(party)
    .where(and(eq(party.tenantId, tenantId), eq(party.id, input.partyId)));
  if (!existing) throw new MasterDataError('Party not found.');

  // At most one primary contact — the second one made primary quietly demotes
  // the first, rather than leaving two contacts both claiming to be it.
  if (input.isPrimary) {
    await tx
      .update(partyContact)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(partyContact.partyId, input.partyId), eq(partyContact.isPrimary, true)));
  }

  const [row] = await tx
    .insert(partyContact)
    .values({
      tenantId,
      partyId: input.partyId,
      name: input.name,
      jobTitle: input.jobTitle,
      email: input.email,
      phone: input.phone,
      isPrimary: input.isPrimary ?? false,
      notes: input.notes,
    })
    .returning({ id: partyContact.id });

  return { id: row!.id };
}

export async function removePartyContact(
  tx: Transaction,
  input: { contactId: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .update(partyContact)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(partyContact.tenantId, tenantId), eq(partyContact.id, input.contactId)))
    .returning({ id: partyContact.id });

  if (!row) throw new MasterDataError('Contact not found.');
}

/**
 * Sets a party's tenant-defined fields, replacing the whole object.
 *
 * Same shape as `setProjectCustomFields` in module-projects — this is the
 * kernel's own copy because `party` is kernel-owned master data, not
 * something any module may write to on the kernel's behalf.
 */
export async function setPartyCustomFields(
  tx: Transaction,
  input: { partyId: string; values: Record<string, unknown> },
): Promise<{ values: Record<string, unknown> }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: party.id })
    .from(party)
    .where(and(eq(party.tenantId, tenantId), eq(party.id, input.partyId)));
  if (!existing) throw new MasterDataError('Party not found.');

  const definitions = await listCustomFieldDefinitions(tx, { entityType: 'party' });
  const { values, errors } = validateCustomFieldValues(definitions, input.values);

  if (errors.length > 0) {
    throw new MasterDataError(errors.map((e) => e.message).join(' '));
  }

  await tx
    .update(party)
    .set({ customFields: values, updatedAt: new Date() })
    .where(eq(party.id, input.partyId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.party',
    entityId: input.partyId,
    action: 'update',
    reason: 'Custom fields updated.',
  });

  return { values };
}
