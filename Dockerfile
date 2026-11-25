# Multi-target production image. Build arguments and image ENV contain no secrets.
# Build with --network=none only after the Node base image and npm cache are available locally.
FROM node:22.23.5-bookworm-slim AS build-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma.config.ts ./prisma.config.ts
# Prisma's npm postinstall loads prisma.config.ts, which imports this runtime guard.
COPY src/server/migration-target-guard.ts ./src/server/migration-target-guard.ts
COPY src/server/workers/database-identity-guard.ts ./src/server/workers/database-identity-guard.ts
# postinstall runs Prisma generate only; the project script pins a loopback placeholder URL.
RUN npm ci

FROM build-deps AS builder
COPY . .
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CLIPFORGE_CONTAINER_BUILD=true
# package.json's generate script uses a loopback placeholder URL. Prisma generate does not connect.
RUN npm run build
RUN mkdir -p .next/standalone/.next \
    && cp -a .next/static .next/standalone/.next/static \
    && if [ -d public ]; then cp -a public .next/standalone/public; fi

# Build a clean worker dependency tree from its dedicated, locked runtime manifest.
# This avoids retaining the Prisma CLI optional peer chain from the full build install.
FROM node:22.23.5-bookworm-slim AS worker-runtime-deps
WORKDIR /app
COPY docker/worker-runtime/package.json docker/worker-runtime/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts

FROM node:22.23.5-bookworm-slim AS runtime-base
ENV NODE_ENV=production \
    CLIPFORGE_DEPLOYMENT_ENV=production \
    CLIPFORGE_STORAGE_PROVIDER=s3 \
    TMPDIR=/tmp/clipforge
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/clipforge \
    && chown node:node /tmp/clipforge
STOPSIGNAL SIGTERM

FROM runtime-base AS web
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Prisma 7 generated output is ignored by Git and generated inside the builder.
COPY --from=builder --chown=node:node /app/src/generated/prisma ./src/generated/prisma
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]

FROM runtime-base AS worker-runtime
COPY --from=worker-runtime-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=worker-runtime-deps --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
USER node

FROM worker-runtime AS worker-media-verification
USER root
# Debian ships ffprobe in the ffmpeg package; verification needs only the probe executable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && rm /usr/bin/ffmpeg \
    && command -v ffprobe >/dev/null \
    && ! command -v ffmpeg >/dev/null
USER node
CMD ["node", "--import", "tsx", "scripts/run-media-verification-worker.ts"]

FROM worker-runtime AS worker-media-cleanup
CMD ["node", "--import", "tsx", "scripts/run-media-cleanup-worker.ts"]

FROM worker-runtime AS worker-media-replacement
USER root
# Replacement validates the promoted asset with ffprobe but does not render/transcode it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && rm /usr/bin/ffmpeg \
    && command -v ffprobe >/dev/null \
    && ! command -v ffmpeg >/dev/null
USER node
CMD ["node", "--import", "tsx", "scripts/run-media-replacement-worker.ts"]

FROM worker-runtime AS worker-render
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "--import", "tsx", "scripts/run-render-worker.ts"]

FROM worker-runtime AS worker-instagram-publishing
CMD ["node", "--import", "tsx", "scripts/run-publishing-worker.ts"]
