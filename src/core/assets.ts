/**
 * Static asset serving with content-hashed URLs.
 *
 * The admin previously inlined 28 KB of CSS and 11 KB of JS into every single
 * response. On a five-page click-through that is ~190 KB of identical bytes
 * re-sent and re-parsed, and it defeats the browser cache entirely.
 *
 * Assets are now served from their own URLs with the content hash in the path:
 *
 *   /admin/assets/app.<hash>.css
 *
 * Because the hash changes whenever the content does, the response can be
 * cached immutably and forever. A deploy that changes the CSS changes the URL,
 * so there is no stale-cache problem and no cache-busting query string to
 * remember to bump.
 *
 * The asset bodies are produced at module load by `importing` the source files
 * as strings, then hashed once. No bundler, no file copies, no extra build
 * step in the Dockerfile.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Asset {
  path: string;
  body: string;
  contentType: string;
  etag: string;
}

function makeAsset(name: string, body: string, contentType: string): Asset {
  const hash = createHash('sha256').update(body).digest('base64url').slice(0, 12);
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  return {
    path: `/admin/assets/${stem}.${hash}${ext}`,
    body,
    contentType,
    etag: `"${hash}"`,
  };
}

/**
 * Reads a source file as a string at startup.
 *
 * Used for the admin's client.js, which lives outside the TypeScript tree
 * on purpose — it is plain ES5 so the browser runs it without a transpiler.
 */
function loadSource(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', relativePath), 'utf8');
}

/**
 * Vendored front-end libraries, for the record.
 *
 * These live in `src/admin/vendor/` as byte-for-byte upstream copies with one
 * edit: the trailing `//# sourceMappingURL=` line is stripped, because it
 * points at a jsdelivr path that would 404 against our origin and show up as
 * a console error on every page load.
 *
 * To update one: re-download, strip the sourcemap comment, run the tests
 * (`tests/core/assets.test.ts` asserts the bundles are present, that sonner's
 * export is still `default`, and that no sourcemap reference slipped back in).
 *
 *   htmx     2.0.4    https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js
 *   alpine   3.14.8   https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js
 *   sonner   1.1.3    https://cdn.jsdelivr.net/npm/sonner-js@1.1.3/+esm
 *
 * All three are MIT licensed.
 *
 * Note on sonner: the bundle exports the toast function as `default`, NOT as a
 * named `toast`. Importing `{ toast }` throws a SyntaxError at module
 * evaluation, which silently disabled every toast in the admin console until
 * it was caught. The import site is `scriptTags()` in `admin/html.ts`.
 */
const VENDOR = {
  htmx: { file: 'admin/vendor/htmx.min.js', version: '2.0.4' },
  alpine: { file: 'admin/vendor/alpine.min.js', version: '3.14.8' },
  sonner: { file: 'admin/vendor/sonner.esm.js', version: '1.1.3' },
} as const;

/** Versions of the vendored libraries, for diagnostics and docs. */
export const VENDOR_VERSIONS: Readonly<Record<keyof typeof VENDOR, string>> = {
  htmx: VENDOR.htmx.version,
  alpine: VENDOR.alpine.version,
  sonner: VENDOR.sonner.version,
};

/**
 * The bundled admin assets. CSS lives in the html.ts module so the server
 * only has to import one file; the client script is a small ES5 file that
 * pairs with the inlined stylesheet.
 *
 * The three vendor libraries are served from here too, rather than from
 * jsdelivr. Loading them from a CDN meant the admin console had a hard
 * runtime dependency on an external host with no SRI and no fallback: a
 * blocked or slow CDN left the page with zero interactivity and no way to
 * tell. Serving our own copies also removes three DNS lookups and three
 * TLS handshakes from every cold page load.
 */
export interface AdminAssets {
  css: Asset;
  js: Asset;
  /** htmx, for partial updates. Classic script. */
  htmx: Asset;
  /** Alpine, for modals and local state. Classic script. */
  alpine: Asset;
  /** sonner-js toast surface. ES module with a *default* export. */
  sonner: Asset;
  /** True when the server has finished building the assets. */
  ready: boolean;
}

const JS_TYPE = 'application/javascript; charset=utf-8';

export function buildAdminAssets(getStyles: () => string): AdminAssets {
  const css = makeAsset('app.css', getStyles(), 'text/css; charset=utf-8');
  const js = makeAsset('app.js', loadSource('admin/client.js'), JS_TYPE);
  const htmx = makeAsset('htmx.js', loadSource(VENDOR.htmx.file), JS_TYPE);
  const alpine = makeAsset('alpine.js', loadSource(VENDOR.alpine.file), JS_TYPE);
  const sonner = makeAsset('sonner.js', loadSource(VENDOR.sonner.file), JS_TYPE);
  return { css, js, htmx, alpine, sonner, ready: true };
}

/** Every asset, for the route that serves them by hashed filename. */
export function assetList(assets: AdminAssets): Asset[] {
  return [assets.css, assets.js, assets.htmx, assets.alpine, assets.sonner];
}

export function serveAsset(asset: Asset, request: Request): Response {
  if (request.headers.get('if-none-match') === asset.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: asset.etag, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }
  return new Response(asset.body, {
    headers: {
      'Content-Type': asset.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: asset.etag,
    },
  });
}

