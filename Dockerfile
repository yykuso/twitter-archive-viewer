# --- web UI のビルド ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
COPY scripts ./scripts
COPY src/shared ./src/shared
RUN npm run build:web

# --- 実行イメージ (ランタイム依存なし) ---
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DB_DIR=/data/db \
    MEDIA_ROOT=/data/media \
    ARCHIVE_DIR=/data/archive \
    WEB_ROOT=/app/web/dist \
    PORT=8080
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=build /app/web/dist ./web/dist
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["serve"]
