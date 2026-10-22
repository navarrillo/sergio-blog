FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24.14.1-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data UPLOADS_DIR=/app/uploads BACKUPS_DIR=/app/backups
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json tsconfig.json ./
COPY --chown=1000:1000 src/lib ./src/lib
COPY --chown=1000:1000 bin ./bin
USER 1000:1000
EXPOSE 8080
CMD ["node", "bin/server.mjs"]
