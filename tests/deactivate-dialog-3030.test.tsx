// @vitest-environment jsdom
// SHO-3030. The deactivate dialog (and the summary after it) must explain a fallback by the ROLE the named
// person does not hold, not by membership. src/lib/team.ts hands a project's tasks to the named person only
// when they are an active LEADER or EDITOR there (activeMember(tx, projectId, reassign, ["LEADER", "EDITOR"])),
// so a Viewer is on the project and still falls back (SHO-US-2.4 AC2).
//
// Unlike tests/deactivate-wording-3030.test.ts, this mounts the real Team screen and reads the dialog that
// the browser renders, so reverting the JSX to "is not on that project" turns it red. No server, no database:
// global fetch is stubbed and the shell is replaced. Names are ZZ-TEST.
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = { id: "zz-me-3030", name: "ZZ-TEST Me 3030", orgRole: "SUPER_ADMIN" as const };
const TARGET = { id: "zz-target-3030", name: "ZZ-TEST Target 3030", email: "nakul17+zz-3030-target@aplyd.com", orgRole: "MEMBER", status: "ACTIVE", leads: [] };
const NAMED = { id: "zz-named-3030", name: "ZZ-TEST Named 3030", email: "nakul17+zz-3030-named@aplyd.com", orgRole: "MEMBER", status: "ACTIVE", leads: [] };
const PLAIN = "ZZ-TEST Plain project 3030";

// The shell (page frame, role labels) is not under test; the dialog is.
vi.mock("@/app/(app)/Shell", () => ({
  Page: (props: { children?: unknown }) => h("div", null, props.children as never),
  roleLabel: (role: string) => role,
  useMe: () => ME,
}));

// --- The rule the copy describes. deactivate() is run with fakes: nothing is written anywhere. -------------
const fake = vi.hoisted(() => {
  const tx = {
    projectMember: { findUnique: async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) => fake.memberships.get(`${where.projectId_userId.projectId}:${where.projectId_userId.userId}`) ?? null },
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
  };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/access", async (orig) => ({
  ...(await orig<typeof import("../src/lib/access")>()),
  leaderId: async () => "zz-leader-3030",
  // activeMember stays REAL: it is the rule under test.
}));
vi.mock("@/lib/people", () => ({ releasePerson: async () => ({ moved: 1 }) }));
vi.mock("@/lib/notify", () => ({ auditTx: async () => {}, notify: async () => {} }));

const { default: Team } = await import("../src/app/(app)/team/Team");
const { deactivate } = await import("../src/lib/team");

