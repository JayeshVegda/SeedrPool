import { describe, it, expect } from 'vitest';
import { buildAdminAssets, serveAsset } from '../../src/core/assets.ts';

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
