import { describe, it, expect } from 'vitest';
import { esc, html, raw, formatBytes, layout } from '../../src/admin/html.ts';
import {
  Router,
  json,
  htmlResponse,
  redirect,
  withCors,
  requireBasicAuth,
} from '../../src/core/router.ts';

describe('esc', () => {
  it('escapes every HTML-significant character', () => {
    expect(esc(`<script>"x"&'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });

  it('escapes ampersands before entities, avoiding double-encoding bugs', () => {
    expect(esc('&lt;')).toBe('&amp;lt;');
  });
});

describe('html template', () => {
  it('escapes interpolated values by default', () => {
    const name = '<img onerror=alert(1)>';
    expect(html`<p>${name}</p>`).toBe('<p>&lt;img onerror=alert(1)&gt;</p>');
  });

  it('inserts raw() fragments verbatim', () => {
    expect(html`<div>${raw('<b>bold</b>')}</div>`).toBe('<div><b>bold</b></div>');
  });

  it('joins arrays and drops nullish values', () => {
    expect(html`${['a', 'b']}${null}${undefined}${false}`).toBe('ab');
  });

  it('escapes a magnet link, since these come from user input', () => {
    const magnet = 'magnet:?xt=urn:btih:abc&dn="x"';
    expect(html`<td>${magnet}</td>`).toContain('&amp;dn=&quot;x&quot;');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(4831838208)).toBe('4.50 GiB');
    expect(formatBytes(276134947)).toBe('263.3 MiB');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(140)).toBe('140 B');
  });
});

describe('layout', () => {
  const PATHS = {
    cssPath: '/admin/assets/app.aaaaaaaaaaaa.css',
    jsPath: '/admin/assets/app.bbbbbbbbbbbb.js',
    htmxPath: '/admin/assets/htmx.cccccccccccc.js',
    alpinePath: '/admin/assets/alpine.dddddddddddd.js',
    sonnerPath: '/admin/assets/sonner.eeeeeeeeeeee.js',
  };

  it('escapes the title and marks the active nav item', () => {
    const page = layout({
      title: '<x>',
      activeNav: '/admin/accounts',
      body: '<p>hi</p>',
      ...PATHS,
    });
    expect(page).toContain('&lt;x&gt; · SeedrPool');
    // The active nav anchor must be the one pointing at /admin/accounts.
    const activeMatch = page.match(/<a[^>]*href="\/admin\/accounts"[^>]*aria-current="page"[^>]*>/);
    expect(activeMatch).not.toBeNull();
    expect(page).toContain('<p>hi</p>');
  });

  it('imports sonner as a default export, not a named one', () => {
    // `import { toast } from ...` throws a SyntaxError against this bundle,
    // which left window.toast undefined and silently turned every toast in
    // the app into a console.log. No action appeared to give any feedback.
    const page = layout({ title: 'x', body: '', ...PATHS });
    expect(page).toContain(`import toast from '${PATHS.sonnerPath}'`);
    expect(page).not.toMatch(/import\s*\{\s*toast\s*\}/);
  });

  it('loads the client script before Alpine so alpine:init is not missed', () => {
    // Alpine's bundle ends with queueMicrotask(() => Alpine.start()), and the
    // microtask queue drains between deferred scripts. With Alpine first, the
    // event had already fired before client.js could listen, so the modal
    // store never registered and every confirm-gated action broke.
    const page = layout({ title: 'x', body: '', ...PATHS });
    const clientAt = page.indexOf(PATHS.jsPath);
    const alpineAt = page.indexOf(PATHS.alpinePath);
    expect(clientAt).toBeGreaterThan(-1);
    expect(alpineAt).toBeGreaterThan(-1);
    expect(clientAt).toBeLessThan(alpineAt);
  });

  it('serves every script from our own origin, never a CDN', () => {
    // A blocked or slow CDN used to leave the console with zero
    // interactivity and no way to tell.
    const page = layout({ title: 'x', body: '', ...PATHS });
    expect(page).not.toContain('jsdelivr');
    expect(page).not.toContain('unpkg');
    for (const src of [...page.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
      expect(src).toMatch(/^\/admin\/assets\//);
    }
  });

  it('links the hashed stylesheet', () => {
    const page = layout({ title: 'x', body: '', ...PATHS });
    expect(page).toContain(`<link rel="stylesheet" href="${PATHS.cssPath}">`);
  });
});

describe('Router', () => {
  const build = () =>
    new Router()
      .get('/', () => new Response('root'))
      .get('/admin/accounts', () => new Response('accounts'))
      .get('/:secret/manifest.json', (ctx) => json({ secret: ctx.params['secret'] }), {
        cors: true,
      })
      .post('/admin/magnet', () => new Response('added'));

  it('routes static paths', async () => {
    const res = await build().handle(new Request('http://x/admin/accounts'));
    expect(await res.text()).toBe('accounts');
  });

  it('captures named parameters', async () => {
    const res = await build().handle(new Request('http://x/abc123/manifest.json'));
    expect(await res.json()).toEqual({ secret: 'abc123' });
  });

  it('decodes percent-encoded parameters', async () => {
    const res = await build().handle(new Request('http://x/a%2Fb/manifest.json'));
    expect(await res.json()).toEqual({ secret: 'a/b' });
  });

  it('returns 404 for unknown paths', async () => {
    const res = await build().handle(new Request('http://x/nope'));
    expect(res.status).toBe(404);
  });

  it('distinguishes a wrong method from a missing path', async () => {
    const res = await build().handle(
      new Request('http://x/admin/accounts', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });

  it('answers OPTIONS preflight, which Stremio clients send', async () => {
    const res = await build().handle(
      new Request('http://x/abc/manifest.json', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('adds CORS only to routes that ask for it', async () => {
    const router = build();
    const addon = await router.handle(new Request('http://x/abc/manifest.json'));
    const adminPage = await router.handle(new Request('http://x/admin/accounts'));
    // The Stremio protocol requires permissive CORS; the admin page does not.
    expect(addon.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(adminPage.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('ignores query strings when matching', async () => {
    const res = await build().handle(new Request('http://x/admin/accounts?refresh=1'));
    expect(await res.text()).toBe('accounts');
  });
});

describe('response helpers', () => {
  it('sets JSON content type', () => {
    expect(json({ a: 1 }).headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('sets HTML content type', () => {
    expect(htmlResponse('<p>').headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('redirects with 303 so form posts do not resubmit', () => {
    const res = redirect('/admin');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/admin');
  });

  it('preserves status when adding CORS', () => {
    const res = withCors(new Response('x', { status: 201 }));
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

describe('requireBasicAuth', () => {
  const creds = (user: string, pass: string) => ({
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
  });

  it('accepts correct credentials', () => {
    const req = new Request('http://x/admin', { headers: creds('jay', 's3cret') });
    expect(requireBasicAuth(req, 'jay', 's3cret')).toBeNull();
  });

  it('challenges when the header is absent', () => {
    const res = requireBasicAuth(new Request('http://x/admin'), 'jay', 's3cret');
    expect(res?.status).toBe(401);
    expect(res?.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('rejects a wrong password', () => {
    const req = new Request('http://x/admin', { headers: creds('jay', 'wrong') });
    expect(requireBasicAuth(req, 'jay', 's3cret')?.status).toBe(401);
  });

  it('rejects a wrong username', () => {
    const req = new Request('http://x/admin', { headers: creds('eve', 's3cret') });
    expect(requireBasicAuth(req, 'jay', 's3cret')?.status).toBe(401);
  });

  it('handles passwords containing colons', () => {
    const req = new Request('http://x/admin', { headers: creds('jay', 'a:b:c') });
    expect(requireBasicAuth(req, 'jay', 'a:b:c')).toBeNull();
  });

  it('rejects a malformed header instead of throwing', () => {
    const req = new Request('http://x/admin', { headers: { Authorization: 'Basic !!!' } });
    expect(requireBasicAuth(req, 'jay', 's3cret')?.status).toBe(401);
  });

  it('skips the check when no password is configured', () => {
    expect(requireBasicAuth(new Request('http://x/admin'), 'jay', '')).toBeNull();
  });
});
