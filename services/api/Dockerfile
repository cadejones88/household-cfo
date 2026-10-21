# Homestead API + jobs: one image, two entry points (spec: Stack, "Same image, different entry points").
#
#   API   node api/dist/server.js            (Container App, port 8080)
#   jobs  node jobs/dist/index.js <job-name> (Container Apps Jobs; see infra/modules/container-apps.bicep)
#
# Build from the repository root (the workspace lock and the shared packages are needed):
#   docker build -f services/api/Dockerfile -t homestead-api:local .
#
# Multi-stage: pnpm installs and builds in `build`; `pnpm deploy --prod` writes a self-contained copy of each
# service with only its production dependencies (workspace packages included, copied not linked); the runtime
# stage copies those two folders and runs as the unprivileged `node` user. No secret is baked in: configuration
# comes from the environment and Key Vault at run time.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build -------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@10.28.0 --no-audit --no-fund
WORKDIR /src

# Manifests first so the install layer caches until a dependency changes. Every workspace manifest is copied
# (a frozen lockfile is checked against all importers), but only the four packages the image needs install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ledger-adapter-bc/package.json packages/ledger-adapter-bc/
COPY services/api/package.json services/api/
COPY services/jobs/package.json services/jobs/
COPY apps/console/package.json apps/console/
COPY apps/mobile/package.json apps/mobile/
COPY test/package.json test/
RUN pnpm install --frozen-lockfile \
      --filter @homestead/shared --filter @homestead/ledger-adapter-bc \
      --filter @homestead/api --filter @homestead/jobs

# Sources, then build in dependency order (shared → ledger adapter → api → jobs).
COPY packages/shared packages/shared
COPY packages/ledger-adapter-bc packages/ledger-adapter-bc
COPY services/api services/api
COPY services/jobs services/jobs
RUN pnpm --filter @homestead/shared build \
 && pnpm --filter @homestead/ledger-adapter-bc build \
 && pnpm --filter @homestead/api build \
 && pnpm --filter @homestead/jobs build

# Production copies. `--legacy` keeps pnpm 10's deploy behaviour of copying workspace packages into node_modules
# without requiring inject-workspace-packages in .npmrc.
RUN pnpm --filter @homestead/api deploy --prod --legacy /out/api \
 && pnpm --filter @homestead/jobs deploy --prod --legacy /out/jobs \
 && rm -rf /out/api/src /out/jobs/src /out/api/test /out/jobs/test

# ---- runtime -----------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /out/api  /app/api
COPY --from=build --chown=node:node /out/jobs /app/jobs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/server.js"]
