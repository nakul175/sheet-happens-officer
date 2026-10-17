"use client";

/** SHO-US-10.3: autofocus only with a mouse; on touch it pops the keyboard open and shifts the page. */
export function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export const PENDING_EMAIL_KEY = "sho_pending_email";

export function rememberEmail(email: string) {
  try { sessionStorage.setItem(PENDING_EMAIL_KEY, email); } catch { /* private mode: screens still work */ }
}
export function recalledEmail(): string {
  try { return sessionStorage.getItem(PENDING_EMAIL_KEY) ?? ""; } catch { return ""; }
}

export type ApiResult = { ok: boolean; status: number; error?: string; data?: Record<string, unknown> };

/** POST JSON to the API. Reads the first validation message when the server sends several. */
export async function post(path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : undefined;
    const error = res.ok ? undefined : (data?.issues?.[0]?.message as string | undefined) ?? (data?.error as string | undefined) ?? "Something went wrong. Try again.";
    return { ok: res.ok, status: res.status, error, data };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again." };
  }
}
