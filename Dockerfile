FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY packages/backend packages/backend
COPY packages/sdk packages/sdk

RUN groupadd --system --gid 10001 paytray \
  && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin paytray \
  && chown -R paytray:paytray /app

USER paytray
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node packages/backend/scripts/check-health.mjs

CMD ["node", "packages/backend/server.js"]
