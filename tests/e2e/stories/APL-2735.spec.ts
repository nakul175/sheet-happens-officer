/**
 * @vitest-environment jsdom
 */
// APL-2735. The team page deactivate dialog shows the 409 text inline (role="alert"), not as a toast.
// The person page does not call deactivate. A caller who can see the CRM sees the deal names.
// A caller who cannot (an Admin while CRM_VISIBLE=off) sees the generic sentence and no deal name.
// workers=1. Production hosts are refused. ZZ-TEST names, nakul17+ aliases. afterAll archives and deactivates.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Team from "@/app/(app)/team/Team";
import { assertStoryTargetAllowed } from "../base-url";
import { account, istDate, superAdmin, type Account } from "../../helpers";

assertStoryTargetAllowed();

const harness = vi.hoisted(() => ({
  me: { id: "admin", name: "ZZ-TEST admin", email: "nakul17+zz-2735-admin@aplyd.com", orgRole: "ADMIN" as const },
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  usePathname: () => "/team",
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return { ...actual, useMe: () => harness.me };
});

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const GENERIC = "Name a new Leader first.";
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];
const rootDir = process.cwd();

let root: Root | undefined;
let offPid: number | undefined;
let offBase = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function killGroup(pid: number | undefined) {
  if (!pid || pid === process.pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitForHealth(port: number, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CRM_VISIBLE=off server exited ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CRM_VISIBLE=off server did not answer on port ${port}`);
}

/** A second production server so the dialog can be opened while the CRM is off. */
async function startOffServer() {
  if (!existsSync(path.join(rootDir, ".next", "BUILD_ID"))) {
    throw new Error("CRM_VISIBLE=off UI server cannot start: the production build is missing (.next/BUILD_ID)");
  }
  const port = await freePort();
  const log = path.join("/tmp", `sho-2735-off-${port}.log`);
  const logFd = openSync(log, "a");
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: rootDir,
    env: { ...process.env, CRM_VISIBLE: "off", PORT: String(port), APP_URL: `http://127.0.0.1:${port}` },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  try {
    await waitForHealth(port, child);
  } catch (err) {
    killGroup(child.pid);
    const tail = existsSync(log) ? readFileSync(log, "utf8").slice(-500) : "";
    throw new Error(`${err instanceof Error ? err.message : "CRM_VISIBLE=off server cannot start"}${tail ? `\n${tail}` : ""}`);
  }
  if (!child.pid) throw new Error("CRM_VISIBLE=off server cannot start");
  offPid = child.pid;
  offBase = `http://127.0.0.1:${port}`;
}

async function zzAccount(role: string) {
  const n = seq++;
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
  const email = `nakul17+zz-2735-ui-${RUN}-${slug}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

function closePage() {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
}

/** Renders the team page against one server, signed in as `who`. */
async function openTeam(base: string, who: Account) {
  harness.me = { id: who.id, name: who.name, email: who.email, orgRole: "ADMIN" };
  const real = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = raw.startsWith("/") ? base + raw : raw;
    const headers = new Headers(typeof input === "string" || input instanceof URL ? init?.headers : input.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (raw.startsWith("/") && who.c.cookie) headers.set("cookie", who.c.cookie);
    return real(url, { ...init, headers });
  });
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Team)); });
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    if ([...document.querySelectorAll("button")].some((b) => b.textContent === "Deactivate")) return document.body;
  }
  throw new Error(`Team page did not offer Deactivate. ${document.body.textContent?.slice(0, 400)}`);
}

async function deactivateDialog(leaderName: string) {
  const row = [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(leaderName));
  expect(row, leaderName).toBeTruthy();
  const open = [...row!.querySelectorAll("button")].find((b) => b.textContent === "Deactivate");
  expect(open, "row Deactivate").toBeTruthy();
  await act(async () => { open!.click(); });
  const dialog = document.querySelector("[role=dialog]");
  expect(dialog, "deactivate dialog").toBeTruthy();
  const yes = [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Deactivate");
  expect(yes, "confirm Deactivate").toBeTruthy();
  await act(async () => { yes!.click(); });
  let alert: Element | null = null;
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    alert = dialog!.querySelector("[role=alert]");
    if (alert?.textContent) break;
  }
  expect(alert, "inline 409 alert").toBeTruthy();
  return { dialog: dialog!, alert: alert! };
}

describe("APL-2735 deactivate dialog shows the 409 text", () => {
  let adminUser: Account;
  let leader: Account;
  const dealNames = [`ZZ-TEST Northwind ${RUN}`, `ZZ-TEST Contoso ${RUN}`];
  const dealIds: string[] = [];

  beforeAll(async () => {
    await startOffServer();
    const sa = await superAdmin();
    adminUser = await zzAccount("admin");
    leader = await zzAccount("deal leader");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    const pipes = await sa.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await sa.c.post("/api/orgs", { name: `ZZ-TEST Buyer UI ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    for (const name of dealNames) {
      const made = await sa.c.post("/api/deals", {
        name,
        organisationId: org.json.organisation.id,
        pipelineId: pipe!.id,
        leaderId: leader.id,
        whyPursue: "ZZ-TEST fit",
        nextStep: { title: `ZZ-TEST step ${RUN}`, dueDate: istDate(3) },
      });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      dealIds.push(made.json.deal.id as string);
      projectIds.push(made.json.deal.id as string);
    }
  }, 90_000);

  afterAll(async () => {
    closePage();
    killGroup(offPid);
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      if (who.id === sa.id) continue;
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  }, 60_000);

  it("a non-CRM caller sees the generic sentence and no deal name (qa:TC missing)", async () => {
    expect(offBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    try {
      await openTeam(offBase, adminUser);
      const { dialog, alert } = await deactivateDialog(leader.name);
      expect(alert.textContent).toBe(GENERIC);
      const shown = dialog.textContent ?? "";
      const html = dialog.innerHTML;
      for (const name of dealNames) expect(shown).not.toContain(name);
      for (const id of dealIds) {
        expect(html).not.toContain(id);
        expect(html).not.toContain(`/projects/${id}`);
      }
      expect(shown).not.toMatch(/\b2\b/);
      expect(dialog.querySelectorAll("a[href*='/projects/']")).toHaveLength(0);
    } finally {
      closePage();
    }
  }, 60_000);

  it("a CRM caller sees the named deals (qa:TC missing)", async () => {
    const base = process.env.TASKBOARD_URL ?? "http://localhost:3100";
    try {
      await openTeam(base, adminUser);
      const { dialog, alert } = await deactivateDialog(leader.name);
      const text = alert.textContent ?? "";
      expect(text.startsWith("Name a new Leader first for: ")).toBe(true);
      for (const name of dealNames) expect(text).toContain(name);
      const html = dialog.innerHTML;
      for (const id of dealIds) expect(html).toContain(`/projects/${id}/members`);
      for (const name of dealNames) expect(dialog.textContent).toContain(`${name}: Change leader`);
    } finally {
      closePage();
    }
  }, 60_000);
});
