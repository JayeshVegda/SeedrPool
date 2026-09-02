# Multi-stage build so the runtime image carries no toolchain.
#
# SeedrPool has zero runtime dependencies: fetch and node:sqlite are built into
# Node 24. The build stage installs devDependencies purely to run tsc, and none
# of it reaches the runtime image.
#
# npm is used rather than pnpm because pnpm refuses to run esbuild's postinstall
# script without an explicit approval step, which fails a non-interactive build.

FROM node:24-alpine AS build
WORKDIR /app

# package.json must be present before tsc runs: it carries "type": "module",
# without which TypeScript treats the output as CommonJS and verbatimModuleSyntax
# rejects every ESM import.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Compiled output only; no node_modules, since there are no runtime deps.
COPY --from=build /app/dist ./dist
COPY package.json ./

# The database lives on a mounted volume; the directory must exist and be
# writable by the unprivileged node user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 7010

# Bind all interfaces inside the container; Caddy is the only ingress.
ENV SEEDRPOOL_HOST=0.0.0.0
ENV SEEDRPOOL_PORT=7010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7010/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
