import { describe, it, expect } from 'vitest';
import { SessionAuth } from '../../src/core/session.ts';

/**
 * The login flow is the front door of the console. These pin the parts that
 * are easy to get subtly wrong: cookie forgery, expiry, sliding refresh,
 * and logout actually dropping the session server-side.
 */

const USER = 'jay';
const PASS = 'hunter2';

function make(): SessionAuth {
  return new SessionAuth(USER, PASS);
}

function cookieOf(res: { cookie: string }): string {
  return res.cookie;
}

function requestWithCookie(cookie: string): Request {
  return new Request('http://x/admin', { headers: { cookie } });
}

/** Extracts just the cookie value (name=..., sans attributes). */
function cookieValue(cookieHeader: string): string {
  return cookieHeader.split(';')[0] ?? '';
}

describe('SessionAuth.verify', () => {
  it('accepts the right credentials', () => {
    expect(make().verify(USER, PASS)).toBe(true);
  });

  it('rejects a wrong password, wrong user, and both', () => {
    const auth = make();
    expect(auth.verify(USER, 'wrong')).toBe(false);
    expect(auth.verify('nope', PASS)).toBe(false);
    expect(auth.verify('nope', 'wrong')).toBe(false);
  });

  it('rejects empty credentials', () => {
    expect(make().verify('', '')).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('a created session authorizes the request that carries its cookie', () => {
    const auth = make();
    const created = auth.createSession();
    const check = auth.check(requestWithCookie(cookieOf(created)));
    expect(check.ok).toBe(true);
  });

  it('rejects a request with no cookie', () => {
    expect(make().check(new Request('http://x/admin')).ok).toBe(false);
  });

  it('rejects a forged cookie: unknown id with a copied signature', () => {
    const auth = make();
    const created = auth.createSession();
    // Take the valid signature but claim a different id.
    const [id, sig] = cookieValue(cookieOf(created)).split('.') as [string, string];
    const forged = `seedrpool_session=attacker-id.${sig}`;
    expect(auth.check(requestWithCookie(forged)).ok).toBe(false);
  });

  it('rejects a cookie signed by a different process key', () => {
    // Two instances (i.e. before and after a restart) must not accept each
    // other's cookies.
    const a = make();
    const b = make();
    const created = a.createSession();
    expect(b.check(requestWithCookie(cookieOf(created))).ok).toBe(false);
  });

  it('an expired session is refused and dropped', () => {
    const auth = make();
    const t0 = 1_000_000;
    const created = auth.createSession(t0);
    // Far past the 12-hour TTL.
    const later = t0 + 13 * 60 * 60_000;
    expect(auth.check(requestWithCookie(cookieOf(created)), later).ok).toBe(false);
    // Even after "rewinding" — expired means expired, not forgotten.
    expect(auth.check(requestWithCookie(cookieOf(created)), t0 + 1).ok).toBe(false);
  });

  it('an active session is refreshed past half its life', () => {
    const auth = make();
    const t0 = 1_000_000;
    const created = auth.createSession(t0);
    const cookie = cookieOf(created);

    // At 7 of 12 hours: past half, must hand back a refresh cookie.
    const at = t0 + 7 * 60 * 60_000;
    const check = auth.check(requestWithCookie(cookie), at);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.refreshCookie).not.toBeNull();
      // The refreshed cookie must itself be valid, and slide further.
      const reCheck = auth.check(requestWithCookie(cookieOf({ cookie: check.refreshCookie! })), at + 60_000);
      expect(reCheck.ok).toBe(true);
    }
  });

  it('a fresh session is not rewritten on every request', () => {
    // Rewriting the cookie each time would defeat caches and spam the
    // response headers for no gain.
    const auth = make();
    const t0 = 1_000_000;
    const created = auth.createSession(t0);
    const check = auth.check(requestWithCookie(cookieOf(created)), t0 + 1_000);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.refreshCookie).toBeNull();
  });

  it('destroy() invalidates the session server-side and expires the cookie', () => {
    const auth = make();
    const created = auth.createSession();
    const cookie = cookieOf(created);

    const expired = auth.destroy(requestWithCookie(cookie));
    expect(expired).toMatch(/Max-Age=0/);

    // The id is gone from the server; the old cookie no longer authorizes.
    expect(auth.check(requestWithCookie(cookie)).ok).toBe(false);
  });

  it('destroy() on a request with no cookie still expires the client cookie', () => {
    const auth = make();
    expect(auth.destroy(new Request('http://x/admin'))).toMatch(/Max-Age=0/);
  });
});

describe('cookie shape', () => {
  it('is HttpOnly, SameSite=Lax, scoped to /admin, with an Expires', () => {
    const auth = make();
    const { cookie } = auth.createSession();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/admin/);
    expect(cookie).toMatch(/Expires=/);
    // Not Secure: the container serves plain HTTP behind Caddy, and a
    // Secure cookie would be dropped on the loopback healthcheck path.
  });

  it('carries an id and an HMAC signature, dot-separated', () => {
    const { cookie } = make().createSession();
    const value = cookieValue(cookie);
    expect(value).toMatch(/^seedrpool_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
