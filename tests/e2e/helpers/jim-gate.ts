// Is a PR's behaviour live on the staging build under test? A spec reads `(await prLive(...)).deployed` and the reason.
// What it does when the PR is not deployed is the spec's choice. The harness never calls test.skip.
// 1. /api/health answers { release: <git SHA> } (deploy/release.sh). If that is the PR's head commit, the PR is live.
// 2. Otherwise a probe looks for a behaviour only that PR has. A probe that ACTS (creates a ZZ-TEST project) cleans up through `later`.
// Each answer is worked out once per run and recorded on every test that asks, as a "deployed" annotation.
// conciergeLive and crmModeLive answer the same way for two server settings a spec may depend on: whether the concierge is
// switched on, and which CRM_VISIBLE mode staging was started with (the browser can read it but not change it).
import type { Page } from "@playwright/test";
import { test, expect, BASE_URL, zz } from "../support";
import { getTask, newProject, newTask, type Who } from "../g2";
import { cleanChat, deleteTask, newDeal, quickAction, raw } from "./jim-http";
import { bell, withUnread } from "./jim-bell";

type Later = (fn: () => Promise<unknown>) => void;
export type Gate = { pr: number; deployed: boolean; how: string };

/** Head commits of the open PRs these specs cover (GitHub, 18 Oct 2026). A later push to a PR falls through to the probe. */
const HEADS: Record<number, string> = {
  6: "07454a62a82d2aa91e4e6f68cdb2e44abdeddb5d",
  9: "87721120b9",
  10: "69c36318a8d7444f874b0c935a368834690e34f3",
  12: "72d2a3d88b",
  14: "40d0793d4b6418053241e1cbdc7fec448fa5825c",
  18: "cd09cf0832",
  19: "bc206f3734ad2f4db66dd41c132cf816219b0d83",
  21: "73f27cd720e6e3494eb011b3fb61115214bd10c0",
  23: "5d29c0f0e116d5ce0bc01dc098adbd52005a2be9",
  24: "72ee2713b4b52e8a636af5696006302b5548fcc8",
  // PR #32 (APL-2659). A later push falls through to the probe, same as the others.
  32: "947cbc9714b23915997ff34f409611206018c7f3",
  // PR #34 (APL-2519). A later push falls through to the probe.
  34: "983914450254dbca35ee6c3749444e7d9a2a3234",
  // PR #35 (APL-2641), stacked on #34. A later push falls through to the probe.
  35: "3b132d09a05cf525e9bd7c4f52e582dd30f8e0c7",
};

let releaseOnce: Promise<string | null> | null = null;
/** The git SHA the app under test (BASE_URL: staging or a pr1-pr8 preview) says it runs, or null when /api/health does not say. */
export function stagingRelease(who: Who) {
  releaseOnce ??= who.api.get(`${BASE_URL}/api/health`).then((r) => (typeof r.json.release === "string" && r.json.release ? r.json.release : null), () => null);
  return releaseOnce;
}

const REFUSED = "Only the project Leader or an Admin can do this.";

/** HTML, visible text and scripts from /usage, so a client-only heading can be recognised before the figures paint. */
async function servedUsage(page: Page) {
  const parts: Promise<string>[] = [];
  page.on("response", (r) => {
    const kind = r.request().resourceType();
    const type = r.headers()["content-type"] ?? "";
    if (kind === "script" || kind === "document" || type.includes("javascript") || type.includes("html")) parts.push(r.text().catch(() => ""));
  });
  await page.goto("/usage", { waitUntil: "load" });
  await page.waitForTimeout(1000); // a late client chunk has arrived by now
  return [await page.content(), await page.locator("body").innerText(), ...(await Promise.all(parts))].join("\n");
}

