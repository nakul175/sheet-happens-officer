import { NextResponse, type NextRequest } from "next/server";
import { RETURN_PATH_HEADER } from "@/lib/return-to";

/**
 * APL-2652. Records the path that was asked for so the app layout can send a
 * signed-out person to `/signin?next=…`. This does not decide who is signed in;
 * `currentUser()` in the layout still does that. A client-supplied header is replaced.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const value = request.nextUrl.pathname + request.nextUrl.search;
  try {
    requestHeaders.set(RETURN_PATH_HEADER, value);
  } catch {
    requestHeaders.delete(RETURN_PATH_HEADER);
  }
  // No cookie. SIGNIN_RETURN_TO stays on the server; main sends no sho_return_to cookie either.
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Pages only. API routes, Next assets and files with an extension (logo, favicon) are left alone.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
