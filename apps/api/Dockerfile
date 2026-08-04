# Multi-stage build for @aerolith/api, using `turbo prune` so the final
# image only carries the workspace packages this app actually depends on
# (kernel + the module packages it registers), not the whole monorepo.
#
# The api has no compile step of its own — "start" runs `tsx src/main.ts`
# directly, matching how it already runs in dev (`tsx watch`). This keeps one
# runtime story rather than adding a second, Docker-only build pipeline.
FROM node:22-alpine AS base
RUN corepack enable

FROM base AS pruner
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY . .
RUN npx turbo prune @aerolith/api --docker

FROM base AS installer
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 aerolith && adduser --system --uid 1001 aerolith
COPY --from=installer --chown=aerolith:aerolith /app .
# Copied from `pruner`, not the `installer` output above: `turbo prune`'s
# pruned tree only carries what a normal build needs, and this deploy-only
# script has no reason to be part of that contract. Copying it from the
# pre-prune stage (which still has the whole original repo) means its
# presence here doesn't depend on prune's inclusion rules ever changing.
# The executable bit is set here rather than relied on from git, so a
# checkout that lost the mode bit (some editors and some Windows checkouts
# do) still produces a working image.
COPY --from=pruner --chown=aerolith:aerolith /app/apps/api/render-start.sh ./apps/api/render-start.sh
RUN chmod +x ./apps/api/render-start.sh
USER aerolith

ENV NODE_ENV=production
EXPOSE 3001

CMD ["pnpm", "--filter", "@aerolith/api", "run", "start"]
