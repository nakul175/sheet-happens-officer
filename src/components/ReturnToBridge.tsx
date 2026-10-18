"use client";

/**
 * APL-2652. The server renders this only when SIGNIN_RETURN_TO is on.
 * It tells this tab's client code (the 401 path and the sign-in submit) without a cookie,
 * and without local or session storage.
 */
export function ReturnToBridge() {
  if (typeof window !== "undefined") {
    (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO = 1;
  }
  return null;
}
