import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), projectWrite: vi.fn(), taskWrite: vi.fn(), logWrite: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { ageLocalStalledDeals, assertStalledFixtureTarget } from "./local-stalled-clock-2902";
const ids = ["one", "two", "three"], tag = "run-123456";
const rows = () => ids.map(id => ({ id, name: `ZZ-TEST deal ${tag}`, archivedAt: null, tasks: [{ title: `ZZ-TEST next ${tag}` }] }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/sho_test?schema=test2902");
  vi.stubEnv("TASKBOARD_URL", "http://localhost:3100");
  mocks.findMany.mockResolvedValue(rows());
  mocks.transaction.mockImplementation(async fn => fn({ project: { findMany: mocks.findMany, updateMany: mocks.projectWrite }, task: { updateMany: mocks.taskWrite }, actionLog: { updateMany: mocks.logWrite } }));
});
afterEach(() => vi.unstubAllEnvs());
describe("qa:TC missing SHO-2902 guarded local fixture backdating", () => {
  it.each([
    ["postgresql://test:test@remote.example/sho_test", "http://localhost:3100"],
    ["postgresql://test:test@localhost/production", "http://localhost:3100"],
    ["postgresql://test:test@localhost/sho_test", "https://sheethappensofficer.aplyd.org"],
    ["https://localhost/sho_test", "http://localhost:3100"],
  ])("qa:TC missing refuses a non-test target before transaction %#", async (database, api) => {
    vi.stubEnv("DATABASE_URL", database); vi.stubEnv("TASKBOARD_URL", api);
    await expect(ageLocalStalledDeals(ids, tag)).rejects.toThrow("localhost API and sho_test");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["host=remote.example", "hostaddr=203.0.113.1", "dbname=live", "options=-csearch_path%3Dlive", "schema=one&schema=two", "schema=public%3Bdrop", "HOST=remote.example"])("qa:TC missing refuses connection override %s before any database call", async query => {
    vi.stubEnv("DATABASE_URL", `postgresql://test:test@localhost/sho_test?${query}`);
    await expect(ageLocalStalledDeals(ids, tag)).rejects.toThrow("database target overrides");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("qa:TC missing accepts IPv6 localhost without exposing URL credentials", () => {
    expect(() => assertStalledFixtureTarget("postgresql://test:secret@[::1]/sho_test", "http://[::1]:3100")).not.toThrow();
    expect(() => assertStalledFixtureTarget("not-a-url-secret", "http://localhost")).toThrow("Stalled fixtures require local test targets");
  });
  it.each([[], ["one", "one", "two"], ["one", "two", ""]].map(input => ({ input })))("qa:TC missing refuses an incomplete or duplicated world %#", async ({ input }) => {
    await expect(ageLocalStalledDeals(input, tag)).rejects.toThrow("Invalid stalled fixture identity");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["missing", "project", "task", "archived"])("qa:TC missing refuses %s fixture ownership before any write", async kind => {
    const data = rows();
    if (kind === "missing") data.pop();
    if (kind === "project") data[0].name = "Customer data";
    if (kind === "task") data[0].tasks[0].title = "Customer task";
    mocks.findMany.mockResolvedValue(kind === "archived" ? data.map(p => ({ ...p, archivedAt: new Date() })) : data);
    await expect(ageLocalStalledDeals(ids, tag)).rejects.toThrow("non-fixture data");
    expect(mocks.projectWrite).not.toHaveBeenCalled(); expect(mocks.taskWrite).not.toHaveBeenCalled(); expect(mocks.logWrite).not.toHaveBeenCalled();
  });
  it("qa:TC missing ages only the validated three projects and their children in one transaction", async () => {
    const before = Date.now();
    await ageLocalStalledDeals(ids, tag);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const project = mocks.projectWrite.mock.calls[0][0];
    expect(project.where).toEqual({ id: { in: ids } });
    expect(project.data.createdAt.getTime()).toBeGreaterThanOrEqual(before - 31 * 86400000);
    expect(project.data.createdAt.getTime()).toBeLessThanOrEqual(Date.now() - 31 * 86400000);
    expect(mocks.taskWrite).toHaveBeenCalledWith({ where: { projectId: { in: ids } }, data: { updatedAt: project.data.createdAt } });
    expect(mocks.logWrite).toHaveBeenCalledWith({ where: { projectId: { in: ids } }, data: { createdAt: project.data.createdAt } });
  });
});
