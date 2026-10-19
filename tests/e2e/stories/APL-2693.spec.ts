// APL-2693: Assign without a person asks to whom (parent APL-2513 AC2).
// One test per acceptance criterion. Each turn is one short prompt to POST /api/concierge/messages.
// The harness (support, g2, jim-concierge) is the same one the other files in this directory use.
// Moved here from #55 (APL-2693 QA D6): its imports only resolve on qa/story-e2e.
// Only skip: a missing SHO_QA_PASS, as for every story spec in staging-e2e.yml. A missing admin or
// Member account, or a concierge that cannot take a model question, fails with the reason instead of
// skipping, so a run never passes with these checks left out.
import { test, expect, zz, login, hasMember } from "../support";
import { newProject, newTask, type Who } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, replyOf, taskOf } from "../helpers/jim-concierge";
import { conciergeLive, conciergeOff } from "../helpers/jim-gate";

test.describe.configure({ timeout: 150_000 });

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared QA password; story specs skip without it).");
  // Throws "Set SHO_ADMIN_EMAIL ..." (or _PASS) when the account the admin fixture signs in with is missing.
  login("ADMIN");
  // AC3 needs a second person. The member fixture would skip without one; fail instead.
  if (!hasMember()) throw new Error("Set SHO_MEMBER_EMAIL and SHO_MEMBER_PASS (a plain Member account), needed by AC3.");
});

/** The concierge must be on and able to take a model question. Fails with the reason rather than skipping. */
async function needModel(who: Who) {
  const c = await conciergeLive(who);
  expect(c.live, conciergeOff(c)).toBe(true);
  const s = await who.api.get("/api/concierge/state");
  const disabled = s.json.disabled as { code?: string; message?: string } | undefined;
  expect(disabled?.code, `The concierge cannot take a model question (${disabled?.code}: ${disabled?.message ?? "paused"}).`).toBeUndefined();
}

const asksToWhom = (text: string) => /\bwho(?:m)?\b/i.test(text) && /\bassign/i.test(text) && text.includes("?");

test.describe("qa:TC missing APL-2693", { tag: "@APL-2693" }, () => {
  test(
    '@APL-2693 qa:TC-APL2693-67ec712c@v1 AC1: Assign "<title>". ends as a question asking to whom',
    { tag: ["@APL-2693", "@AC1"] },
    async ({ admin, later }) => {
      await needModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-who" });
      const title = zz("ac1-unassigned-ask");
      await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const asked = await ask(admin, `Assign "${title}".`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      const reply = replyOf(asked.messages);
      expect(reply?.kind === "text" || reply?.kind === "choices", reply?.kind).toBe(true);
      expect(reply?.text.trim()).not.toBe("");
      expect(asksToWhom(reply?.text ?? "")).toBe(true);
    },
  );

  test(
    "@APL-2693 qa:TC-APL2693-e9f6715e@v1 AC2: no confirm card, and the assignee is unchanged",
    { tag: ["@APL-2693", "@AC2"] },
    async ({ admin, later }) => {
      await needModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-nocard" });
      const title = zz("ac2-nocard-ask");
      const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const asked = await ask(admin, `Assign "${title}".`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      expect(cardOf(asked.messages), "a missing person is not guessed").toBeFalsy();
      expect(asked.messages.some((m) => m.kind === "card" || m.card)).toBe(false);
      expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
    },
  );

  test(
    '@APL-2693 qa:TC-APL2693-cff94f8a@v1 AC3: Assign "<title>" to <member>. still returns a confirm card',
    { tag: ["@APL-2693", "@AC3"] },
    async ({ admin, member, later }) => {
      await needModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-named", members: [{ who: member, role: "EDITOR" }] });
      const title = zz("ac3-named-ask");
      const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const memberName = String(member.user.name);
      const asked = await ask(admin, `Assign "${title}" to ${memberName}.`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      const card = cardOf(asked.messages);
      expect(card?.status).toBe("PENDING");
      expect(card?.canConfirm).toBe(true);
      expect((card?.changes ?? []).map((c) => c.after ?? "").join(" ")).toContain(memberName);
      expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
    },
  );
});