let root: Root | null = null;
let posted: { path: string; body: unknown } | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  posted = null;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/team") {
      return new Response(JSON.stringify({ people: [ME, TARGET, NAMED] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === `/api/team/${TARGET.id}/deactivate`) {
      posted = { path, body: init?.body ? JSON.parse(String(init.body)) : null };
      return new Response(JSON.stringify({ moved: 1, fellBack: [PLAIN] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

const buttons = (label: string) => Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);
const dialog = () => document.querySelector('[role="dialog"]');
const dialogText = () => dialog()?.textContent ?? "";

async function mountTeam() {
  await act(async () => {
    root = createRoot(document.getElementById("root")!);
    root.render(h(Team));
  });
  await act(async () => {}); // useGet's answer paints on the next tick
  expect(dialogText()).not.toContain("Deactivate"); // nothing open yet
  expect(document.body.textContent).toContain(TARGET.name);
}

describe("qa:TC missing SHO-3030 the deactivate dialog names the role, not the membership", () => {
  it("qa:TC missing D1: the Deactivate dialog explains the fallback by role, and never says 'not on a project'", async () => {
    await mountTeam();
    await act(async () => {
      buttons("Deactivate")[0].click();
    });
    expect(dialogText()).toContain(`Deactivate ${TARGET.name}?`);
    expect(dialogText()).toMatch(/not a Leader or Editor on a project/);
    // The old copy ("If the person you name is not on a project, ...") is the defect SHO-3030 describes.
    expect(dialogText()).not.toMatch(/not on (a|that|those) projects?/);
  });

  it("qa:TC missing D1: the summary after deactivation names the role for the project that fell back", async () => {
    await mountTeam();
    await act(async () => {
      buttons("Deactivate")[0].click();
    });
    const select = dialog()!.querySelector("select")!;
    await act(async () => {
      select.value = NAMED.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      buttons("Deactivate").find((b) => dialog()!.contains(b))!.click();
    });
    expect(posted, "the dialog must POST the person chosen in the select").toEqual({ path: `/api/team/${TARGET.id}/deactivate`, body: { reassign: NAMED.id } });
    expect(dialogText()).toContain(`${TARGET.name} is deactivated`);
    expect(dialogText()).toContain(`The Leader took the tasks in ${PLAIN}`);
    expect(dialogText()).toMatch(/not a Leader or Editor on that project/);
    expect(dialogText()).not.toMatch(/not on (a|that|those) projects?/);
  });
});

describe("qa:TC missing SHO-3030 the fallback is about the role, not membership", () => {
  const ACTOR = { id: "zz-actor-3030", orgRole: "ADMIN" as const };
  const TARGET_USER = { id: TARGET.id, orgRole: "MEMBER", email: TARGET.email, deactivatedAt: null, emailVerifiedAt: new Date() };
  const NAMED_USER = { id: NAMED.id, orgRole: "MEMBER", email: NAMED.email, deactivatedAt: null, emailVerifiedAt: new Date() };
  const PROJECT = { projectId: "zz-alpha-3030", role: "EDITOR", project: { name: "ZZ-TEST Alpha 3030", typeId: "wst_project" } };

  function arrange(namedRole: "VIEWER" | "EDITOR") {
    fake.users = { [TARGET_USER.id]: TARGET_USER, [NAMED_USER.id]: NAMED_USER };
    fake.rows = [PROJECT];
    fake.memberships = new Map([[`${PROJECT.projectId}:${TARGET_USER.id}`, { ...PROJECT, userId: TARGET_USER.id, user: TARGET_USER }]]);
    fake.memberships.set(`${PROJECT.projectId}:${NAMED_USER.id}`, { ...PROJECT, userId: NAMED_USER.id, role: namedRole, user: NAMED_USER });
  }

  it("qa:TC missing D1: a named Viewer is ON the project and its tasks still go to the Leader", async () => {
    arrange("VIEWER");
    const res = await deactivate(ACTOR, TARGET_USER.id, NAMED_USER.id);
    expect(res.fellBack).toEqual([PROJECT.project.name]);
  });

  it("qa:TC missing D1: a named Editor keeps the tasks, so nothing falls back", async () => {
    arrange("EDITOR");
    const res = await deactivate(ACTOR, TARGET_USER.id, NAMED_USER.id);
    expect(res.fellBack).toEqual([]);
  });
});


// SHO-3030's AC is "the dialog text matches the agreed #156 wording". That wording lives in the review
// thread, not in this repository (the only #156 mentions here are comments), so it cannot be verified
// from the code and is not invented below. What IS verifiable is the shape of the copy: the trigger's
// hint and the confirmation's explanation make the same claim about the same person, and neither shows a
// placeholder, an interpolation artefact or a raw key.
describe("qa:TC missing SHO-3030 the copy is one claim shown twice, with nothing unrendered", () => {
  const UNRENDERED = [/\$\{/, /\{\{/, /\}\}/, /[{}]/, /\bundefined\b/, /\bNaN\b/, /\bnull\b/, /\b(team|deactivate|fallback)\.[a-zA-Z_]+/];

  it("qa:TC missing D1: the hint before confirming and the summary after agree, and no placeholder leaks", async () => {
    await mountTeam();
    await act(async () => {
      buttons("Deactivate")[0].click();
    });
    const trigger = dialogText();

    await act(async () => {
      const select = dialog()!.querySelector("select")!;
      select.value = NAMED.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      buttons("Deactivate").find((b) => dialog()!.contains(b))!.click();
    });
    const confirmation = dialogText();

    // One claim, twice: the same rule, stated about the same person, before and after.
    for (const text of [trigger, confirmation]) {
      expect(text).toMatch(/not a Leader or Editor/);
      expect(text).toMatch(/the person you name/);
      expect(text).not.toMatch(/\bnot on (a|that|those) projects?\b/);
    }
    // Both halves are complete sentences, not fragments glued to a missing name or a stub.
    expect(trigger).toContain("the person you name is not a Leader or Editor on a project, that project's Leader takes those tasks.");
    // "you name" before the act, "you named" after it: the same claim, the tense follows the moment.
    expect(confirmation).toContain(`${PLAIN}, because the person you named is not a Leader or Editor on that project.`);
    // Nothing left unrendered: no ${}, no braces, no undefined/NaN, no raw dotted key, no dangling "in ,".
    for (const text of [trigger, confirmation]) {
      for (const bad of UNRENDERED) expect(text, `unrendered ${bad} in: ${text}`).not.toMatch(bad);
      expect(text).not.toContain("in ,");
      expect(text).not.toContain("  ");
    }
  });
});
