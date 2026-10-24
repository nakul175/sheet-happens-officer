// @vitest-environment jsdom
// SHO-3029. The AC is a COUNT being correct — the number the Team page's summary shows after a
// deactivation. tests/deactivate-fellback-2995.test.ts pins `moved` on the lib's return value; nothing
// pinned the sentence the user actually reads, so a wrong count could still ship carrying wording that
// hides it. Here the POST handler runs the REAL deactivate() (db, people and notify are faked; nothing is
// written anywhere), so the count under the assertion is the one the rule produced.
//
// The data is built to make the count distinguishable by NUMBER *and* by grammar:
//   visible plain project .... 1 task -> the caller may see it
//   hidden deal A ............ 2 tasks
//   hidden deal B ............ 1 task
// Correct:     "1 open task was handed over."      (singular)
// Leaked:      "4 open tasks were handed over."    (plural) — count AND wording both change.
// No server, no database. Names are ZZ-TEST.
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = { id: "zz-me-3029", name: "ZZ-TEST Me 3029", orgRole: "SUPER_ADMIN" as const };
const TARGET = { id: "zz-target-3029", name: "ZZ-TEST Target 3029", email: "nakul17+zz-3029-target@aplyd.com", orgRole: "MEMBER", status: "ACTIVE", leads: [] };
const NAMED = { id: "zz-named-3029", name: "ZZ-TEST Named 3029", email: "nakul17+zz-3029-named@aplyd.com", orgRole: "MEMBER", status: "ACTIVE", leads: [] };
const PLAIN = "ZZ-TEST Plain project 3029";
const DEAL_A = "ZZ-TEST Hidden deal A 3029";
const DEAL_B = "ZZ-TEST Hidden deal B 3029";

const PLAIN_ROW = { projectId: "zz-plain-3029", role: "EDITOR", project: { name: PLAIN, typeId: "wst_project" } };
const DEAL_A_ROW = { projectId: "zz-deal-a-3029", role: "EDITOR", project: { name: DEAL_A, typeId: "wst_deal" } };
const DEAL_B_ROW = { projectId: "zz-deal-b-3029", role: "EDITOR", project: { name: DEAL_B, typeId: "wst_deal" } };

// The page frame and role labels are not under test; the summary sentence is.
vi.mock("@/app/(app)/Shell", () => ({
  Page: (props: { children?: unknown }) => h("div", null, props.children as never),
  roleLabel: (role: string) => role,
  useMe: () => ME,
}));

const fake = vi.hoisted(() => {
  const tx = {
    projectMember: {
      findUnique: async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        fake.memberships.get(`${where.projectId_userId.projectId}:${where.projectId_userId.userId}`) ?? null,
    },
    user: { update: async () => ({}) },
    session: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    tx,
    db: {
      user: { findUnique: async ({ where }: { where: { id: string } }) => fake.users[where.id] ?? null },
      projectMember: { findMany: async () => fake.rows },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
    users: {} as Record<string, unknown>,
    rows: [] as unknown[],
    memberships: new Map<string, unknown>(),
    /** Tasks releasePerson finds per project — the only source of the count. */
    movedByProject: {} as Record<string, number>,
  };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/access", async (orig) => ({
  ...(await orig<typeof import("../src/lib/access")>()),
  leaderId: async () => "zz-leader-3029",
  // activeMember stays REAL: a named person who is not a Leader or Editor there falls back.
}));
vi.mock("@/lib/people", () => ({
  releasePerson: async (_tx: unknown, o: { projectId: string }) => ({ moved: fake.movedByProject[o.projectId] ?? 0 }),
}));
vi.mock("@/lib/notify", () => ({ auditTx: async () => {}, notify: async () => {} }));

const { default: Team } = await import("../src/app/(app)/team/Team");
const { deactivate } = await import("../src/lib/team");

const TARGET_USER = { id: TARGET.id, orgRole: "MEMBER", email: TARGET.email, deactivatedAt: null, emailVerifiedAt: new Date() };
const NAMED_USER = { id: NAMED.id, orgRole: "MEMBER", email: NAMED.email, deactivatedAt: null, emailVerifiedAt: new Date() };

