/**
 * Permissions the kernel itself owns.
 *
 * Modules declare their own in their manifest; these are the platform-level
 * ones that exist regardless of which modules a tenant has bought.
 */
import { type PermissionDeclaration } from '../modules/manifest';

export const KERNEL_MODULE_KEY = 'kernel';

export const KERNEL_PERMISSIONS: PermissionDeclaration[] = [
  {
    key: 'kernel.localisation.read',
    resource: 'localisation',
    action: 'read',
    label: 'View country settings',
    category: 'Settings',
    isDangerous: false,
  },
  {
    key: 'kernel.localisation.manage',
    resource: 'localisation',
    action: 'manage',
    label: 'Manage country settings',
    description:
      'Adopt countries and override rules. Changes payroll and tax behaviour for the ' +
      'whole tenant.',
    category: 'Settings',
    isDangerous: true,
  },
  {
    key: 'kernel.user.read',
    resource: 'user',
    action: 'read',
    label: 'View users',
    category: 'Administration',
    isDangerous: false,
  },
  {
    key: 'kernel.user.manage',
    resource: 'user',
    action: 'manage',
    label: 'Manage users and invitations',
    category: 'Administration',
    isDangerous: false,
  },
  {
    key: 'kernel.role.manage',
    resource: 'role',
    action: 'manage',
    label: 'Manage roles and permissions',
    description: 'Can grant any permission, including this one.',
    category: 'Administration',
    isDangerous: true,
  },
  {
    key: 'kernel.approval_workflow.manage',
    resource: 'approval_workflow',
    action: 'manage',
    label: 'Manage approval workflows',
    description: 'Defines who signs off what, and at which value.',
    category: 'Administration',
    isDangerous: true,
  },
  {
    key: 'kernel.audit.read',
    resource: 'audit',
    action: 'read',
    label: 'View the audit trail',
    category: 'Administration',
    isDangerous: false,
  },
  {
    key: 'kernel.document.read',
    resource: 'document',
    action: 'read',
    label: 'View documents',
    category: 'Documents',
    isDangerous: false,
  },
  {
    key: 'kernel.document.manage',
    resource: 'document',
    action: 'manage',
    label: 'Upload and manage documents',
    category: 'Documents',
    isDangerous: false,
  },
  {
    key: 'kernel.number_series.manage',
    resource: 'number_series',
    action: 'manage',
    label: 'Manage document numbering',
    description: 'Changing a gapless series is an audit-relevant action.',
    category: 'Settings',
    isDangerous: true,
  },
  {
    key: 'kernel.master_data.read',
    resource: 'master_data',
    action: 'read',
    label: 'View master data',
    category: 'Master Data',
    isDangerous: false,
  },
  {
    key: 'kernel.master_data.manage',
    resource: 'master_data',
    action: 'manage',
    label: 'Manage parties, items and projects',
    category: 'Master Data',
    isDangerous: false,
  },
  {
    key: 'kernel.module.manage',
    resource: 'module',
    action: 'manage',
    label: 'Enable and disable modules',
    description: 'Controls what this tenant has access to.',
    category: 'Administration',
    isDangerous: true,
  },
];
