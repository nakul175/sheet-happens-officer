import { NextResponse, type NextRequest } from "next/server";
import { ApiError } from "@/lib/http";
import { RETURN_PATH_HEADER } from "@/lib/return-to";

/**
 * SHO-2725 (APL-2661 AC1). The apex and www names belong to the app, so this proxy answers them with a 301 to it.
 * The forwarder that used to hold the names answered HEAD with 405, which is why `curl -I` never showed the
 * redirect that GET gets. Answering here is method-independent: HEAD gets the same status and Location as GET.
 */
const APP_ORIGIN = "https://app.sheethappensofficer.com";
const APEX_HOSTS = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com"]);

/**
 * APL-2652. Records the path that was asked for so the app layout can send a
 * signed-out person to `/signin?next=…`. This does not decide who is signed in;
 * `currentUser()` in the layout still does that. A client-supplied header is replaced.
 *
 * A task document that this person cannot see is a real 404, answered here.
 * The app shell streams from a Suspense boundary, and a `notFound()` after that
 * has already started keeps status 200. Client navigations (the `rsc` header)
 * still render the task segment, which calls `notFound()` for the same screen.
 */
export async function proxy(request: NextRequest) {
  // SHO-2725: this runs for HEAD too, so an apex or www request never reaches a handler that only answers GET.
  const apex = apexRedirect(request);
  if (apex) return apex;
  const requestHeaders = new Headers(request.headers);
  // Pam's D10. Next rebuilds the proxy's URL with URLSearchParams, so a space in the query arrives as `+` in both
  // `request.url` and `nextUrl`. That serialiser writes a literal plus as `%2B`, so every `+` here is a space:
  // put back `%20`, which is how the query was sent (AC2 v1.5 keeps the query's encoding).
  const sent = new URL(request.url);
  const value = sent.pathname + sent.search.replace(/\+/g, "%20");
  // Off in production. `npm run dev` and the README's test server set RETURN_PATH_LOG=1 so the AC2 v1.6 check has the
  // forwarded return path in the server log.
  if (process.env.RETURN_PATH_LOG === "1") console.info(`[return-path] ${value}`);
  try {
    requestHeaders.set(RETURN_PATH_HEADER, value);
  } catch {
    requestHeaders.delete(RETURN_PATH_HEADER);
  }
  const unavailable = await taskDocumentUnavailable(request);
  if (unavailable) return unavailable;
  // No cookie. SIGNIN_RETURN_TO stays on the server; main sends no sho_return_to cookie either.
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * SHO-2725. Apex and www answer 301 to the app on every method, HEAD included, so `curl -I` shows the same status
 * and Location as GET. The path and query are kept, so an apex deep link lands on the same screen. The app and the
 * staging names are not in APEX_HOSTS, so their answers are unchanged.
 */
function apexRedirect(request: NextRequest): NextResponse | null {
  if (!APEX_HOSTS.has(hostnameOf(request))) return null;
  // Setters, not `new URL(request.nextUrl.pathname, APP_ORIGIN)`: a path that begins `//` would otherwise become
  // another host, turning the redirect into an open redirect.
  const target = new URL(APP_ORIGIN);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  return new NextResponse(null, { status: 301, headers: { location: target.toString() } });
}

/** The name the client asked for: the first forwarded name, without a port, the root dot or case. */
function hostnameOf(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const raw = forwarded || request.headers.get("host") || request.nextUrl.host || request.nextUrl.hostname;
  return raw.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

/** A flight request. Those render the task segment; only a document needs the status fixed here. */
function isFlight(request: NextRequest) {
  const h = request.headers;
  return h.get("rsc") === "1"
    || h.has("next-router-prefetch")
    || h.has("next-router-segment-prefetch")
    || h.has("next-router-state-tree")
    || request.nextUrl.searchParams.has("_rsc");
}

async function taskDocumentUnavailable(request: NextRequest): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (isFlight(request)) return null;
  const id = /^\/tasks\/([^/]+)$/.exec(request.nextUrl.pathname)?.[1];
  if (!id) return null;
  const { SESSION_COOKIE, sessionUser } = await import("@/lib/auth");
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let user;
  try {
    user = await sessionUser(token, { allowTempPassword: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
  // The password wall replaces every page. A 404 here would hide that screen.
  if (user.tempPasswordAt) return null;
  const { assertTaskReadable, TASK_UNAVAILABLE_HTML } = await import("@/lib/task-access");
  try {
    await assertTaskReadable({ id: user.id, orgRole: user.orgRole }, id);
    return null;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  return new NextResponse(request.method === "HEAD" ? null : TASK_UNAVAILABLE_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}

export const config = {
  // SHO-2725. Every path that is not a Next asset or an API route reaches the proxy, including one that contains a
  // dot. The old matcher also skipped `.*\..*` and `favicon.ico`, so an apex or www request for `/logo-icon.svg` or
  // `/tasks/a.b` never reached `apexRedirect` and the app answered it with 200 on the wrong host instead of the 301
  // every other apex path gets. On the app those files still pass through: the proxy only adds a request header.
  matcher: ["/((?!api|_next/static|_next/image).*)"],
};
