/**
 * Module manifests — the mechanism behind requirement 19.
 *
 * A manifest is a module's entire public face: what it depends on, what it
 * emits, what it consumes, what permissions it defines, and whether it can be
 * sold on its own. The registry uses it to boot exactly the modules a tenant is
 * entitled to, from one binary.
 *
 * `dependsOn` is hard — the module cannot start without it. `integratesWith` is
 * soft — the module runs happily alone and simply lights up extra behaviour when
 * the other module is present. That distinction is what makes standalone
 * products possible; see docs/02-architecture.md.
 */
import { z } from 'zod';

export const moduleCategorySchema = z.enum([
  'core',
  'operations',
  'commercial',
  'financial',
  'people',
  'platform',
]);

export const permissionDeclarationSchema = z.object({
  key: z.string().min(1),
  resource: z.string().min(1),
  action: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  isDangerous: z.boolean().default(false),
});

export type NavItem = {
  key: string;
  label: string;
  icon?: string;
  path?: string;
  permission?: string;
  order: number;
  children?: NavItem[];
};

/** `order` is optional on the way in and defaulted on the way out. */
export type NavItemInput = Omit<NavItem, 'order' | 'children'> & {
  order?: number;
  children?: NavItemInput[];
};

export const navItemSchema: z.ZodType<NavItem, z.ZodTypeDef, NavItemInput> = z.lazy(() =>
  z.object({
    key: z.string(),
    label: z.string(),
    icon: z.string().optional(),
    path: z.string().optional(),
    permission: z.string().optional(),
    order: z.number().default(100),
    children: z.array(navItemSchema).optional(),
  }),
);

export const eventDeclarationSchema = z.object({
  type: z.string().min(1),
  version: z.number().int().positive().default(1),
  description: z.string().optional(),
  /** Zod-describable payload shape, published for consumers. */
  payloadSchema: z.custom<z.ZodTypeAny>().optional(),
});

/**
 * Country-variable settings this module owns. Registered into
 * `kernel.rule_definition` at boot, which is how a module adds localisation
 * knobs without the kernel knowing anything about the module.
 */
export const ruleDeclarationSchema = z.object({
  key: z.string().min(1),
  domain: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  valueType: z.enum([
    'boolean',
    'number',
    'percent',
    'money',
    'string',
    'enum',
    'date',
    'duration',
    'json',
  ]),
  defaultValue: z.unknown().optional(),
  unit: z.string().optional(),
  tenantOverridable: z.boolean().default(true),
});

export const moduleManifestSchema = z.object({
  key: z
    .string()
    .min(2)
    .regex(/^[a-z][a-z0-9-]*$/, 'Module keys are lowercase kebab-case.'),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: moduleCategorySchema,

  /** Postgres schema this module owns. Exactly one, and only it may write there. */
  dbSchema: z.string().regex(/^[a-z][a-z0-9_]*$/),

  dependsOn: z.array(z.string()).default([]),
  integratesWith: z.array(z.string()).default([]),

  /** False for modules that only make sense inside the full ERP. */
  standalone: z.boolean().default(false),
  /** Shown in the module marketplace / entitlement UI. */
  sellable: z.boolean().default(true),

  permissions: z.array(permissionDeclarationSchema).default([]),
  nav: z.array(navItemSchema).default([]),
  events: z
    .object({
      emits: z.array(eventDeclarationSchema).default([]),
      consumes: z.array(z.string()).default([]),
    })
    .default({ emits: [], consumes: [] }),
  rules: z.array(ruleDeclarationSchema).default([]),
  /** Entity types this module registers with the approval engine. */
  approvableEntities: z.array(z.string()).default([]),
  /** Numbering series this module needs, created per tenant on enable. */
  numberSeries: z
    .array(z.object({ entityType: z.string(), code: z.string(), pattern: z.string() }))
    .default([]),
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type PermissionDeclaration = z.infer<typeof permissionDeclarationSchema>;
export type RuleDeclaration = z.infer<typeof ruleDeclarationSchema>;

/** Validates at author time; a malformed manifest fails the build, not runtime. */
export function defineModule(manifest: z.input<typeof moduleManifestSchema>): ModuleManifest {
  const parsed = moduleManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(
      `Invalid module manifest for "${String(manifest.key)}":\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  const seen = new Set<string>();
  for (const permission of parsed.data.permissions) {
    if (seen.has(permission.key)) {
      throw new Error(`Duplicate permission "${permission.key}" in module "${parsed.data.key}".`);
    }
    seen.add(permission.key);
    if (!permission.key.startsWith(`${parsed.data.key}.`)) {
      throw new Error(
        `Permission "${permission.key}" must be namespaced under "${parsed.data.key}.".`,
      );
    }
  }

  for (const event of parsed.data.events.emits) {
    if (!event.type.startsWith(`${parsed.data.key}.`)) {
      throw new Error(
        `Event "${event.type}" must be namespaced under "${parsed.data.key}." so consumers ` +
          'can tell who owns it.',
      );
    }
  }

  return parsed.data;
}
