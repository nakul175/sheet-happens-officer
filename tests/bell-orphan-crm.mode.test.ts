// SHO-2727: real HTTP/Prisma read-path qualification, synthetic loopback fixtures only.
// Orphan/missing-reference notifications cannot be produced by today's normal UI;
// these are explicit historical-row fixtures, not notification-generation coverage.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { HIDDEN_DEAL_TEXT } from "@/lib/feed";

const tag = `ZZ-TEST-2727-${Date.now()}-${process.pid}`;
const password = "synthetic-orphan-2727";
const servers: { mode: string; base: string; child: ChildProcess }[] = [];
const people: { id: string; email: string; role: "MEMBER" | "ADMIN" | "SUPER_ADMIN" }[] = [];
let workspaceId: string;
let plainId: string;
let dealId: string;

async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function request(base: string, cookie: string, route: string, method = "GET", body?: unknown) {
  return fetch(base + route, { method, headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
  expect(url.pathname).toMatch(/^\/sho_test(?:_[\w-]+)?$/);
  expect(existsSync(".next/BUILD_ID")).toBe(true);
  workspaceId = (await db.workspace.create({ data: { name: tag } })).id;
  const passwordHash = await hashPassword(password);
  for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"] as const) {
    const email = `nakul17+${tag.toLowerCase()}-${role.toLowerCase()}@aplyd.com`;
    const user = await db.user.create({ data: { workspaceId, name: `${tag} ${role}`, email, orgRole: role, passwordHash, emailVerifiedAt: new Date() } });
    people.push({ id: user.id, email, role });
  }
  for (const typeId of ["wst_project", "wst_deal"]) {
    const project = await db.project.create({ data: { workspaceId, name: `${tag} ${typeId}`, typeId,
      members: { create: { userId: people[0].id, role: "LEADER" } } } });
    if (typeId === "wst_project") plainId = project.id;
    else dealId = project.id;
  }
  for (const person of people) {
    await db.notification.createMany({ data: Array.from({ length: 55 }, (_, i) => ({
      recipientId: person.id, type: i % 3 === 0 ? "DEAL_STAGE_CHANGED" : i % 3 === 1 ? "TASKS_HANDED_OVER" : "TASK_ASSIGNED",
      projectId: i % 3 === 2 ? plainId : i % 2 ? null : `${tag}-purged`,
      data: i % 3 === 2 ? { title: "Ordinary readable task" } : { project: `${tag} private deal`, title: "Secret task", stage: "Secret stage", moved: 1 },
      createdAt: new Date(Date.now() - i * 1000),
    })) });
  }
  for (const mode of ["unset", "all", "admins", "off"]) {
    const p = await port();
    const base = `http://127.0.0.1:${p}`;
    const logs = mkdtempSync(path.join(tmpdir(), "sho-2727-mode-"));
    const fd = openSync(path.join(logs, "server.log"), "a", 0o600);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
      DATABASE_URL: process.env.DATABASE_URL, DIRECT_DATABASE_URL: process.env.DATABASE_URL,
      APP_URL: base, EMAIL_OUTBOX_DIR: logs, SEARCH_STAGE_A_ENABLED: "false", APLYD_ACCOUNTS_SSO: "false" };
    if (mode !== "unset") env.CRM_VISIBLE = mode;
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(p)], { env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    servers.push({ mode, base, child });
    let healthy = false;
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error(`Test server ${mode} exited`);
      try { if ((await request(base, "", "/api/health")).ok) { healthy = true; break; } } catch { /* bounded startup */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(healthy, `healthy ${mode}; diagnostics ${logs}`).toBe(true);
  }
}, 120000);

