# syntax=docker/dockerfile:1
#
# Multi-stage build. Cloud-agnostic by design (PRODUCT-PLAN.md decision #3):
# nothing here depends on a specific provider, and the runtime image carries no
# build toolchain and no package manager.
#
# At M0 there is no HTTP server yet — the image runs migrations. From M6 the
# same image serves the Next.js application; only CMD changes.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Non-root. The application database role is separately non-superuser and does
# not own the tables — see src/db/rls.ts and PRODUCT-PLAN.md §4.2.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin coldpath \
 && chown -R coldpath:coldpath /app
USER coldpath

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(require('node:fs').existsSync('/app/dist')?0:1)"

# M0: apply migrations. From M6: `node dist/server.js`.
CMD ["node", "dist/scripts/migrate-prod.js"]
