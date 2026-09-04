import { describe, it, expect } from 'vitest';
import { buildAdminAssets, serveAsset, assetList } from '../../src/core/assets.ts';

const CSS = ':root { --bg: #000 }';

describe('static assets', () => {
  it('puts the content hash in the path', () => {
    const a = buildAdminAssets(() => CSS);
    expect(a.css.path).toMatch(/^\/admin\/assets\/app\.[A-Za-z0-9_-]{12}\.css$/);
    expect(a.js.path).toMatch(/^\/admin\/assets\/app\.[A-Za-z0-9_-]{12}\.js$/);
  });

  it('gives different content a different URL', () => {
    // This is what makes the immutable cache header safe: a changed body
    // can never be served from a stale cache entry, because it lives at a
    // different URL.
    const a = buildAdminAssets(() => CSS);
    const b = buildAdminAssets(() => `${CSS} /* changed */`);
    expect(a.css.path).not.toBe(b.css.path);
  });

  it('gives identical content the same URL, so deploys do not churn the cache', () => {
    const a = buildAdminAssets(() => CSS);
    const b = buildAdminAssets(() => CSS);
    expect(a.css.path).toBe(b.css.path);
    expect(a.css.etag).toBe(b.css.etag);
  });

  it('serves the body with an immutable cache header', async () => {
    const a = buildAdminAssets(() => CSS);
    const res = serveAsset(a.css, new Request('http://x/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(CSS);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const a = buildAdminAssets(() => CSS);
    const res = serveAsset(
      a.css,
      new Request('http://x/', { headers: { 'if-none-match': a.css.etag } }),
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('ignores a stale If-None-Match and re-sends the body', async () => {
    const a = buildAdminAssets(() => CSS);
    const res = serveAsset(
      a.css,
      new Request('http://x/', { headers: { 'if-none-match': '"stale00000000"' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CSS);
  });

  it('sets a strong quoted ETag', async () => {
    const a = buildAdminAssets(() => CSS);
    expect(a.css.etag).toMatch(/^"[A-Za-z0-9_-]{12}"$/);
    const res = serveAsset(a.css, new Request('http://x/'));
    expect(res.headers.get('etag')).toBe(a.css.etag);
  });

  it('loads the real client script, not a placeholder', () => {
    const a = buildAdminAssets(() => CSS);
    // The JS is read off disk at startup; if the path resolution breaks,
    // this catches it rather than shipping a blank script.
    expect(a.js.body.length).toBeGreaterThan(1000);
    expect(a.js.body).toContain('showToast');
    expect(a.js.contentType).toBe('application/javascript; charset=utf-8');
  });

  it('serves js with the same caching contract as css', () => {
    const a = buildAdminAssets(() => CSS);
    const res = serveAsset(a.js, new Request('http://x/'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('vendor assets', () => {
  // The three front-end libraries used to load from jsdelivr at runtime, so a
  // blocked or slow CDN left the admin console with no interactivity at all
  // and no way to tell. They are served from our own origin now.

  it('serves htmx, Alpine, and sonner from our own hashed URLs', () => {
    const a = buildAdminAssets(() => CSS);
    for (const asset of [a.htmx, a.alpine, a.sonner]) {
      expect(asset.path).toMatch(/^\/admin\/assets\/[a-z]+\.[A-Za-z0-9_-]{12}\.js$/);
      expect(asset.contentType).toBe('application/javascript; charset=utf-8');
    }
  });

  it('loads the real vendor bundles, not empty files', () => {
    const a = buildAdminAssets(() => CSS);
    // Rough floors: htmx and Alpine are ~45-50 KB minified, sonner ~20 KB.
    expect(a.htmx.body.length).toBeGreaterThan(30_000);
    expect(a.alpine.body.length).toBeGreaterThan(30_000);
    expect(a.sonner.body.length).toBeGreaterThan(10_000);
  });

  it('ships a sonner bundle whose export is default, which the page relies on', () => {
    // The page does `import toast from ...`. Importing `{ toast }` throws a
    // SyntaxError at module evaluation, which is what silently disabled every
    // toast in the app: window.toast was never assigned.
    const a = buildAdminAssets(() => CSS);
    expect(a.sonner.body).toContain('as default}');
    expect(a.sonner.body).not.toMatch(/export\s*\{[^}]*\btoast\b[^}]*\}/);
  });

  it('carries no sourceMappingURL, which would 404 against our origin', () => {
    const a = buildAdminAssets(() => CSS);
    for (const asset of [a.htmx, a.alpine, a.sonner]) {
      expect(asset.body).not.toContain('sourceMappingURL');
    }
  });

  it('exposes every asset through assetList so the route can serve them', () => {
    const a = buildAdminAssets(() => CSS);
    const list = assetList(a);
    expect(list).toHaveLength(5);
    // The route matches on the trailing filename, so those must be unique.
    const names = list.map((x) => x.path.split('/').pop());
    expect(new Set(names).size).toBe(5);
  });

  it('gives the vendor bundles an immutable cache header too', () => {
    const a = buildAdminAssets(() => CSS);
    for (const asset of assetList(a)) {
      const res = serveAsset(asset, new Request('http://x/'));
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  });

  it('registers Alpine before it can auto-start, per the client script', () => {
    // Alpine's CDN build ends with queueMicrotask(() => Alpine.start()), and
    // the microtask queue drains between deferred scripts. The client script
    // must therefore cope with Alpine having already started, or every modal
    // and every confirm-gated destructive action silently breaks.
    const a = buildAdminAssets(() => CSS);
    expect(a.alpine.body).toContain('queueMicrotask');
    expect(a.js.body).toContain("document.addEventListener('alpine:init'");
    expect(a.js.body).toContain('if (window.Alpine) registerAlpine()');
  });
});
