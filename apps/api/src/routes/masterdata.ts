/**
 * Parties — the shared master data every module already joins against.
 *
 * Kernel-owned, like Approvals and Notifications: no module manifest
 * declares this, because every module that trades with a client or a
 * supplier needs it regardless of which modules a tenant has bought.
 */
import {
  MasterDataError,
  PARTY_SORTS,
  addPartyContact,
  createParty,
  getPartyDetail,
  listParties,
  parseListParams,
  removePartyContact,
  setPartyCustomFields,
  updateParty,
  withTenant,
  type PartyRole,
} from '@aerolith/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';

const ROLES = new Set(['customer', 'supplier', 'subcontractor', 'consultant', 'employee']);

const createBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1),
  type: z.enum(['organisation', 'individual']).optional(),
  nativeName: z.string().nullish(),
  legalName: z.string().nullish(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isSubcontractor: z.boolean().optional(),
  isConsultant: z.boolean().optional(),
  isEmployee: z.boolean().optional(),
  countryCode: z.string().length(2).nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().nullish(),
  website: z.string().nullish(),
  taxRegistrationNumber: z.string().nullish(),
  currencyCode: z.string().length(3).nullish(),
  paymentTermDays: z.number().int().nullish(),
  creditLimit: z.number().nullish(),
});

const updateBody = createBody
  .omit({ code: true })
  .partial()
  .extend({
    isBlocked: z.boolean().optional(),
    blockReason: z.string().nullish(),
  });

const contactBody = z.object({
  name: z.string().min(1),
  jobTitle: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().nullish(),
  isPrimary: z.boolean().optional(),
  notes: z.string().nullish(),
});

export async function masterDataRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { page?: string; pageSize?: string; sort?: string; direction?: string; q?: string; role?: string; includeInactive?: string } }>(
    '/master-data/parties',
    async (request) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.master_data.read');

      const role =
        request.query.role && ROLES.has(request.query.role)
          ? (request.query.role as PartyRole)
          : undefined;

      const params = parseListParams(request.query, {
        sortable: PARTY_SORTS,
        defaultSort: 'name',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listParties(tx, params, {
            role,
            includeInactive: request.query.includeInactive === 'true',
          }),
        ),
      );
    },
  );

  app.post('/master-data/parties', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.master_data.manage');

    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createParty(tx, { ...parsed.data, email: parsed.data.email || null }),
        ),
      );
    } catch (error) {
      if (error instanceof MasterDataError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/master-data/parties/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.master_data.read');

    const detail = await withPrincipal(principal, () =>
      withTenant((tx) => getPartyDetail(tx, request.params.id)),
    );

    if (!detail) return reply.code(404).send({ error: 'Party not found.' });
    return detail;
  });

  app.patch<{ Params: { id: string } }>('/master-data/parties/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.master_data.manage');

    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          updateParty(tx, {
            partyId: request.params.id,
            ...parsed.data,
            email: parsed.data.email === '' ? null : parsed.data.email,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof MasterDataError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    return { updated: true };
  });

  app.post<{ Params: { id: string } }>(
    '/master-data/parties/:id/contacts',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.master_data.manage');

      const parsed = contactBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            addPartyContact(tx, {
              partyId: request.params.id,
              ...parsed.data,
              email: parsed.data.email || null,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof MasterDataError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/master-data/parties/:id/custom-fields',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.master_data.manage');

      const parsed = z.record(z.unknown()).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            setPartyCustomFields(tx, { partyId: request.params.id, values: parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof MasterDataError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string; contactId: string } }>(
    '/master-data/parties/:id/contacts/:contactId/remove',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.master_data.manage');

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) => removePartyContact(tx, { contactId: request.params.contactId })),
        );
      } catch (error) {
        if (error instanceof MasterDataError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }

      return { removed: true };
    },
  );
}
