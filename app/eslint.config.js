import tseslint from 'typescript-eslint';

/**
 * Layer-boundary rules from PRODUCT-PLAN.md §2.2.
 *
 *   route handler  -> validates input, calls a service, serialises output
 *   service        -> domain logic; no HTTP, no SQL
 *   repository     -> SQL via Drizzle; no domain rules
 *   connector      -> fetch + normalise external data; no domain knowledge
 *   gate           -> pure function; no I/O at all
 *
 * These are enforced by lint rather than convention, because the whole reason
 * for the monolith-instead-of-microservices decision is that the boundary has
 * to hold without a network hop to enforce it.
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.next/**', 'drizzle/**', 'coverage/**', 'eslint.config.js'] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A system whose job is not to invent facts should not have implicit anys.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Numbers in template literals are pervasive and harmless here; forcing
      // String(n) everywhere obscures the message rather than improving it.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        // `const { secret: _secret, ...safe } = obj` is the omission idiom.
        ignoreRestSiblings: true,
      }],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  // Gates must be pure: no imports, no I/O, no database.
  {
    files: ['src/lib/gates/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/db/*', '@/connectors/*', '@/services/*', 'postgres', 'pino', '@electric-sql/pglite'],
            message: 'Gates are pure functions. They take a record and a context and return a verdict — no database, no network, no logging.' },
        ],
      }],
    },
  },
  // Services must not know about HTTP.
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['next/*', 'next-server'], message: 'Services are HTTP-agnostic. Handle transport in the route layer.' },
        ],
      }],
    },
  },
  // Connectors must not reach into the domain.
  {
    files: ['src/connectors/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/services/*'], message: 'Connectors fetch and normalise. Domain logic belongs in services.' },
        ],
      }],
    },
  },
);
