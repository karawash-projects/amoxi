# syntax=docker/dockerfile:1
#   docker build -t {{APP_NAME}} .
#   docker run -p 8080:8080 {{APP_NAME}}

FROM node:22-alpine AS build
WORKDIR /app
COPY . .
# Installs exactly what the lockfile pins, with the package manager that wrote it, builds, then
# keeps only the production dependencies. Run your package manager's install once before building
# the image, so the lockfile exists.
RUN set -e; \
  if [ -f package-lock.json ]; then \
    npm ci && npm run build && npm prune --omit=dev; \
  elif [ -f pnpm-lock.yaml ]; then \
    corepack enable pnpm && pnpm install --frozen-lockfile && pnpm run build && pnpm prune --prod; \
  elif [ -f yarn.lock ]; then \
    corepack enable yarn && yarn install --frozen-lockfile && yarn run build && yarn install --production --frozen-lockfile --ignore-scripts; \
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then \
    npm install -g bun && bun install --frozen-lockfile && bun run build && rm -rf node_modules && bun install --production --frozen-lockfile; \
  else \
    echo "No lockfile found: run npm install (or pnpm, yarn or bun install) once, then build the image again." >&2; exit 1; \
  fi

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/application*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
# Agent runs, conversations and memory are saved under /app/data (the default file store);
# the app runs as the unprivileged "node" user, so that folder must belong to it.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/amoxi/health/ready || exit 1
CMD ["node", "node_modules/amoxi/bin/amoxi.js", "start", "dist/src/main.js", "--workers", "auto"]
