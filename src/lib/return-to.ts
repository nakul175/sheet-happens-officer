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
 * APL-2652 off switch. Unset means on.
 * `off`, `false`, `no` and `0` restore today's sign-in: no `next`, no `expired`, a 401 goes to `/signin`.
 * Read at call time so a test can flip it without restarting the process.
 */
export function returnToEnabled(): boolean {
  const raw = process.env.SIGNIN_RETURN_TO;
  if (raw == null || raw.trim() === "") return true;
  return !/^(0|off|false|no)$/i.test(raw.trim());
}

/** The browser copy of the flag. The proxy sets `sho_return_to`; otherwise the env var applies. */
export function returnToActive(): boolean {
  if (typeof document !== "undefined") {
    const match = /(?:^|; )sho_return_to=([01])(?:;|$)/.exec(document.cookie);
    if (match) return match[1] === "1";
  }
  return returnToEnabled();
}

/** Request header set by `src/proxy.ts` to the path that was asked for. The layout overwrites any client-supplied value by reading it only after the proxy replaces it. */
export const RETURN_PATH_HEADER = "x-sho-return-path";

function isDangerous(value: string): boolean {
  if (/[\\\u0000-\u001F\u007F\u2028\u2029]/.test(value)) return true;
  if (value.startsWith("//") || value.startsWith("\\")) return true;
  // A scheme (`https:`, `javascript:`) at the start is an absolute URL, not a path.
  if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(value)) return true;
  return false;
}

/** Every decode of `value`, or null when a layer is dangerous, malformed, or still encoded after the cap. */
function decodeAll(value: string): string[] | null {
  const layers = [value];
  let current = value;
  for (let i = 0; i < MAX_DECODES; i++) {
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
  return null;
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
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001F\u007F]/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * A same-origin path (`/tasks/T1`, optionally with a query or hash), or null.
 * Null means "send them home": the value is missing, empty, or not a safe path.
 */
export function safeReturnPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > MAX_LENGTH) return null;
  const layers = decodeAll(raw);
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
  if (!returnToEnabled()) return "/signin";
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
  if (!returnToEnabled()) return "/signin";
  if (isSignInScreen(pathname)) return null;
  return signInHref(`${pathname}${search}`, { expired: true });
}

/** Where a signed-out document request goes. Flag off is plain `/signin`, the same as main. */
export function signedOutSignInHref(from: string | null | undefined): string {
  if (!returnToEnabled()) return "/signin";
  const href = signInHref(from);
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || href.includes("://")) return "/signin";
  return href;
}
