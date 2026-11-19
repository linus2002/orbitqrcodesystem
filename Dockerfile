# syntax=docker/dockerfile:1
#
# Production: Coolify on the Bishnoi One server (DEPLOY.md, "Coolify"). The
# data and every stored file live in PostgreSQL - set DATABASE_URL to the
# database's internal url. Run ONE replica. No volume is needed; /data is only
# for the local-file fallback when no database is configured.
#
# Node 24 is what this project is developed against.

# --- build -----------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
# --include=dev: the build needs Vite, a devDependency. Hosts like Coolify pass
# NODE_ENV=production into the build, which makes a plain `npm ci` skip it
# ("vite: not found"). The runtime stage below still installs no dev packages.
RUN npm ci --include=dev

COPY . .
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY src ./src
COPY scripts ./scripts

# Used only when neither DATABASE_URL nor Sanity is configured - never in
# production, where the data is in Postgres and the container keeps nothing.
ENV DB_FILE=/data/qrshield.json
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

# The same liveness probe the load balancer uses (GET /api/health).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `npm start` runs scripts/migrate.js first via the prestart hook: against
# Postgres it creates the schema and tables if missing (idempotent), then
# proves the database answers before the server binds.
CMD ["npm", "start"]
