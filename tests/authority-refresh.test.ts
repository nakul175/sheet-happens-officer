// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTHORITY_INTERVAL_MS, watchAuthority } from "@/components/authority-refresh";
let stop: (() => void) | undefined;
const revision = (s: string) => new Response(JSON.stringify({ revision: s.repeat(64) }));
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { stop?.(); stop=undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it("first observation, grant, downgrade, revoke and regrant invalidate once per changed authority", async () => {
  const fetcher = vi.fn().mockResolvedValue(revision("a")); vi.stubGlobal("fetch", fetcher);
  const change = vi.fn(); stop=watchAuthority(change);
  await vi.advanceTimersByTimeAsync(1); expect(change).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(revision("a")); await vi.advanceTimersByTimeAsync(AUTHORITY_INTERVAL_MS); expect(change).toHaveBeenCalledTimes(1);
  for (const next of ["b", "c", "d", "c"]) {
    const before=change.mock.calls.length;
    fetcher.mockResolvedValue(revision(next)); await vi.advanceTimersByTimeAsync(AUTHORITY_INTERVAL_MS);
    expect(change).toHaveBeenCalledTimes(before+1);
  }
  expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
});
it("network/invalid answers do not invent grant or revoke, and focus recovers", async () => {
  const fetcher=vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch",fetcher);
  const change=vi.fn(); stop=watchAuthority(change); await vi.advanceTimersByTimeAsync(1);
  fetcher.mockResolvedValue(new Response('{"revision":"unknown"}')); await vi.advanceTimersByTimeAsync(AUTHORITY_INTERVAL_MS);
  expect(change).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(revision("a")); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(1);
  expect(change).toHaveBeenCalledTimes(1);
});
it("hidden tabs stop polling; one pending request is bounded and cleanup ignores late answers", async () => {
  let release!: (r: Response) => void;
  const fetcher=vi.fn().mockImplementation(() => new Promise<Response>(r=>{release=r;})); vi.stubGlobal("fetch",fetcher);
  const change=vi.fn(); stop=watchAuthority(change);
  window.dispatchEvent(new Event("focus")); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  stop(); release(revision("a")); await vi.advanceTimersByTimeAsync(1); expect(change).not.toHaveBeenCalled();
  Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
  stop=watchAuthority(change); await vi.advanceTimersByTimeAsync(20_000); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("denied sessions invalidate once and never expose a role", async () => {
  const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{}',{status:401})));vi.stubGlobal("fetch",fetcher);
  const change=vi.fn();stop=watchAuthority(change);await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(AUTHORITY_INTERVAL_MS);expect(change).toHaveBeenCalledTimes(1);
});
