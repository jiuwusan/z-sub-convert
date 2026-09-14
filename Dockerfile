FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node server.js fetch-subscriptions.js country.js transform.js ecosystem.config.cjs ./
COPY --chown=node:node prds/template.yaml ./prds/template.yaml

USER node
EXPOSE 25500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:25500/version >/dev/null || exit 1

CMD ["./node_modules/.bin/pm2-runtime", "ecosystem.config.cjs"]
