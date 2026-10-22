# NEXUS//SIGNALS — self-hosted production image (SELFHOST-0929)
# Build (from repo root):
#   docker build -f deploy/Dockerfile -t nexus-signals:latest .
# Run:
#   cp deploy/.env.example .env   # edit secrets first!
#   docker compose -f deploy/docker-compose.yml up -d
#
# NOTE on the workdir: the codebase carries the sandbox-era absolute path
# /home/z/my-project in a handful of operational scripts. The container
# reproduces that exact path (WORKDIR + compose bind mount), so ZERO code
# changes are needed. Do not "fix" the path here without grepping first.

FROM oven/bun:1.3 AS deps
WORKDIR /home/z/my-project
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS build
WORKDIR /home/z/my-project
COPY --from=deps /home/z/my-project/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* (e.g. NEXT_PUBLIC_WS_URL) are build-time inlined — set them
# as build args if you deviate from the reverse-proxy defaults.
ARG NEXT_PUBLIC_WS_URL="/ws"
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
RUN bunx prisma generate && bun run build

FROM oven/bun:1.3 AS run
WORKDIR /home/z/my-project
ENV NODE_ENV=production
# tini = proper PID1 signal handling (the sandbox used a platform supervisor;
# here the container runtime + restart policy IS the guardian lineage)
RUN apt-get update && apt-get install -y --no-install-recommends tini sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /home/z/my-project /home/z/my-project
EXPOSE 3000 3003 3005 3010 3011 3015 3016 3020 3030
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "start:selfhost"]
