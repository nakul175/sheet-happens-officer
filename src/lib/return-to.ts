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
const MAX_DECODES = 5;

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

/** Every decode of `value`, or null when a layer is dangerous, malformed, or still encoded after the cap. `priorDecodes` is a decode that already happened, such as the router reading the query. */
function decodeAll(value: string, priorDecodes = 0): string[] | null {
  const budget = MAX_DECODES - priorDecodes;
  if (budget < 0) return null;
  const layers = [value];
  let current = value;
  for (let i = 0; i < budget; i++) {
    if (isDangerous(current)) return null;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return layers;
    current = next;
    layers.push(current);
  }
  // Decodes up to the cap are allowed when the result is fully decoded. One more encoding is rejected.
  if (isDangerous(current)) return null;
  try {
    if (decodeURIComponent(current) !== current) return null;
  } catch {
    return null;
  }
  return layers;
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
 * `priorDecodes` counts a decode that already happened. The sign-in page passes 1 because the router decoded the query.
 */
export function safeReturnPath(input: string | null | undefined, priorDecodes = 0): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > MAX_LENGTH) return null;
  const layers = decodeAll(raw, priorDecodes);
  if (!layers) return null;
  for (const layer of layers) {
    if (!originStays(layer)) return null;
  }
  const final = layers[layers.length - 1];
  if (!final.startsWith("/") || final.startsWith("//") || final.startsWith("/\\")) return null;
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
  const safe = safeReturnPath(from);
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
