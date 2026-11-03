FROM node:22-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 25500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:25500/version >/dev/null || exit 1

CMD ["./node_modules/.bin/pm2-runtime", "ecosystem.config.cjs"]
