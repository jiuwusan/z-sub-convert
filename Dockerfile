FROM node:22-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node server.js fetch-subscriptions.js template-parts.js userinfo.js country.js transform.js store.js auth.js managed.js admin-api.js download.js call-records.js ecosystem.config.cjs ./
COPY --chown=node:node prds/template.yaml ./prds/template.yaml
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 25500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:25500/version >/dev/null || exit 1

CMD ["./node_modules/.bin/pm2-runtime", "ecosystem.config.cjs"]
