# syntax=docker/dockerfile:1
#
# Runs on any host that gives the container a persistent volume - Railway,
# Render, Fly.io, or a plain VPS.
#
# Node 24 rather than the 22 in package.json engines: `node:sqlite` is only
# importable without --experimental-sqlite from Node 22.13 onward, and 24 is
# what this project is developed against.

# --- build -----------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

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

# The volume mounts at /data. Keeping the database off the image means a
# redeploy replaces the code and leaves the codes, scans and alerts alone.
ENV DB_FILE=/data/qrshield.db
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

# The same liveness probe the load balancer uses (GET /api/health).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `npm start` runs scripts/migrate.js first via the prestart hook, so a fresh
# volume gets its schema before the server binds. migrate is idempotent.
CMD ["npm", "start"]
