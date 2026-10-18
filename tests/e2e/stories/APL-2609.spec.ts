// SHO-BUG-2 CRM_VISIBLE hides deals on My tasks, search, task routes and the concierge (APL-2609).
// Staging runs one CRM_VISIBLE value and a browser cannot change it. These checks run the lever
// functions from src/lib/access.ts in this process and put the variable back. No account is signed in
// and no ZZ-TEST row is created, so there is nothing to clean up. Nothing here is pointed at production.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, expect } from "../support";

type Person = { orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN" };
type Where = { typeId?: { not: string } };
type Lever = {
  crmMode: () => "all" | "admins" | "off";
  crmVisible: (user: Person) => boolean;
  crmProjectWhere: (user: Person) => Where;
  WORKSTREAM_DEAL: string;
};

function productLever(): Lever {
  const src = readFileSync("src/lib/access.ts", "utf8");
  const start = src.indexOf("export const isAdmin");
  const end = src.indexOf("/**\n * Loads a project");
  if (start < 0 || end < 0) throw new Error("CRM lever is not in src/lib/access.ts");
  let code = src.slice(start, end);
  code = code.replace(/^export type .*$/gm, "");
  code = code.replace(/^export /gm, "");
  code = code.replaceAll(": CrmMode", "");
  code = code.replaceAll(': Pick<Actor, "orgRole">', "");
  code = code.replaceAll(": Prisma.ProjectWhereInput", "");
  code = code.replace("(u: { orgRole: OrgRole })", "(u)");
  const context = vm.createContext({ process });
  vm.runInContext(`${code}\nthis.api = { crmMode, crmVisible, crmProjectWhere, WORKSTREAM_DEAL };`, context);
  return (context as { api: Lever }).api;
}

const lever = productLever();
const { crmMode, crmVisible, crmProjectWhere, WORKSTREAM_DEAL } = lever;
const member: Person = { orgRole: "MEMBER" };
const admin: Person = { orgRole: "ADMIN" };
const root: Person = { orgRole: "SUPER_ADMIN" };
const hidden = () => ({ typeId: { not: WORKSTREAM_DEAL } });

function withMode<T>(mode: string, fn: () => T): T {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

const tasks = readFileSync("src/lib/tasks.ts", "utf8");
const myTasks = tasks.slice(tasks.indexOf("export async function myTasks"), tasks.indexOf("async function waitingSince"));
const access = readFileSync("src/lib/access.ts", "utf8");
const search = readFileSync("src/lib/search.ts", "utf8");
const reads = readFileSync("src/lib/concierge/reads.ts", "utf8");
const visibleProjects = reads.slice(reads.indexOf("export const visibleProjects"), reads.indexOf("const myProjects"));
const myProjects = reads.slice(reads.indexOf("const myProjects"), reads.indexOf("const byProjectThenDue"));

test("AC1: with CRM_VISIBLE=off, My tasks leaves out a member's deal tasks and stages", () => {
  withMode("off", () => {
    expect(crmMode()).toBe("off");
    expect(crmVisible(member)).toBe(false);
    expect(crmProjectWhere(member)).toEqual(hidden());
  });
  expect(myTasks).toContain('type: t.project.typeId === "wst_deal" ? "DEAL" : "PROJECT"');
  expect(myTasks).toContain("stage: t.project.stage?.name ?? null");
  const openWork = myTasks.slice(0, myTasks.indexOf("previousAssigneeId"));
  expect(openWork).toContain("...crmProjectWhere(user)");
  // Handed-off tasks ("waiting on others") are part of My tasks and carry the deal name and stage.
  // APL-2713: this query does not spread the filter, so the assertion fails until that bug is fixed.
  const waiting = myTasks.slice(myTasks.indexOf("previousAssigneeId"));
  expect(waiting).toContain("...crmProjectWhere(user)");
});

test("AC2: with CRM_VISIBLE=off, search returns no deal and no deal task", () => {
  withMode("off", () => {
    expect(crmProjectWhere(member)).toEqual(hidden());
    expect(crmVisible(member)).toBe(false);
  });
  expect(search).toContain("...crmProjectWhere(user)");
  expect(search).toContain("project: visible");
  expect(search).toContain("const crm = crmVisible(user)");
  expect(search).toContain("crm && !ideasOnly");
});

test("AC3: with CRM_VISIBLE=off, a deal task and the deal's task list are not found", () => {
  withMode("off", () => {
    expect(crmVisible(member)).toBe(false);
    expect(crmVisible(admin)).toBe(false);
    expect(crmVisible(root)).toBe(false);
  });
  const getTask = tasks.slice(tasks.indexOf("export async function getTask"), tasks.indexOf("export async function listTasks"));
  const load = tasks.slice(tasks.indexOf("async function loadTask"), tasks.indexOf("export const ORDER"));
  const list = tasks.slice(tasks.indexOf("export async function listTasks"), tasks.indexOf("/** Scheduled job:"));
  expect(getTask).toContain("loadTask(user, id)");
  expect(load).toContain("projectAccess(user, t.projectId");
  expect(list).toContain("projectAccess(user, projectId)");
  expect(access).toContain('if (project.typeId === WORKSTREAM_DEAL && !crmVisible(user)) throw notFound("Project")');
});

test("AC4: with CRM_VISIBLE=off, the concierge does not read the member's deals or deal tasks", () => {
  withMode("off", () => expect(crmProjectWhere(member)).toEqual(hidden()));
  expect(visibleProjects).toContain("...crmProjectWhere(user)");
  expect(myProjects).toContain("...crmProjectWhere(user)");
  expect(reads).toContain("project: myProjects(user)");
  expect(reads).toContain("...visibleProjects(user)");
});

test("AC5: with CRM_VISIBLE=admins, an Editor sees no deal data on those surfaces", () => {
  withMode("admins", () => {
    expect(crmMode()).toBe("admins");
    expect(crmVisible(member)).toBe(false);
    expect(crmProjectWhere(member)).toEqual(hidden());
  });
});

test("AC6: with CRM_VISIBLE=admins, an Admin and the Super Admin still see deals", () => {
  withMode("admins", () => {
    expect(crmVisible(admin)).toBe(true);
    expect(crmVisible(root)).toBe(true);
    expect(crmProjectWhere(admin)).toEqual({});
    expect(crmProjectWhere(root)).toEqual({});
  });
});

test("AC7: with CRM_VISIBLE=all, every member still sees deals", () => {
  withMode("all", () => {
    expect(crmMode()).toBe("all");
    for (const person of [member, admin, root]) {
      expect(crmVisible(person)).toBe(true);
      expect(crmProjectWhere(person)).toEqual({});
    }
  });
  expect(crmMode()).toBe("all");
});

test("AC8: off hides deals from Admins and the Super Admin too; admins mode keeps Admins in", () => {
  withMode("off", () => {
    expect(crmVisible(admin)).toBe(false);
    expect(crmVisible(root)).toBe(false);
    expect(crmProjectWhere(admin)).toEqual(hidden());
    expect(crmProjectWhere(root)).toEqual(hidden());
  });
  withMode("admins", () => {
    expect(crmVisible(admin)).toBe(true);
    expect(crmVisible(root)).toBe(true);
    expect(crmVisible(member)).toBe(false);
  });
});