const PROBES: Record<number, (admin: Who, member: Who | null, later: Later) => Promise<Omit<Gate, "pr">>> = {
  // PR #18 (APL-2643): over 99 unread, the bell's name says the "99+" it paints. On main it says the raw total.
  // A client-only fix with no server signal, so this is the same check as that spec's over-99 test; the release check comes first.
  18: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      await withUnread(page, () => 120);
      await expect(bell(page)).toHaveAccessibleName(/ unread$/); // the count has rendered (bell-label.ts bellName)
      const name = await bell(page).getAttribute("aria-label");
      return { deployed: name === "Notifications, 99+ unread", how: `probe: bell at 120 unread is named "${name}"` };
    } finally { await page.close(); }
  },
  // PR #9 (APL-2640): an Editor's Undo of their own delete is refused like a restore from Trash. On main it restores.
  9: async (admin, member, later) => {
    if (!member) return { deployed: false, how: "probe needs the Member account (SHO_MEMBER_*)" };
    const p = await newProject(admin, later, { label: "gate pr9", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id);
    expect((await deleteTask(member, t)).status).toBe(204);
    // The action-log id from the Leader's Activity, so the probe works whether or not PR #14 hides the Editor's Undo id.
    const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { id: string; what: string }[];
    const row = items.find((i) => /to Trash/.test(i.what));
    if (!row) return { deployed: false, how: "probe found no delete row in Activity" };
    const u = await member.api.post(`/api/actions/${row.id}/undo`, {});
    return { deployed: u.status === 403 && u.json.error === REFUSED, how: `probe: Editor's Undo of own delete answered ${u.status}` };
  },
  // PR #14 (APL-2649): an Editor's delete comes back without an x-undo-id. On main it carries one.
  14: async (admin, member, later) => {
    if (!member) return { deployed: false, how: "probe needs the Member account (SHO_MEMBER_*)" };
    const p = await newProject(admin, later, { label: "gate pr14", members: [{ who: member, role: "EDITOR" }] });
    const del = await deleteTask(member, await newTask(admin, p.id));
    return { deployed: del.status === 204 && !del.undoId, how: `probe: Editor's delete answered ${del.status} ${del.undoId ? "with" : "without"} x-undo-id` };
  },
  // PR #10 (APL-2646): a Member's quick action scoped to a deal CRM_VISIBLE hides is the non-member 404
  // "Project not found", and the body does not name the deal. On main the label names the deal.
  // Under CRM_VISIBLE=all nothing is hidden, so the two builds answer alike and the probe cannot tell.
  10: async (admin, member, later) => {
    if (!member) return { deployed: false, how: "probe needs the Member account (SHO_MEMBER_*)" };
    const mode = await crmModeLive(admin, member);
    if (mode !== "admins") return { deployed: false, how: `probe needs CRM_VISIBLE=admins and staging runs ${mode}` };
    await cleanChat(member, later);
    const deal = await newDeal(admin, later, "gate pr10", [member]);
    const r = await quickAction(member, "due-week", deal.id);
    const hid = r.status === 404 && r.json.error === "Project not found" && !r.body.includes(deal.name);
    return { deployed: hid, how: `probe: a Member's quick action on a hidden deal answered ${r.status} ${hid ? "without" : "with"} the deal's name` };
  },
  // PR #12 (APL-2647): useGet returns `failed: !loading && ...`. A client-only fix, so the probe reads the JS staging serves
  // (no screen under test is involved), and falls back to the Person page, which drops its "Loading…" text in that PR.
  12: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      const js: Promise<string>[] = [];
      page.on("response", (r) => { if (r.request().resourceType() === "script") js.push(r.text().catch(() => "")); });
      await page.goto("/projects", { waitUntil: "networkidle" });
      if ((await Promise.all(js)).some((s) => /failed:!\w+\.loading/.test(s))) return { deployed: true, how: "probe: served JS has useGet's `failed` flag" };
      await page.route((u) => u.pathname === `/api/team/${admin.user.id}`, async (r) => { await new Promise((x) => setTimeout(x, 2000)); await r.continue(); });
      await page.goto(`/team/${admin.user.id}`, { waitUntil: "commit" });
      // Main shows the text "Loading…"; the PR shows the Skeleton, a role="status" box whose name is "Loading".
      const oldText = page.getByText("Loading…", { exact: true });
      const skeleton = page.getByRole("status").filter({ hasText: /^Loading$/ });
      await expect.poll(async () => (await oldText.count()) + (await skeleton.count()), { timeout: 10_000 }).toBeGreaterThan(0);
      const old = await oldText.count();
      return { deployed: old === 0 && (await skeleton.count()) > 0, how: `probe: slow Person page shows ${old ? "\"Loading…\"" : "the Skeleton"}` };
    } finally { await page.close(); }
  },
  // PR #6 (APL-2610, APL-2671): a manual reopen of a parent reopens the subtask that closed with it. On main it stays done.
  // A different path from the done-flag moves the APL-2610 spec asserts.
  6: async (admin, _member, later) => {
    const p = await newProject(admin, later, { label: "gate pr6" });
    const parent = await newTask(admin, p.id);
    const sub = await newTask(admin, p.id, { parentId: parent });
    expect((await admin.api.post(`/api/tasks/${parent}/complete`, { completeAll: true })).status).toBe(200);
    expect((await admin.api.post(`/api/tasks/${parent}/reopen`, {})).status).toBe(200);
    const open = !(await getTask(admin, sub)).completedAt;
    return { deployed: open, how: `probe: manual reopen of a parent left its cascaded subtask ${open ? "open" : "done"}` };
  },
  // PR #19 (APL-2686): Undo of "Organisation archived" clears archivedAt. On main it archives again and answers 409
  // ("This organisation is already archived."). The same branch reverses "Organisation unarchived"; one direction is enough to tell.
  // The organisation is a ZZ-TEST record and is archived again through `later`.
  19: async (admin, _member, later) => {
    const crm = await admin.api.get("/api/orgs");
    if (crm.status === 404) return { deployed: false, how: "probe needs the CRM and GET /api/orgs answered 404" };
    const made = await admin.api.post("/api/orgs", { name: zz("gate pr19") });
    expect(made.status, "probe creates an organisation").toBe(201);
    const id = made.json.organisation.id as string;
    later(() => admin.api.post(`/api/orgs/${id}/archive`, { archive: true }));
    const archived = await raw(admin, "POST", `/api/orgs/${id}/archive`, { archive: true });
    const undoId = archived.headers["x-undo-id"];
    if (archived.status !== 200 || archived.headers["x-undo-label"] !== "Organisation archived" || !undoId) {
      return { deployed: false, how: `probe: archive answered ${archived.status} ${archived.headers["x-undo-label"] ?? "without a label"}` };
    }
    const u = await admin.api.post(`/api/actions/${undoId}/undo`, { anyway: false });
    const org = (await admin.api.get(`/api/orgs/${id}`)).json.organisation as { archived?: boolean } | undefined;
    const cleared = u.status === 200 && org?.archived === false;
    return { deployed: cleared, how: `probe: Undo of Organisation archived answered ${u.status} and left the organisation ${org?.archived ? "archived" : "unarchived"}` };
  },
  // PR #21 (APL-2684): Include archived search returns an archived project to an Admin who is not a member.
  // main already skips the membership filter for isAdmin (the PR restates that in comments), so this probe reports the
  // behaviour live on main as well as on the PR. A build that still hides the project stays "not live".
  // The project is led by the Member, so the Super Admin has no seat, and it is archived through `later`.
  21: async (admin, member, later) => {
    if (!member) return { deployed: false, how: "probe needs the Member account (SHO_MEMBER_*)" };
    const p = await newProject(admin, later, { label: "gate pr21", leader: member, creator: member });
    expect((await member.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
    const found = await admin.api.get(`/api/search?q=${encodeURIComponent(p.name)}&archived=true`);
    const seen = ((found.json.projects ?? []) as { id: string }[]).some((x) => x.id === p.id);
    return { deployed: seen, how: `probe: Include archived ${seen ? "lists" : "hides"} an archived project the Super Admin is not a member of` };
  },
  // PR #23 (APL-2672): a Mark-as-read reload of All that lands after Unread is selected must not paint read rows.
  // On main that late page replaces the Unread list. Client only: the notifications API is answered in the browser,
  // so nothing is written on the server (same idea as the PR #18 probe).
  23: async (admin) => {
    const page = await admin.page.context().newPage();
    const hold = { release: () => {} };
    try {
      let armStale = false;
      let staleArmed = false;
      let staleSent = false;
      const staleHeld = new Promise<void>((resolve) => { hold.release = () => resolve(); });
      const now = new Date().toISOString();
      const unread = { id: "gate-u", text: "ZZ gate unread", href: "/projects", read: false, createdAt: now };
      const read = { id: "gate-r", text: "ZZ gate read", href: "/projects", read: true, createdAt: now };
      const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      await page.route((u) => u.pathname === "/api/notifications" || u.pathname.startsWith("/api/notifications/"), async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "POST") { armStale = true; await route.fulfill(json({})); return; }
        if (req.method() !== "GET" || url.pathname !== "/api/notifications") { await route.continue(); return; }
        if (url.searchParams.get("filter") === "unread") {
          await route.fulfill(json({ unread: 0, items: [], next: null }));
          return;
        }
        if (armStale) {
          armStale = false;
          staleArmed = true;
          await staleHeld;
          await route.fulfill(json({ unread: 0, items: [{ ...unread, read: true }, read], next: null }));
          staleSent = true;
          return;
        }
        await route.fulfill(json({ unread: 1, items: [unread, read], next: null }));
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      // A click on the bell before hydration is lost, and the panel stays shut, so the seeded
      // row never appears. The badge names "1 unread" only after the seeded list has been applied.
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications, 1 unread");
      await bell(page).click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      const markRead = panel.getByRole("button", { name: "Mark as read: ZZ gate unread" });
      await expect(markRead).toBeVisible();
      await markRead.click();
      await expect.poll(() => staleArmed).toBe(true); // the All reload is in flight; Unread has not been selected yet
      await panel.getByRole("button", { name: /^Unread/ }).click();
      await expect(panel.getByText("All caught up")).toBeVisible();
      hold.release();
      // The late All page has been delivered; two animation frames let a panel that still accepts it paint.
      await expect.poll(() => staleSent).toBe(true);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      // Every row of that late page is read, so any of its notices on the Unread tab is a read row.
      const readRows = (await panel.getByText(unread.text, { exact: true }).count()) + (await panel.getByText(read.text, { exact: true }).count());
      return { deployed: readRows === 0, how: `probe: a late All page left ${readRows} read row(s) on the Unread tab` };
    } finally { hold.release(); await page.close(); }
  },
  // PR #24 (APL-2673): phone inline-edit cells carry ic-gap and ic-hit, and app.css spaces them 8 px from each other and the tick.
  // A client-only fix. The probe reads the CSS and JS the page loads (no project is created). On main those class names are absent.
  24: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      const parts: Promise<string>[] = [];
      page.on("response", (r) => {
        const kind = r.request().resourceType();
        const type = r.headers()["content-type"] ?? "";
        if (kind === "stylesheet" || kind === "script" || type.includes("css") || type.includes("javascript")) parts.push(r.text().catch(() => ""));
      });
      await page.goto("/projects", { waitUntil: "load" });
      const blob = [await page.content(), ...(await Promise.all(parts))].join("\n");
      const hit = blob.includes("ic-gap") && blob.includes("ic-hit");
      return { deployed: hit, how: `probe: served CSS/JS ${hit ? "includes" : "lacks"} ic-gap and ic-hit` };
    } finally { await page.close(); }
  },
  // PR #34 (APL-2519): the Usage screen shows "Spend against the monthly ceiling". On main the Super Admin still
  // sees calls, tokens and cost, and that heading is not in the page or the script it loads. Client text, so the probe
  // reads what staging serves (no usage row is written).
  34: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      const blob = await servedUsage(page);
      const hit = blob.includes("Spend against the monthly ceiling");
      return { deployed: hit, how: `probe: Usage ${hit ? "includes" : "lacks"} spend against the monthly ceiling` };
    } finally { await page.close(); }
  },
  // PR #35 (APL-2641): the same screen also shows "Messages this month" and "Quick actions this month".
  // PR #34 has the ceiling block and not these two headings, so a build with only #34 stays "not live" here.
  35: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      const blob = await servedUsage(page);
      const hit = blob.includes("Messages this month") && blob.includes("Quick actions this month");
      return { deployed: hit, how: `probe: Usage ${hit ? "shows" : "does not show"} messages this month and quick-action counts` };
    } finally { await page.close(); }
  },
  // PR #32 (APL-2659): a quick action scoped to an archived project the person belongs to is "Project not found"
  // (myProjects leaves archived rows out) and the name is not in the answer. On main the membership lookup still
  // finds it and the label names it. PR #10 hides deals the CRM hides; it does not hide archived projects.
  // The chat is cleared afterwards when this probe was the one that filled it (cleanChat).
  32: async (admin, _member, later) => {
    await cleanChat(admin, later);
    const p = await newProject(admin, later, { label: "gate pr32" });
    expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status, "probe archives the project").toBe(200);
    const r = await quickAction(admin, "due-week", p.id);
    const hid = r.status === 404 && r.json.error === "Project not found" && !r.body.includes(p.name);
    return { deployed: hid, how: `probe: a quick action on an archived project answered ${r.status} ${hid ? "without" : "with"} its name` };
  },
};

