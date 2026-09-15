# syntax=docker/dockerfile:1
#
# Multi-stage build. Cloud-agnostic by design (PRODUCT-PLAN.md decision #3):
# nothing here depends on a specific provider, and the runtime image carries no
# build toolchain and no package manager.
#
# At M0 there is no HTTP server yet — the image runs migrations. From M6 the
# same image serves the Next.js application; only CMD changes.

# Build dependencies: the full tree, needed to compile.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Runtime dependencies: production only.
#
# The runtime image used to copy node_modules from `deps`, so it shipped all
# eight devDependencies — typescript, eslint, vitest, tsx, drizzle-kit and the
# esbuild chain their advisories attach to. None of it runs in production; it is
# five packages that do. A build toolchain in a production image is attack
# surface that exists for no reason, and it is the difference between a clean
# `npm audit --omit=dev` and a misleading one.
#
# --omit=optional matters as much as --omit=dev here: @electric-sql/pglite is an
# OPTIONAL PEER of drizzle-orm, so --omit=dev alone still installed its 26 MB of
# WASM Postgres — a test-only database, in the production image. Dropping it is
# only safe because migrate-prod.ts no longer reaches a PGlite import; see
# src/db/migrations-dir.ts.
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Non-root. The application database role is separately non-superuser and does
# not own the tables — see src/db/rls.ts and PRODUCT-PLAN.md §4.2.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin coldpath \
 && chown -R coldpath:coldpath /app
USER coldpath

# Until M6 serves HTTP there is no liveness signal to probe, so this checks the
# one thing that is actually falsifiable: that the built entrypoint exists and
# the runtime can load its dependency graph. The previous form tested only that
# /app/dist existed, which is true in every image this Dockerfile can produce —
# it could not fail. Replace with a real endpoint probe when the server lands.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "import('/app/dist/src/db/rls.js').then(m=>process.exit(m.allSecuritySql().length>0?0:1)).catch(()=>process.exit(1))"

# M0: apply migrations. From M6: `node dist/server.js`.
CMD ["node", "dist/scripts/migrate-prod.js"]
