import { afterEach, expect, it, vi } from "vitest";
import { restorePoolPerson, runCleanup } from "./e2e/helpers/qa-cleanup";
afterEach(() => vi.restoreAllMocks());
it("qa:TC missing SHO-2915: a failed Team read reports only a fixed label and HTTP status", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const api = { get: vi.fn(async () => ({ status: 503, json: {} })), post: vi.fn(), patch: vi.fn() };
  await restorePoolPerson(api, "fixture-person");
  expect(warn).toHaveBeenCalledExactlyOnceWith("[qa-alias] Cannot restore pool person: Team read failed", 503);
  expect(api.post).not.toHaveBeenCalled(); expect(api.patch).not.toHaveBeenCalled();
});
it("qa:TC missing SHO-2915: reactivates and restores Member through the same API routes", async () => {
  const api = { get: vi.fn(async () => ({ status: 200, json: { person: { status: "DEACTIVATED", orgRole: "ADMIN" } } })), post: vi.fn(async () => ({ status: 200 })), patch: vi.fn(async () => ({ status: 200 })) };
  await restorePoolPerson(api, "fixture-person");
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/team/fixture-person/reactivate");
  expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/team/fixture-person", { orgRole: "MEMBER" });
});
it("qa:TC missing SHO-2915: a failed role restore reaches best-effort cleanup diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const api = { get: vi.fn(async () => ({ status: 200, json: { person: { status: "ACTIVE", orgRole: "ADMIN" } } })), post: vi.fn(), patch: vi.fn(async () => ({ status: 500 })) };
  await runCleanup([() => restorePoolPerson(api, "fixture-person")]);
  expect(warn).toHaveBeenCalledOnce();
  expect(api.patch).toHaveBeenCalledOnce();
});
it("qa:TC missing SHO-2915: cleanup continues in reverse order and never prints thrown credentials", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), order: string[] = [];
  const callbacks = [async () => { order.push("context"); }, async () => { order.push("restore"); throw new Error("password=sensitive-password token=sensitive-token"); }, async () => { order.push("archive"); }];
  await runCleanup(callbacks);
  expect(order).toEqual(["archive", "restore", "context"]);
  expect(warn).toHaveBeenCalledExactlyOnceWith("[story-cleanup] Cleanup failed; continuing remaining cleanup (details omitted to protect credentials)");
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sensitive-password|sensitive-token/);
  expect(callbacks).toHaveLength(3);
});
it("qa:TC missing SHO-2915: successful cleanup emits no warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runCleanup([async () => {}]);
  expect(warn).not.toHaveBeenCalled();
});
