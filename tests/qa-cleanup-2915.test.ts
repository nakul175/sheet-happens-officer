import { afterEach, expect, it, vi } from "vitest";
import { restorePoolPerson, runCleanup } from "./e2e/helpers/qa-cleanup";
afterEach(() => vi.restoreAllMocks());
it("qa:TC missing SHO-2915: a failed Team read reports only a fixed label and HTTP status", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const api = { get: vi.fn(async () => ({ status: 503, json: {} })), post: vi.fn(), patch: vi.fn() };
  await expect(restorePoolPerson(api, "fixture-person")).rejects.toThrow("Pool person restoration could not verify the person");
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
  await expect(runCleanup([() => restorePoolPerson(api, "fixture-person")])).rejects.toThrow("1 cleanup callback failed");
  expect(warn).toHaveBeenCalledOnce();
  expect(api.patch).toHaveBeenCalledOnce();
});
it("qa:TC missing SHO-2915: cleanup continues in reverse order and never prints thrown credentials", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), order: string[] = [];
  const callbacks = [async () => { order.push("context"); }, async () => { order.push("restore"); throw new Error("password=sensitive-password token=sensitive-token"); }, async () => { order.push("archive"); }];
  await expect(runCleanup(callbacks)).rejects.toThrow("1 cleanup callback failed");
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
it("qa:TC missing SHO-2915: multiple teardown failures fail the test after every callback runs", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const order: string[] = [];
  const callbacks = [
    async () => { order.push("first"); throw new Error("password=first-secret"); },
    async () => { order.push("middle"); },
    async () => { order.push("last"); throw new Error("token=last-secret"); },
  ];
  const error = await runCleanup(callbacks).catch((reason: unknown) => reason);
  expect(order).toEqual(["last", "middle", "first"]);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("[story-cleanup] 2 cleanup callbacks failed (details omitted to protect credentials)");
  expect(JSON.stringify(warn.mock.calls) + (error as Error).message).not.toMatch(/first-secret|last-secret/);
});
