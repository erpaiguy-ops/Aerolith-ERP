/**
 * Module and navigation endpoints.
 *
 * `/me` is where standalone-vs-unified becomes visible: the same binary returns
 * a single-module product to one tenant and the full ERP to another, based on
 * entitlement rows.
 */
import type { FastifyInstance } from 'fastify';

import { authenticate } from '../context';
import { modulesForTenant, navigationFor, registry } from '../bootstrap';

export async function moduleRoutes(app: FastifyInstance) {
  /** Everything this deployment could serve — the module catalogue. */
  app.get('/modules/catalogue', async () => ({
    modules: registry.all().map((module) => ({
      key: module.key,
      name: module.name,
      description: module.description,
      version: module.version,
      category: module.category,
      standalone: module.standalone,
      sellable: module.sellable,
      dependsOn: module.dependsOn,
      integratesWith: module.integratesWith,
    })),
  }));

  /** The signed-in user's world: their tenant's modules, their navigation. */
  app.get('/me', async (request) => {
    const principal = await authenticate(request);
    const modules = await modulesForTenant(principal.context.tenantId);
    const permissions = principal.context.permissions ?? new Set<string>();

    return {
      user: {
        id: principal.userId,
        locale: principal.context.locale,
        timezone: principal.context.timezone,
        isOwner: principal.isOwner,
      },
      tenant: {
        id: principal.context.tenantId,
        countryCode: principal.context.countryCode,
        currencyCode: principal.context.currencyCode,
      },
      modules: modules.ordered.map((m) => ({ key: m.key, name: m.name, version: m.version })),
      // Surfaced rather than swallowed: a tenant entitled to something this
      // deployment cannot serve should be told, not left wondering.
      unavailableModules: modules.skipped,
      navigation: [
        /*
         * Approvals is a KERNEL capability, not a module, so it has no manifest
         * to declare it and `navigationFor` cannot produce it. Every tenant has
         * an inbox regardless of what they bought, which is also why it carries
         * no permission: an approver's authority IS the task assignment.
         *
         * Order 0 puts it above every module. An inbox that sorts below Stock
         * Counts is an inbox nobody opens.
         */
        {
          key: 'kernel.approvals',
          label: 'Approvals',
          icon: 'inbox',
          order: 0,
          children: [
            { key: 'kernel.approvals.inbox', label: 'My Inbox', path: '/approvals', order: 10 },
            {
              key: 'kernel.approvals.submitted',
              label: 'I Requested',
              path: '/approvals/submitted',
              order: 20,
            },
          ],
        },
        /*
         * Also a kernel capability, also unpermissioned for the same reason:
         * a notification is addressed to this user specifically, and nothing
         * a role could grant or withhold changes that. Order 1 keeps it right
         * under the approval inbox — the two are "what is waiting on me",
         * read in the order of how directly each one demands an action.
         */
        {
          key: 'kernel.notifications',
          label: 'Notifications',
          icon: 'bell',
          path: '/notifications',
          order: 1,
        },
        /*
         * Parties are kernel master data every module already joins against —
         * a client, a supplier, a subcontractor — and unlike Approvals and
         * Notifications this DOES need a permission: reading and editing
         * shared reference data is exactly the kind of thing a shop-floor
         * scanner user should not see a menu for.
         */
        ...(principal.isOwner || permissions.has('kernel.master_data.read')
          ? [
              {
                key: 'kernel.master_data.parties',
                label: 'Parties',
                icon: 'building',
                path: '/master-data/parties',
                order: 2,
              },
            ]
          : []),
        ...navigationFor(modules, permissions),
        /*
         * Settings, likewise a kernel capability with no manifest. Last, at a
         * deliberately large order: it is where you go occasionally, not the
         * work.
         *
         * Gated on `kernel.localisation.manage`, unlike Approvals. The reads
         * behind it are open to any authenticated user — nothing here 403s — but
         * the section exists to CHANGE the workspace's rules, and a shop-floor
         * scanner user given a Settings menu they can only read is a menu that
         * teaches them the app has places they should not be.
         */
        ...(() => {
          const may = (key: string) => principal.isOwner || permissions.has(key);
          const children = [
            ...(may('kernel.localisation.manage')
              ? [
                  {
                    key: 'kernel.settings.workspace',
                    label: 'Workspace',
                    path: '/settings',
                    order: 10,
                  },
                  {
                    key: 'kernel.settings.rules',
                    label: 'Rules',
                    path: '/settings/rules',
                    order: 20,
                  },
                ]
              : []),
            // Gated separately. Running the country pack and running the people
            // are different jobs, and a workspace big enough to separate them
            // should not have to grant one to give the other.
            ...(may('kernel.user.read')
              ? [
                  { key: 'kernel.settings.members', label: 'People', path: '/settings/members', order: 30 },
                  { key: 'kernel.settings.roles', label: 'Roles', path: '/settings/roles', order: 40 },
                ]
              : []),
            // Gated separately again: reading who did what is a distinct
            // authority from reading who is allowed to sign in.
            ...(may('kernel.audit.read')
              ? [{ key: 'kernel.settings.audit', label: 'Audit trail', path: '/settings/audit', order: 50 }]
              : []),
            // Deciding what fields parties, items and projects even have is
            // its own authority too — distinct from having one of those
            // records to edit, which is why this is gated separately rather
            // than folded into master data access.
            ...(may('kernel.custom_fields.manage')
              ? [
                  {
                    key: 'kernel.settings.custom_fields',
                    label: 'Custom Fields',
                    path: '/settings/custom-fields',
                    order: 60,
                  },
                ]
              : []),
            // Same authority as blocking a party: kernel master data with no
            // owning module, gated on the manage half of that permission
            // rather than a new one, since deciding what a cost code IS is
            // the same kind of act.
            ...(may('kernel.master_data.manage')
              ? [
                  {
                    key: 'kernel.settings.cost_structure',
                    label: 'Cost Codes',
                    path: '/settings/cost-codes',
                    order: 70,
                  },
                ]
              : []),
          ];

          return children.length > 0
            ? [{ key: 'kernel.settings', label: 'Settings', icon: 'settings', order: 900, children }]
            : [];
        })(),
      ],
      permissions: [...permissions].sort(),
    };
  });
}
