import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Locating the migrations directory, with NO database driver imported.
 *
 * This lives apart from migrate.ts on purpose. migrate.ts is the dev/test
 * harness: it imports `drizzle-orm/pglite`, which pulls in @electric-sql/pglite,
 * a 26 MB WASM Postgres that exists only so tests can run without a server.
 *
 * scripts/migrate-prod.ts needs exactly one thing from that file — this
 * function — and importing it from there dragged the whole test harness into
 * the production entrypoint. The effect was invisible locally and expensive in
 * the image: PGlite is an optional peer of drizzle-orm, so `npm ci --omit=dev`
 * installed it anyway to satisfy the peer, and the production container shipped
 * a test-only WASM database it could never use.
 *
 * Keeping this module driver-free is what lets the runtime image install with
 * `--omit=dev --omit=optional` and still run migrations.
 *
 * .sql files are not emitted by tsc, so the compiled layout (dist/src/db/) does
 * not contain them. Walk up from this module looking for a migrations folder
 * beside a src/db directory, which resolves identically from source and from
 * dist. Override with COLDPATH_MIGRATIONS_DIR when deploying.
 */
export function migrationsDir(): string {
  const override = process.env.COLDPATH_MIGRATIONS_DIR;
  if (override) {
    if (!existsSync(override)) throw new Error(`COLDPATH_MIGRATIONS_DIR does not exist: ${override}`);
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'src', 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const local = join(dir, 'migrations');
    if (existsSync(local) && readdirSync(local).some((f) => f.endsWith('.sql'))) return local;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate a migrations directory from ${dirname(fileURLToPath(import.meta.url))}`);
}

export const MIGRATIONS_DIR = resolve(migrationsDir());
