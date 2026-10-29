import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { cleanupReminderResources, reminderResources } from "./reminder-cleanup-2751";

it("qa:TC missing SHO-2751: reminder suites contain no direct database writes", () => {
  const write = /\bdb\.[A-Za-z]+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\bdb\.\$executeRaw(?:Unsafe)?\s*\(/;
  for (const name of ["jobs-reminders-crm.test.ts", "jobs-reminders-crm-server.mode.test.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    expect(source, `${name} must set up and isolate fixtures through HTTP APIs`).not.toMatch(write);
  }
});
it("qa:TC missing SHO-2769: reminder accounts use run-unique nakul17+ aliases", () => {
  const inProcess = readFileSync(fileURLToPath(new URL("jobs-reminders-crm.test.ts", import.meta.url)), "utf8");
  const server = readFileSync(fileURLToPath(new URL("jobs-reminders-crm-server.mode.test.ts", import.meta.url)), "utf8");

  expect(inProcess).toContain("`nakul17+zz-2729-${tag}-admin@aplyd.com`");
  expect(inProcess).toContain("`nakul17+zz-2729-${tag}-member@aplyd.com`");
  expect(server).toContain("`nakul17+zz-2729-server-${tag}-admin@aplyd.com`");
  expect(server).toContain("`nakul17+zz-2729-server-${tag}-member@aplyd.com`");
  expect(`${inProcess}\n${server}`).not.toMatch(/(?:zzmember|zzdealadmin)[.@]/i);
});
it("qa:TC missing SHO-2751/2769: only run-owned resources are cleaned through ordered API calls", async () => {
  const resources = reminderResources();
  resources.projects.push({ id: "zz-project", leaderId: "zz-person", archived: false });
  resources.people.push({ id: "zz-person", deactivated: false });
  resources.organisations.push({ id: "zz-org", archived: false });
  const post = vi.fn(async () => ({ status: 200 }));
  await cleanupReminderResources("root", post, resources);
  expect(post.mock.calls).toEqual([
    ["/api/projects/zz-project/members", { userId: "root", role: "EDITOR" }],
    ["/api/projects/zz-project/leader", { newLeaderId: "root", previousRole: "REMOVE", handoverTo: "root" }],
    ["/api/projects/zz-project/archive"],
    ["/api/team/zz-person/deactivate", { reassign: "leaders" }],
    ["/api/orgs/zz-org/archive", { archive: true }],
  ]);
  await cleanupReminderResources("root", post, resources);
  expect(post).toHaveBeenCalledTimes(5);
});
it("qa:TC missing SHO-2751/2769: a failed project cleanup does not hide failures or prevent other cleanup", async () => {
  const resources = reminderResources();
  resources.projects.push({ id: "zz-project", leaderId: "root", archived: false });
  resources.people.push({ id: "zz-person", deactivated: false });
  const post = vi.fn(async (path: string) => ({ status: path.endsWith("/archive") ? 503 : 200 }));
  await expect(cleanupReminderResources("root", post, resources)).rejects.toThrow("project cleanup failed");
  expect(resources.projects[0].archived).toBe(false);
  expect(resources.people[0].deactivated).toBe(true);
  post.mockResolvedValue({ status: 200 });
  await cleanupReminderResources("root", post, resources);
  expect(post.mock.calls.map(call => call[0])).toEqual(["/api/projects/zz-project/archive", "/api/team/zz-person/deactivate", "/api/projects/zz-project/archive"]);
});
it("qa:TC missing SHO-2751/2769: the shared cleanup owner is never deactivated", async () => {
  const resources = reminderResources(); resources.people.push({ id: "root", deactivated: false });
  const post = vi.fn(async () => ({ status: 200 }));
  await expect(cleanupReminderResources("root", post, resources)).rejects.toThrow("refusing to deactivate cleanup owner");
  expect(post).not.toHaveBeenCalled();
});
