// Is a PR's behaviour live on the staging build under test? Used as `test.skip(!(await prLive(...)).deployed, reason)` inside a test,
// so a spec runs whenever the PR is deployed and skips (with the reason in the report) when it is not.
// 1. /api/health answers { release: <git SHA> } (deploy/release.sh). If that is the PR's head commit, the PR is live.
// 2. Otherwise a probe looks for a behaviour only that PR has. A probe that ACTS (creates a ZZ-TEST project) cleans up through `later`.
// Each answer is worked out once per run and recorded on every test that asks, as a "deployed" annotation.
import { test, expect, BASE_URL } from "../support";
import { getTask, newProject, newTask, type Who } from "../g2";
import { deleteTask } from "./jim-http";
import { bell, withUnread } from "./jim-bell";

type Later = (fn: () => Promise<unknown>) => void;
export type Gate = { pr: number; deployed: boolean; how: string };

/** Head commits of the open PRs these specs cover (GitHub, 18 Oct 2026). A later push to a PR falls through to the probe. */
const HEADS: Record<number, string> = { 6: "13a836e8b6", 9: "87721120b9", 12: "72d2a3d88b", 14: "375e04c33c", 18: "cd09cf0832" };

let releaseOnce: Promise<string | null> | null = null;
/** The git SHA the app under test (BASE_URL: staging or a pr1-pr4 preview) says it runs, or null when /api/health does not say. */
export function stagingRelease(who: Who) {
  releaseOnce ??= who.api.get(`${BASE_URL}/api/health`).then((r) => (typeof r.json.release === "string" && r.json.release ? r.json.release : null), () => null);
  return releaseOnce;
}

const REFUSED = "Only the project Leader or an Admin can do this.";

const PROBES: Record<number, (admin: Who, member: Who | null, later: Later) => Promise<Omit<Gate, "pr">>> = {
  // PR #18 (APL-2643): over 99 unread, the bell's name says the "99+" it paints. On main it says the raw total.
  // A client-only fix with no server signal, so this is the same check as that spec's over-99 test; the release check comes first.
  18: async (admin) => {
    const page = await admin.page.context().newPage();
    try {
      await withUnread(page, () => 120);
      await bell(page).locator(".badge").waitFor(); // the count has rendered
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
      await page.waitForTimeout(900);
      const old = await page.locator("div.skel", { hasText: "Loading…" }).count();
      return { deployed: old === 0 && (await page.locator(".skel-wrap .skel-row").count()) > 0, how: `probe: slow Person page shows ${old ? "\"Loading…\"" : "the Skeleton"}` };
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
