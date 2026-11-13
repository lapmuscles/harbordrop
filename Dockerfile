# ---- 建置 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci
COPY . .
RUN npm run build

# ---- 執行 ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 STATIC_DIR=/app/public
RUN npm init -y >/dev/null && npm install --omit=dev better-sqlite3@^12.4.1 && npm cache clean --force
COPY --from=build /app/packages/backend/dist/server.mjs ./server.mjs
COPY --from=build /app/packages/frontend/dist ./public
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