const gates = new Map<number, Promise<Gate>>();

/**
 * Whether PR `pr` is live on staging. `member` may be null when the probe does not need it.
 * Records the answer and the release on the calling test, so a skipped run still says which build it looked at.
 */
export async function prLive(pr: keyof typeof HEADS, admin: Who, member: Who | null, later: Later): Promise<Gate> {
  if (!gates.has(pr)) {
    gates.set(pr, (async () => {
      const release = await stagingRelease(admin);
      if (release && release.startsWith(HEADS[pr])) return { pr, deployed: true, how: `release ${release.slice(0, 10)} is PR #${pr}'s head` };
      const probe = await PROBES[pr](admin, member, later);
      return { pr, ...probe, how: `release ${release ? release.slice(0, 10) : "not reported"}; ${probe.how}` };
    })());
  }
  const g = await gates.get(pr)!;
  test.info().annotations.push({ type: "deployed", description: `PR #${g.pr}: ${g.deployed ? "yes" : "no"} (${g.how})` });
  return g;
}

/** The skip reason for a gate that said no. */
export const notLive = (g: Gate, what: string) => `PR #${g.pr} is not live on this staging build (${g.how}); ${what}`;

export type Concierge = { live: boolean; how: string };
let conciergeOnce: Promise<Concierge> | null = null;

