# UNRELEASED — Zoho Analytics Code Mode, remote multi-user server.
#
# This is not the shipped product. The released server is stdio, installed from
# a clone and spawned by the agent host; it needs no image. See ./README.md.
#
# Build from the repository root, not from this directory:
#
#   docker build -f deploy/Dockerfile -t za-codemode:remote .
#   docker run --name zoho-analytics-code-mode \
#     --env-file deploy/.env -p 4000:4000 za-codemode:remote
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./

# isolated-vm is a native addon: it needs a toolchain at build time, and its
# install script must be allowed to run. Neither is kept in the final image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && npm ci --omit=dev --foreground-scripts \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY manual/ ./manual/
COPY knowledge/ ./knowledge/

# Never run model-written code as root, even inside an isolate.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/remote.mjs"]
