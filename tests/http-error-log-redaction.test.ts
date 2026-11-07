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
  const body = await response.text();
  const lines = log.mock.calls.map((call) => call.join(" ")).join(" ");
  expect(body).not.toContain(marker);
  expect(lines).not.toContain(marker);
});
