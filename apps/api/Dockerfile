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
USER aerolith

ENV NODE_ENV=production
EXPOSE 3001

CMD ["pnpm", "--filter", "@aerolith/api", "run", "start"]
