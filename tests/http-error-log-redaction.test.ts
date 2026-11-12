import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));
import { handle } from "@/lib/http";

afterEach(() => vi.restoreAllMocks());

it("unexpected 500s never log untrusted error names, codes or messages", async () => {
  const marker = "ZZ-TEST-PRIVATE-REQUEST-MARKER";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await handle(async () => {
    throw Object.assign(new Error(`message ${marker}`), { name: `name ${marker}`, code: `code ${marker}` });
  })();
  expect(response.status).toBe(500);
  const errorId = response.headers.get("x-error-id");
  expect(errorId).toMatch(/^[0-9a-f-]{36}$/);
  const body = await response.text();
  const lines = log.mock.calls.map((call) => call.join(" ")).join(" ");
  expect(body).not.toContain(marker);
  expect(lines).not.toContain(marker);
  expect(lines).toContain(`unexpected error UNKNOWN ${errorId}`);
  expect(body).not.toContain(errorId!);
});

it("separates unexpected requests and leaves mapped errors without a diagnostic ID", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = handle(async () => { throw Object.assign(new Error("private"), { code: "P2010" }); });
  const first = await run(), second = await run();
  const ids = [first.headers.get("x-error-id"), second.headers.get("x-error-id")];
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids[0]).not.toBe(ids[1]);
  expect(log.mock.calls.map((call) => call.join(" "))).toEqual(ids.map((id) => `unexpected error P2010 ${id}`));
  const mapped = await handle(async () => { throw Object.assign(new Error("private"), { code: "P2002" }); })();
  expect(mapped.status).toBe(409);
  expect(mapped.headers.has("x-error-id")).toBe(false);
});
