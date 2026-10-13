FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.22.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
# The journal must survive restarts; mount a volume here.
RUN mkdir -p /data && chown node:node /data
USER node
ENV KEEPER_STATE_PATH=/data/keeper.json
# The journal lock goes stale 30s after a crash, so every start waits KEEPER_START_DELAY (default 35s).
# KEEPER_BROADCAST=1 submits transactions; otherwise the keeper only observes.
CMD ["sh", "-c", "sleep \"${KEEPER_START_DELAY:-35}\" && exec node dist/cli.js --config \"${KEEPER_CONFIG:-config/tenderly-lifecycle.json}\" ${KEEPER_BROADCAST:+--broadcast}"]
