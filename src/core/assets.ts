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
 * The bundled admin assets. CSS lives in the html.ts module so the server
 * only has to import one file; the client script is a small ES5 file that
 * pairs with the inlined stylesheet.
 */
export interface AdminAssets {
  css: Asset;
  js: Asset;
  /** True when the server has finished building the assets. */
  ready: boolean;
}

export function buildAdminAssets(getStyles: () => string): AdminAssets {
  const css = makeAsset('app.css', getStyles(), 'text/css; charset=utf-8');
  const js = makeAsset('app.js', loadSource('admin/client.js'), 'application/javascript; charset=utf-8');
  return { css, js, ready: true };
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

