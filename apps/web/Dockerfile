# Multi-stage build for @aerolith/web, using `turbo prune` for the workspace
# subset this app depends on and Next's `output: 'standalone'` (see
# next.config.ts) so the runtime image carries only the files a
# `node server.js` actually needs.
FROM node:22-alpine AS base
RUN corepack enable

FROM base AS pruner
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY . .
RUN npx turbo prune @aerolith/web --docker

FROM base AS installer
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `apps/web/tsconfig.json` extends this repo-root file, but `turbo prune`
# only carries files belonging to the pruned WORKSPACE PACKAGES into
# `out/full/` — a shared config sitting outside every package directory is
# not one of them. Without this, `next build` fails immediately with
# `error TS5083: Cannot read file '/app/tsconfig.base.json'`, a known
# Turborepo + Docker gotcha rather than anything specific to this app.
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
# Only NEXT_PUBLIC_*-style build-time values belong here — anything a
# request needs at runtime (the API's own base URL, session secrets) is read
# from the environment when the server starts, not baked into the image.
RUN npx turbo run build --filter=@aerolith/web

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 aerolith && adduser --system --uid 1001 aerolith

# The standalone output already bundles a pruned node_modules; the app's own
# compiled server and the static/public assets are copied in separately, per
# Next's documented standalone layout.
COPY --from=installer --chown=aerolith:aerolith /app/apps/web/.next/standalone ./
COPY --from=installer --chown=aerolith:aerolith /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=aerolith:aerolith /app/apps/web/public ./apps/web/public

USER aerolith

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