afterAll(async () => {
  try {
    // Only the exact isolated fixture ids are changed. Preserve evidence rows,
    // revoke sessions and make the test identities inactive; no schema/drop.
    if (people.length) {
      const ids = people.map((p) => p.id);
      await db.session.updateMany({ where: { userId: { in: ids } }, data: { revokedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: ids } }, data: { deactivatedAt: new Date() } });
      await db.project.updateMany({ where: { workspaceId }, data: { archivedAt: new Date() } });
      expect(await db.user.count({ where: { id: { in: ids }, deactivatedAt: null } })).toBe(0);
    }
  } finally {
    for (const server of servers) server.child.kill("SIGTERM");
    await Promise.all(servers.map(({ child }) => child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    })));
    await db.$disconnect();
  }
});

for (const mode of ["unset", "all", "admins", "off"]) {
  it(`SHO-2727 real ${mode}: orphan privacy, unread pagination, Activity and mark-read for all three roles`, async () => {
    const server = servers.find((s) => s.mode === mode)!;
    for (const person of people) {
      const signin = await request(server.base, "", "/api/auth/signin", "POST", { email: person.email, password });
      expect(signin.status).toBe(200);
      const cookie = signin.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("sho_session="))!;
      expect(cookie).toBeTruthy();
      const hidden = mode === "off" || (mode === "admins" && person.role === "MEMBER");
      const firstResponse = await request(server.base, cookie, "/api/notifications?filter=unread");
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first.items).toHaveLength(50);
      const secondResponse = await request(server.base, cookie, `/api/notifications?filter=unread&before=${encodeURIComponent(first.next)}`);
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json();
      expect(second.items).toHaveLength(5);
      expect(second.next).toBeNull();
      expect(first.unread).toBe(55);
      const items = [...first.items, ...second.items] as { id: string; text: string; href: string | null; read: boolean }[];
      expect(new Set(items.map((n) => n.id)).size).toBe(55);
      expect(items.every((n) => !n.read)).toBe(true);
      expect(items.filter((n) => n.text.includes("Ordinary readable task"))).toHaveLength(18);
      if (hidden) {
        expect(JSON.stringify(items)).not.toMatch(/private deal|Secret|purged/);
        expect(items.filter((n) => n.href === null)).toHaveLength(37);
        expect(items.some((n) => n.text === HIDDEN_DEAL_TEXT)).toBe(true);
      } else expect(JSON.stringify(items)).toContain("private deal");
      const activity = await request(server.base, cookie, `/api/projects/${dealId}/activity`);
      expect(activity.status).toBe(hidden ? 404 : 200);
      const changed = await request(server.base, cookie, `/api/notifications/${items[0].id}/read`, "POST", {});
      expect(changed.status).toBe(204);
      const remaining = await (await request(server.base, cookie, "/api/notifications?filter=unread")).json();
      expect(remaining.unread).toBe(54);
      expect(remaining.items.some((n: { id: string }) => n.id === items[0].id)).toBe(false);
      expect((await request(server.base, cookie, `/api/notifications/${items[0].id}/unread`, "POST", {})).status).toBe(204);
    }
  });
}

for (const width of [1280, 390]) {
  it(`SHO-2727 real browser ${width}px: non-link redaction, unread and Load older`, async () => {
    const server = servers.find((s) => s.mode === "off")!;
    const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const signin = await context.request.post(server.base + "/api/auth/signin", { data: { email: people[0].email, password } });
      expect(signin.status()).toBe(200);
      const page = await context.newPage();
      await page.goto(server.base + "/my-tasks");
      await page.getByRole("button", { name: "Notifications, 55 unread", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Notifications" });
      await dialog.getByRole("button", { name: "Unread · 55", exact: true }).click();
      await dialog.getByRole("button", { name: "Load older", exact: true }).click();
      await browserExpect(dialog.getByRole("button", { name: /^Mark as read:/ })).toHaveCount(55);
      expect(await dialog.getByRole("link", { name: /can't view/ }).count()).toBe(0);
      expect(await dialog.innerText()).not.toMatch(/private deal|Secret|purged/);
      expect(await dialog.getByRole("link", { name: /Ordinary readable task/ }).count()).toBe(18);
      expect(await dialog.getByRole("button", { name: "Load older", exact: true }).count()).toBe(0);
      if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `bell-${width}.png`), fullPage: true });
    } finally { await browser.close(); }
  });
}
