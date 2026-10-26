FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN chmod 1777 /tmp \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install

FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm run build

FROM rust:1.88-bookworm AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY rust/ ./rust/
RUN cargo build --release -p multivibe-proxy-core
RUN cargo build --release -p multivibe-v1-edge

FROM node:22-bookworm-slim
WORKDIR /app
RUN chmod 1777 /tmp \
  && apt-get update \
  && apt-get install -y --no-install-recommends git libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV MULTIVIBE_CONTROL_PLANE=true
ENV CONTROL_PLANE_PORT=1456
ENV V1_EDGE_PORT=1455
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
ENV APP_GIT_SHA=$GIT_SHA
ENV APP_BUILD_ID=$BUILD_ID
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=rust-build /src/target/release/libmultivibe_proxy_core.so ./native/multivibe-proxy-core.node
COPY --from=rust-build /src/target/release/multivibe-v1-edge /opt/multivibe/bin/multivibe-v1-edge
COPY --chmod=0555 scripts/start-multivibe.sh /usr/local/bin/start-multivibe.sh
COPY modules/security ./modules/security
COPY --from=build \
  /app/scripts/export-trace-analytics.mjs \
  /app/scripts/codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.sh \
  ./scripts/
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 1455 1456
CMD ["/usr/local/bin/start-multivibe.sh"]
