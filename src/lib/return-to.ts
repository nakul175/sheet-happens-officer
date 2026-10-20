/**
 * APL-2652. Where a person may land after they sign in.
 *
 * Only a same-origin relative path is allowed. Absolute URLs, protocol-relative
 * URLs (`//host`), backslashes (browsers treat `\` as `/`) and percent-encoded
 * forms of those are rejected, so `next` cannot be an open redirect.
 * `redirect()` will follow an absolute URL, so every value we hand it is built here.
 */

const BASE = "http://return.invalid";
const MAX_LENGTH = 2048;
// Michael's ruling on APL-2652: decode once. `R%26D` stays `R&D` in the query, `C%2B%2B` stays `C++`, `100%25` stays `100%`.
const MAX_DECODES = 1;

/**
 * APL-2652 off switch. Unset means off.
 * Only `1` or `on` enables the return path. Anything else, including empty, matches main.
 * Read at call time so a test can flip it without restarting the process.
 * A tab the server rendered with the flag on sets `window.__SHO_RETURN_TO` (not a cookie).
 */
export function returnToEnabled(): boolean {
  if (typeof window !== "undefined" && (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO === 1) return true;
  const raw = process.env.SIGNIN_RETURN_TO?.trim().toLowerCase();
  return raw === "1" || raw === "on";
}

/** Request header set by `src/proxy.ts` to the path that was asked for. The layout overwrites any client-supplied value by reading it only after the proxy replaces it. */
export const RETURN_PATH_HEADER = "x-sho-return-path";

/** Space, tab, and the other whitespace a return path must not carry. `%20` decodes to a space. */
const WHITESPACE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

function isDangerous(value: string): boolean {
  if (WHITESPACE.test(value)) return true;
  if (/[\\\u0000-\u001F\u007F]/.test(value)) return true;
  // Protocol-relative `//` and a backslash, including after a prefix. Browsers treat `\` as `/`.
  if (value.includes("//") || value.includes("\\")) return true;
  // A scheme (`https:`, `javascript:`) at the start is an absolute URL, not a path.
  if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(value)) return true;
  return false;
}

/**
 * `value` and its one decode, or null when a layer is dangerous or malformed. The one decode includes `priorDecodes`,
 * such as the router reading the query, so a value that was already decoded is not decoded again (APL-2652 D1).
 */
function decodeOnce(value: string, priorDecodes = 0): string[] | null {
  const layers = [value];
  let current = value;
  for (let i = priorDecodes; i < MAX_DECODES; i++) {
    if (isDangerous(current)) return null;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) break;
    current = next;
    layers.push(current);
  }
  return isDangerous(current) ? null : layers;
}

function originStays(value: string): boolean {
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE && url.hostname === "return.invalid" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function canonicalPath(value: string): string | null {
  try {
    const url = new URL(value, BASE);
    if (url.origin !== BASE || url.hostname !== "return.invalid" || url.username !== "" || url.password !== "") return null;
    // AC1: the fragment is not part of the return path. The browser never sent it.
    const path = `${url.pathname}${url.search}`;
    // The URL parser re-encodes a space as `%20`. That is still whitespace, so it is not a safe path.
    if (!path.startsWith("/") || path.includes("//") || path.includes("\\") || WHITESPACE.test(path) || /%(?:20|09|0a|0d)/i.test(path) || /[\u0000-\u001F\u007F]/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * A same-origin path (`/tasks/T1`, optionally with a query), or null.
 * A fragment is dropped.
 * Null means "send them home": the value is missing, empty, or not a safe path.
 * `priorDecodes` counts a decode that already happened. Pass 1 for the sign-in page's `next` (the router decoded it) and
 * for a path taken from a URL as it stands (`location`, the proxy header, a path this function already returned).
 */
export function safeReturnPath(input: string | null | undefined, priorDecodes = 0): string | null {
  if (typeof input !== "string") return null;
  // AC2: leading or trailing whitespace (`%20/tasks/T1`, `?a=%0D%0A`) is not trimmed away. It is not a safe path.
  if (input !== input.trim()) return null;
  const raw = input;
  if (!raw || raw.length > MAX_LENGTH) return null;
  const layers = decodeOnce(raw, priorDecodes);
  if (!layers) return null;
  for (const layer of layers) {
    if (!originStays(layer)) return null;
  }
  const final = layers[layers.length - 1];
  if (!final.startsWith("/") || final.startsWith("//") || final.startsWith("/\\")) return null;
  // A path still encoded after the one decode falls back to the home page. The query keeps its encoding: it is data.
  if ((final.split(/[?#]/)[0] ?? final).includes("%")) return null;
  const path = canonicalPath(final);
  if (!path) return null;
  // A page path only. /api and /signin are not places sign-in should send someone.
  const pathname = path.split(/[?#]/)[0] ?? path;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  if (pathname === "/signin" || pathname.startsWith("/signin/")) return null;
  return path;
}

/**
 * The sign-in URL that comes back to `from` when that path is safe.
 * Anything else is plain `/signin`, which signs in to the home page.
 * `expired` adds `expired=1` so the screen can say the session ended (APL-2652).
 * The result is always a relative `/signin` URL, never an absolute or protocol-relative one.
 */
export function signInHref(from: string | null | undefined, opts?: { expired?: boolean }): string {
  if (!returnToEnabled()) return legacySignInHref();
  const params = new URLSearchParams();
  if (opts?.expired) params.set("expired", "1");
  // `from` is a path from a URL as it stands, so it is not decoded again.
  const safe = safeReturnPath(from, 1);
  if (safe && safe !== "/") params.set("next", safe);
  const q = params.toString();
  const href = q ? `/signin?${q}` : "/signin";
  if (!href.startsWith("/signin") || href.startsWith("//") || href.includes("\\") || href.includes("://")) {
    return opts?.expired ? "/signin?expired=1" : "/signin";
  }
  return href;
}

/** True on the sign-in screen, including a trailing slash. A 401 there must not navigate. */
export function isSignInScreen(pathname: string): boolean {
  return pathname === "/signin" || pathname === "/signin/";
}

/**
 * Where a 401 sends the browser (APL-2652). Null on `/signin` and `/signin/`, so that
 * screen is not reloaded and its query is left alone.
 * Otherwise `/signin?expired=1` plus a safe return path.
 */
export function sessionSignInTarget(pathname: string, search = ""): string | null {
  if (!returnToEnabled()) return legacySignInHref();
  if (isSignInScreen(pathname)) return null;
  return signInHref(`${pathname}${search}`, { expired: true });
}

/** Main's 401 target: `/signin` with no query. A function so the client assignment is not a string literal. */
export function legacySignInHref(): string {
  return "/signin";
}

/** Where a signed-out document request goes. Flag off is plain `/signin`, the same as main. */
export function signedOutSignInHref(from: string | null | undefined): string {
  if (!returnToEnabled()) return legacySignInHref();
  const href = signInHref(from);
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || href.includes("://")) return "/signin";
  return href;
}
