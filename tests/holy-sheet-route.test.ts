import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), sessionId: vi.fn(), task: vi.fn(), session: vi.fn(), active: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user, currentSessionId: mocks.sessionId }));
vi.mock("@/lib/tasks", () => ({ getTask: mocks.task }));
vi.mock("@/lib/db", () => ({ db: {session: { findUnique: mocks.session }} }));
vi.mock("@/lib/central-status", () => ({ centralSessionActive: mocks.active }));
import { GET } from "../src/app/api/tasks/[id]/holy-sheet/route";
import { ApiError } from "../src/lib/http";
const run = () => GET(new Request("https://sho.test/api/tasks/task-a/holy-sheet"), {params: Promise.resolve({id: "task-a"})});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("FF_HOLY_SHEET", "1"); vi.stubEnv("HOLY_SHEET_ORIGIN", "https://staging.holysheet.aplyd.org");
  mocks.user.mockResolvedValue({id: "native-user"}); mocks.sessionId.mockResolvedValue("session-a");
  mocks.session.mockResolvedValue({ userId: "native-user", revokedAt: null, expiresAt: new Date(Date.now()+60000), centralLink: {subject: "accounts-sub", sessionUid: "central-session"}});
  mocks.active.mockResolvedValue(true);
});
it("returns the verified central subject, never the native user id", async () => {
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({origin: "https://staging.holysheet.aplyd.org", subject: "accounts-sub"});
  expect(mocks.task).toHaveBeenCalledWith({id: "native-user"}, "task-a");
  expect(mocks.active).toHaveBeenCalledWith("accounts-sub", "central-session", "native-user");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("checks task access before reading central context", async () => {
  mocks.task.mockRejectedValue(new ApiError(404,"Task not found"));
  expect((await run()).status).toBe(404); expect(mocks.session).not.toHaveBeenCalled();
});
it("refuses native-only and revoked central sessions", async () => {
  mocks.session.mockResolvedValueOnce({userId: "native-user", revokedAt: null, expiresAt: new Date(Date.now()+60000), centralLink: null});
  expect((await run()).status).toBe(401);
  mocks.active.mockResolvedValue(false); expect((await run()).status).toBe(401);
});
it("stays unavailable when the flag is off", async () => {
  vi.stubEnv("FF_HOLY_SHEET", "0"); expect((await run()).status).toBe(404); expect(mocks.user).not.toHaveBeenCalled();
});