/**
 * Whether the concierge is switched on in the build under test: /api/concierge/state answers and does not say NOT_ENABLED.
 * A person's weekly cap or a provider outage still counts as on: quick actions answer without the model.
 */
export async function conciergeLive(who: Who): Promise<Concierge> {
  conciergeOnce ??= (async () => {
    const s = await who.api.get("/api/concierge/state");
    if (s.status !== 200) return { live: false, how: `GET /api/concierge/state answered ${s.status}` };
    const code = s.json.disabled?.code as string | undefined;
    if (code === "NOT_ENABLED") return { live: false, how: "the concierge state says NOT_ENABLED" };
    return { live: true, how: code ? `on, paused for this account (${code}); quick actions still answer` : "on" };
  })();
  const c = await conciergeOnce;
  test.info().annotations.push({ type: "concierge", description: `${c.live ? "on" : "off"} (${c.how})` });
  return c;
}

/** The skip reason for a concierge that is off. */
export const conciergeOff = (c: Concierge) => `The concierge is off on this staging build (${c.how}).`;

/** "all or admins" when there is no Member to tell them apart: the Admin sees deals in both. */
export type CrmLive = "all" | "admins" | "off" | "all or admins";
const modes = new Map<boolean, Promise<CrmLive>>();

/**
 * The CRM_VISIBLE mode staging runs, read from who may list deals: nobody under off, only Admins under admins, everyone under all.
 * A hidden CRM answers 404 (src/lib/crm.ts requireCrm).
 */
export async function crmModeLive(admin: Who, member: Who | null): Promise<CrmLive> {
  const key = !!member;
  if (!modes.has(key)) {
    modes.set(key, (async () => {
      const a = await admin.api.get("/api/deals");
      if (a.status === 404) return "off";
      expect(a.status, "the Admin's deal list").toBe(200);
      if (!member) return "all or admins";
      const m = await member.api.get("/api/deals");
      expect([200, 404], "the Member's deal list").toContain(m.status);
      return m.status === 404 ? "admins" : "all";
    })());
  }
  const mode = await modes.get(key)!;
  test.info().annotations.push({ type: "CRM_VISIBLE", description: mode });
  return mode;
}