let root: Root | null = null;
let called: { path: string; body: unknown } | null = null;
/** What the real rule answered, so the assertion can name the value and not just the sentence. */
let served: { moved: number; fellBack: string[] } | null = null;

beforeEach(() => {
  vi.stubEnv("CRM_VISIBLE", "off");
  document.body.innerHTML = '<div id="root"></div>';
  called = null;
  served = null;

  fake.users = { [TARGET_USER.id]: TARGET_USER, [NAMED_USER.id]: NAMED_USER };
  fake.rows = [PLAIN_ROW, DEAL_A_ROW, DEAL_B_ROW];
  // The named person is on none of the three, so every project falls back to its own Leader.
  fake.memberships = new Map();
  // 1 task the caller may see, 3 it may not: 1 vs 4, and singular vs plural.
  fake.movedByProject = { [PLAIN_ROW.projectId]: 1, [DEAL_A_ROW.projectId]: 2, [DEAL_B_ROW.projectId]: 1 };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/api/team") return json({ people: [ME, TARGET, NAMED] });
    if (path === `/api/team/${TARGET.id}/deactivate`) {
      called = { path, body: init?.body ? JSON.parse(String(init.body)) : null };
      // The real rule, not a canned number: the count the page renders comes from deactivate().
      served = await deactivate({ id: ME.id, orgRole: "ADMIN" }, TARGET.id, (called.body as { reassign: string }).reassign);
      return json(served);
    }
    return json({});
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const buttons = (label: string) => Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);
const dialog = () => document.querySelector('[role="dialog"]');
const dialogText = () => dialog()?.textContent ?? "";

async function deactivateThroughThePage() {
  await act(async () => {
    root = createRoot(document.getElementById("root")!);
    root.render(h(Team));
  });
  await act(async () => {}); // useGet's answer paints on the next tick
  await act(async () => {
    buttons("Deactivate")[0].click();
  });
  await act(async () => {
    buttons("Deactivate").find((b) => dialog()!.contains(b))!.click();
  });
}

describe("qa:TC missing SHO-3029 the count the summary shows", () => {
  it("qa:TC missing D1: the summary counts only the tasks the caller can see, and says '1 open task was'", async () => {
    await deactivateThroughThePage();

    // The default select is "The Leader of each project", so nothing falls back and `moved` is the only
    // field on the summary that could reveal the hidden deals. The rule: 1 visible task, not 1 + 2 + 1.
    expect(called?.body).toEqual({ reassign: "leaders" });
    expect(served).toEqual({ moved: 1, fellBack: [] });

    // What the user reads. Singular is the wording the UI owes a count of 1 (Team.tsx:114).
    expect(dialogText()).toContain(`${TARGET.name} is deactivated`);
    expect(dialogText()).toContain("1 open task was handed over.");
    // The leaked count would be 4, which also flips the wording to plural — assert both are absent,
    // so neither a wrong number nor a wrong number wearing the right grammar can pass.
    expect(dialogText()).not.toContain("open tasks were handed over");
    expect(dialogText()).not.toContain("4 open");
    expect(dialogText()).not.toContain("2 open");
    expect(dialogText()).not.toContain("3 open");
    // No hidden deal's name reaches the summary either. fellBack is empty on this path, so the
    // fallback hint must not render at all — an empty list would otherwise read "took the tasks in ,".
    expect(dialogText()).not.toContain(DEAL_A);
    expect(dialogText()).not.toContain(DEAL_B);
    expect(dialogText()).not.toContain("The Leader took the tasks in");
  });

  it("qa:TC missing D1: the count follows the releasePerson totals, so it is not a hard-coded one", async () => {
    // Same screen, different data: 3 visible tasks, 5 hidden. A canned "1" or a leaked total both fail.
    fake.movedByProject = { [PLAIN_ROW.projectId]: 3, [DEAL_A_ROW.projectId]: 5 };
    fake.rows = [PLAIN_ROW, DEAL_A_ROW];
    await deactivateThroughThePage();

    expect(served).toEqual({ moved: 3, fellBack: [] });
    expect(dialogText()).toContain("3 open tasks were handed over.");
    expect(dialogText()).not.toContain("8 open");
    expect(dialogText()).not.toContain("1 open task was");
  });
});
