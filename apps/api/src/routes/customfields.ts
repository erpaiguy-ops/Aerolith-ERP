/**
 * Custom field definitions — the catalogue admins manage.
 *
 * Setting a VALUE on a party, item or project uses that entity's own
 * permission (`kernel.master_data.manage`, `projects.project.write`, ...) and
 * lives in each module's own routes, next to the rest of that entity's
 * writes. This file is only the catalogue: what fields exist for an entity
 * type, gated on its own permission because defining a field is a schema-ish
 * decision, not a record edit.
 */
import {
  CustomFieldError,
  createCustomFieldDefinition,
  listCustomFieldDefinitions,
  schema,
  updateCustomFieldDefinition,
  withTenant,
} from '@aerolith/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';

const CUSTOM_FIELD_TYPES = schema.customFieldType.enumValues;

const optionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  colour: z.string().optional(),
});

const createBody = z.object({
  entityType: z.enum(['party', 'item', 'project']),
  key: z.string().min(1).max(64),
  label: z.string().min(1),
  labelNative: z.string().nullish(),
  helpText: z.string().nullish(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  isRequired: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  showInList: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(optionSchema).optional(),
  validation: z.record(z.unknown()).optional(),
  section: z.string().nullish(),
  sortOrder: z.number().int().optional(),
});

const updateBody = z.object({
  label: z.string().min(1).optional(),
  labelNative: z.string().nullish(),
  helpText: z.string().nullish(),
  isRequired: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  showInList: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(optionSchema).optional(),
  validation: z.record(z.unknown()).optional(),
  section: z.string().nullish(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function customFieldRoutes(app: FastifyInstance) {
  /**
   * Read is open to anyone signed in, not gated on `kernel.custom_fields.manage`:
   * a screen rendering a project's edit form needs to know what fields exist
   * for `project` to draw them, and that is a much larger audience than the
   * admins who may add or retire one.
   */
  app.get<{ Querystring: { entityType?: string; includeInactive?: string } }>(
    '/admin/custom-fields',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!request.query.entityType) {
        return reply.code(400).send({ error: 'entityType is required.' });
      }

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listCustomFieldDefinitions(tx, {
            entityType: request.query.entityType!,
            includeInactive: request.query.includeInactive === 'true',
          }),
        ),
      );
    },
  );

  app.post('/admin/custom-fields', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.custom_fields.manage');

    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      const created = await withPrincipal(principal, () =>
        withTenant((tx) => createCustomFieldDefinition(tx, parsed.data)),
      );
      return created;
    } catch (error) {
      if (error instanceof CustomFieldError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/custom-fields/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.custom_fields.manage');

    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateCustomFieldDefinition(tx, { id: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof CustomFieldError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    return { updated: true };
  });
}
