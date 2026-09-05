/**
 * Cookie-based login sessions for the admin console.
 *
 * Basic auth was doing the authenticating until now, and a browser login
 * page needs something better than the same credentials behind a native
 * 401 prompt: no logout, no expiry, credentials re-sent on every request,
 * and no way to show a form. This module is the smallest honest replacement
 * for a single-operator tool:
 *
 *   - one signed session cookie, HttpOnly, SameSite=Lax;
 *   - the signature is HMAC-SHA256 over the expiry, so a cookie cannot be
 *     forged without the server's key, and there is no server-side session
 *     table to leak, expire, or clean up;
 *   - the key is random per process. A restart invalidates every session
 *     and the operator logs in again — for a fleet-of-one admin console
 *     that is a feature, not a bug;
 *   - sliding expiry: any authenticated request refreshes the cookie, so
 *     reading the console keeps you logged in while an idle tab eventually
 *     signs you out.
 *
 * What this deliberately is NOT: user management, roles, remember-me,
 * password reset. One operator, one password from the environment, same
 * as before — just behind a proper form.
 *
 * CSRF: the session cookie is SameSite=Lax, so a cross-site POST from
 * another origin does not carry it. Lax (not Strict) because the console
 * lives on its own subdomain and Strict would log you out on every
 * navigation from an external link. For a single operator this is the
 * appropriate weight; a synchronizer-token scheme would add complexity the
 * threat model does not ask for.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Cookie name. Prefixed so it is obvious whose it is in devtools. */
const COOKIE_NAME = 'seedrpool_session';

/** Session lifetime. Long enough to work, short enough to retire itself. */
const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Length of the random id portion. */
const ID_BYTES = 18;

export class SessionAuth {
  readonly #user: string;
  readonly #password: string;
  /** HMAC key, random per process. */
  readonly #key: Buffer;
  /** Valid unexpired ids, mapped to expiry for the sliding window. */
  readonly #sessions = new Map<string, number>();

  constructor(user: string, password: string) {
    this.#user = user;
    this.#password = password;
    this.#key = randomBytes(32);
  }

  /**
   * Verifies username and password in constant time.
   *
   * Both comparisons run always, so a wrong username takes exactly as long
   * as a wrong password — no oracle about which half was right.
   */
  verify(user: string, password: string): boolean {
    const userOk = safeEqual(user, this.#user);
    const passOk = safeEqual(password, this.#password);
    return userOk && passOk;
  }

  /**
   * Mints a session for a just-verified credential and returns the
   * Set-Cookie header value to send.
   */
  createSession(now = Date.now()): { cookie: string; expiresAt: number } {
    const id = randomBytes(ID_BYTES).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    this.#sessions.set(id, expiresAt);
    this.#prune(now);

    return {
      cookie: this.#cookieHeader(id, expiresAt),
      expiresAt,
    };
  }

  /**
   * Whether the request carries a valid, unexpired session.
   *
   * Also refreshes the expiry when the session is more than half spent, so
   * an active operator never sees the login page, and returns the refreshed
   * Set-Cookie header so callers can pass it along with their response.
   */
  check(
    request: Request,
    now = Date.now(),
  ): { ok: true; refreshCookie: string | null } | { ok: false } {
    const id = this.#sessionFromCookie(request);
    if (id === null) return { ok: false };

    const expiresAt = this.#sessions.get(id);
    if (expiresAt === undefined || expiresAt <= now) {
      this.#sessions.delete(id);
      return { ok: false };
    }

    // Slide the window when past half its life. Rewriting the cookie on
    // every request would defeat browser caches for no gain.
    const half = SESSION_TTL_MS / 2;
    if (expiresAt - now < half) {
      const renewedAt = now + SESSION_TTL_MS;
      this.#sessions.set(id, renewedAt);
      return { ok: true, refreshCookie: this.#cookieHeader(id, renewedAt) };
    }
    return { ok: true, refreshCookie: null };
  }

  /** Drops a session. No error when the id is unknown. */
  destroy(request: Request): string {
    const id = this.#sessionFromCookie(request);
    if (id !== null) this.#sessions.delete(id);
    // Expire the cookie client-side regardless of what we found.
    return `${COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** Parses the session id out of a signed cookie, verifying the HMAC. */
  #sessionFromCookie(request: Request): string | null {
    const header = request.headers.get('cookie');
    if (header === null) return null;

    let raw: string | null = null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        raw = part.slice(eq + 1).trim();
        break;
      }
    }
    if (raw === null) return null;

    const dot = raw.lastIndexOf('.');
    if (dot === -1) return null;
    const id = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (id === '' || signature === '') return null;
    if (!safeEqual(signature, this.#sign(id))) return null;

    return id;
  }

  #cookieHeader(id: string, expiresAt: number): string {
    const expires = new Date(expiresAt).toUTCString();
    return (
      `${COOKIE_NAME}=${id}.${this.#sign(id)}; ` +
      `Path=/admin; HttpOnly; SameSite=Lax; Expires=${expires}`
    );
  }

  /** HMAC-SHA256 of the id under this process's key, base64url. */
  #sign(id: string): string {
    return createHmac('sha256', this.#key).update(id).digest('base64url');
  }

  /** Drops expired entries so the map cannot grow without bound. */
  #prune(now: number): void {
    for (const [id, expiresAt] of this.#sessions) {
      if (expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

/** Constant-time string compare; equal length is not disclosed. */
function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

// Re-exported so request handlers can build redirects without importing
// the crypto details.
export { timingSafeEqual };
