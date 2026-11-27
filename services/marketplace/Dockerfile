# MultiVibe marketplace broker.
#
# The broker holds instance signing secrets and Stripe keys: it is built from
# source and never published as a shared image. Runtime state lives in the
# mounted /data volume (a single JSON document today).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN chmod 1777 /tmp
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
# The store is a JSON document that must survive restarts and stay writable by
# the unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 1460
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1460/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
