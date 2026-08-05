/**
 * The kernel's Postgres schema.
 *
 * Business modules import from here and own their own schema. They must never
 * import each other — enforced by .dependency-cruiser.cjs.
 */
export * from '../columns';

export * from './approvals';
export * from './audit';
export * from './customfields';
export * from './documents';
export * from './events';
export * from './identity';
export * from './localisation';
export * from './masterdata';
export * from './notifications';
export * from './numbering';
export * from './rbac';
export * from './tenancy';
