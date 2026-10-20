import { NextResponse, type NextRequest } from "next/server";
import { ApiError } from "@/lib/http";
import { RETURN_PATH_HEADER } from "@/lib/return-to";

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
  const requestHeaders = new Headers(request.headers);
  // Pam's D10. Next rebuilds the proxy's URL with URLSearchParams, so a space in the query arrives as `+` in both
  // `request.url` and `nextUrl`. That serialiser writes a literal plus as `%2B`, so every `+` here is a space:
  // put back `%20`, which is how the query was sent (AC2 v1.5 keeps the query's encoding).
  const sent = new URL(request.url);
  const value = sent.pathname + sent.search.replace(/\+/g, "%20");
  // Off by default. CI's test server turns it on so the AC2 v1.6 check has the forwarded return path in server.log.
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
  // Pages only. API routes, Next assets and files with an extension (logo, favicon) are left alone.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
