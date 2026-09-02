/**
 * Small HTTP router built on the standard `Request`/`Response` types.
 *
 * Deliberately dependency-free: the Stremio protocol and admin pages need only
 * pattern matching, CORS, and basic auth.
 */

export interface RouteContext {
  request: Request;
  /** Named parameters captured from the path pattern. */
  params: Record<string, string>;
  url: URL;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  /** Segments, where `:name` captures a value. */
  segments: string[];
  handler: Handler;
  /** Adds permissive CORS, which the Stremio protocol requires. */
  cors: boolean;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: { cors?: boolean } = {}): this {
    this.#routes.push({
      method,
      segments: splitPath(pattern),
      handler,
      cors: options.cors ?? false,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: { cors?: boolean }): this {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern: string, handler: Handler, options?: { cors?: boolean }): this {
    return this.add('POST', pattern, handler, options);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = splitPath(url.pathname);

    // Stremio clients preflight addon routes, so answer OPTIONS generically.
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    let pathMatched = false;

    for (const route of this.#routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;

      const response = await route.handler({ request, params, url });
      return route.cors ? withCors(response) : response;
    }

    // 405 rather than 404 when the path exists but the verb is wrong.
    return new Response(pathMatched ? 'method not allowed' : 'not found', {
      status: pathMatched ? 405 : 404,
    });
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** Matches concrete segments against a pattern, returning captured params. */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
      continue;
    }
    if (p !== a) return null;
  }
  return params;
}

/** The Stremio protocol requires CORS allowing all origins on every route. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
}

/**
 * Re-exported from `core/assets.ts` so route handlers can serve cached
 * static assets without importing the assets module directly.
 */
export { serveAsset } from './assets.ts';

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/**
 * Verifies HTTP basic auth in constant time.
 *
 * Returns null when authorized, or a 401 challenge otherwise. An empty expected
 * password disables the check, which is only acceptable on loopback.
 */
export function requireBasicAuth(
  request: Request,
  user: string,
  password: string,
): Response | null {
  if (password === '') return null;

  const header = request.headers.get('Authorization') ?? '';
  const [scheme, encoded] = header.split(' ');

  if (scheme?.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const suppliedUser = decoded.slice(0, separator);
      const suppliedPassword = decoded.slice(separator + 1);
      if (timingSafeEqual(suppliedUser, user) && timingSafeEqual(suppliedPassword, password)) {
        return null;
      }
    }
  }

  return new Response('authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SeedrPool", charset="UTF-8"' },
  });
}

/** Length-independent comparison, to avoid leaking secrets through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  // Compare hashes so differing lengths do not short-circuit.
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}
