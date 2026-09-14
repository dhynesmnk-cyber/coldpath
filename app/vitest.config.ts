import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Set COLDPATH_LOW_MEMORY=1 on constrained machines (small laptops, free-tier CI
 * runners, sandboxes) to serialise test files and share one process.
 *
 * The default is the idiomatic parallel configuration — that is what the product
 * targets, because integration tests each load a WASM Postgres (~300 MB) and the
 * intended runtime environment has the headroom for several at once.
 *
 * Low-memory mode is an escape hatch, not the design. It also changes semantics:
 * files share a process, so a test that leaks global state can affect another.
 * Every integration file builds its own PGlite instance and closes it, so this
 * holds today — but it is a real constraint and it is documented rather than hidden.
 */
const lowMemory = process.env.COLDPATH_LOW_MEMORY === '1';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    ...(lowMemory
      ? { pool: 'threads', isolate: false, maxWorkers: 1, minWorkers: 1, fileParallelism: false }
      : {}),
  },
});
