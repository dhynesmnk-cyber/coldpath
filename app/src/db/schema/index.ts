/**
 * Single import point for the whole schema. Drizzle-kit reads this to generate
 * migrations, and the repository layer imports tables from here rather than from
 * individual modules so a table cannot be used without its tenant_id being visible.
 */
export * from './tenant.js';
export * from './identity.js';
export * from './account.js';
export * from './research.js';
export * from './deliverable.js';
export * from './ops.js';
