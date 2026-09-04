# Multi-stage build so the runtime image carries no toolchain.
#
# SeedrPool's only runtime dependency is parse-torrent-title (used for
# release-name parsing). It is installed as a production dep in the
# runtime stage with --omit=dev so the build toolchain, the test runner,
# and all of their transitive deps stay in the build stage and never
# reach the deployed image.
#
# npm is used rather than pnpm because pnpm refuses to run esbuild's
# postinstall script without an explicit approval step, which fails a
# non-interactive build.

FROM node:24-alpine AS build
WORKDIR /app

# package.json must be present before tsc runs: it carries "type": "module",
# without which TypeScript treats the output as CommonJS and verbatimModuleSyntax
# rejects every ESM import.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
# tsc emits only .ts files. The admin's client script is plain ES5 JavaScript
# (so the browser runs it untranspiled) and the vendored front-end libraries
# are pre-minified, so both have to be copied alongside the compiled output or
# the asset loader cannot find them at startup.
RUN ./node_modules/.bin/tsc && npm run copy-assets

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# The runtime image only needs the production dep tree and the compiled
# output. --omit=dev skips devDependencies entirely; the rest of node_modules
# from the build stage is intentionally not copied.
COPY package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

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
